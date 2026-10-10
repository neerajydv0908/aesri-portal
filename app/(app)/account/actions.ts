"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import { auditActor, requireActor } from "@/lib/auth/dal";
import { passwordProblem, verifyPassword } from "@/lib/auth/crypto";
import { clientIp, endAllSessions, replaceAllSessions, setSessionCookie } from "@/lib/auth/session";
import { attemptSucceeded, beginAttempt, clockTime } from "@/lib/auth/throttle";
import { rememberDevice } from "@/lib/auth/device";
import { forgetTrustedBrowser, forgetTrustedBrowsers } from "@/lib/auth/trusted";
import { dropThisBrowserTrust, thisBrowserTrustId } from "@/lib/auth/trusted-browser";
import { done, fail, type FormState } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { getLang } from "@/lib/i18n/server";
import { normalizeLoginId } from "@/lib/ids";
import { needsTwoFactor } from "@/lib/roles";
import { AccountError, otherSessionCount, setOwnPassword } from "@/lib/services/accounts";

/** Families read the portal in English or Hindi; staff screens are in English. */
async function translator(role: string) {
  return tr(role === "student" ? await getLang() : "en");
}

/** " 2 trusted browsers on other devices were forgotten too." (administrators only, so English.) */
function trustedForgottenNote(n: number): string {
  if (!n) return "";
  return ` ${n === 1 ? "1 trusted browser" : `${n} trusted browsers`} on other devices ${n === 1 ? "was" : "were"} forgotten too, so signing in there asks for the authenticator code again.`;
}

/**
 * Change one's own password: the current one must be right (wrong tries are
 * counted before the check: 5 per account and 30 per address in 15 minutes),
 * the new one must follow the password rules. Every session of the account
 * ends — this one too — and this browser gets a new session straight away
 * (same two-step state), so it stays signed in with a fresh token.
 */
export async function changePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  const t = await translator(actor.role);
  const loginId = normalizeLoginId(actor.loginId);
  const current = String(formData.get("currentPassword") ?? "");
  const next = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  const fields: Record<string, string> = {};
  if (!current) fields.currentPassword = t("Enter your current password.", "अपना वर्तमान पासवर्ड लिखें।");
  const problem = next ? passwordProblem(next, loginId) : "missing";
  const problems: Record<string, string> = {
    missing: t("Choose a new password.", "नया पासवर्ड चुनें।"),
    too_short: t("Use at least 8 characters.", "कम से कम 8 अक्षरों का पासवर्ड चुनें।"),
    too_long: t("That password is too long (128 characters at most).", "पासवर्ड बहुत लंबा है (अधिकतम 128 अक्षर)।"),
    contains_id: t("Don’t use your login ID inside your password.", "पासवर्ड में अपना लॉगिन आईडी न रखें।"),
    too_common: t("That password is too common and easy to guess. Try three random words.", "यह पासवर्ड बहुत आम है। तीन अलग-अलग शब्द जोड़कर देखें।"),
  };
  if (problem) fields.newPassword = problems[problem] ?? problems.too_short;
  else if (next === current) fields.newPassword = t("Choose a password that is different from your current one.", "वर्तमान पासवर्ड से अलग पासवर्ड चुनें।");
  if (next && !fields.newPassword && confirm !== next) {
    fields.confirmPassword = t("The two new passwords are different. Type the same password twice.", "दोनों नए पासवर्ड अलग हैं। एक ही पासवर्ड दो बार लिखें।");
  }
  if (Object.keys(fields).length) return fail(t("Please check the highlighted boxes.", "कृपया चिह्नित बॉक्स जाँचें।"), fields);

  const ip = await clientIp();
  const db = await getDb();
  // Counted before the check, so parallel tries can't get past the limit.
  const attempt = await beginAttempt(db, "password", loginId, ip);
  if (!attempt.ok) {
    // Password changes have only 15-minute limits, so there is always an end time.
    const at = clockTime(attempt.until ?? new Date(), actor.role === "student" ? await getLang() : "en");
    return fail(
      attempt.blocked === "address"
        ? t(`Too many wrong tries from this internet connection. Please try again after ${at}.`, `इस इंटरनेट कनेक्शन से बहुत अधिक गलत प्रयास हुए। कृपया ${at} के बाद फिर कोशिश करें।`)
        : t(`Too many wrong tries. Please try again after ${at}.`, `बहुत अधिक गलत प्रयास हुए। कृपया ${at} के बाद फिर कोशिश करें।`),
    );
  }
  const [acc] = await db.select({ passwordHash: accounts.passwordHash }).from(accounts).where(eq(accounts.id, actor.accountId));
  const who = await auditActor(actor);
  if (!(await verifyPassword(current.slice(0, 1024), current.length <= 1024 ? acc?.passwordHash : null))) {
    await audit(db, who, "account.password_change_failed", { schoolId: actor.schoolId, targetType: "account", targetId: actor.accountId });
    return fail(t("Your password was not changed.", "आपका पासवर्ड नहीं बदला।"), {
      currentPassword: t("That is not your current password. Check it and try again.", "यह आपका वर्तमान पासवर्ड नहीं है। जाँचकर फिर लिखें।"),
    });
  }

  // This browser stays trusted (if it was); trusted browsers elsewhere are forgotten (lib/auth/trusted.ts).
  const here = await thisBrowserTrustId(actor.accountId);
  let changed: { signedOut: number; trustedForgotten: number; token: string };
  try {
    changed = await db.transaction(async (tx) => {
      const n = await otherSessionCount(tx, actor.accountId, actor.sessionId);
      const trustedForgotten = await forgetTrustedBrowsers(tx, actor.accountId, { except: here });
      await setOwnPassword(tx, actor.accountId, next, who, { signedOutElsewhere: n, ...(trustedForgotten ? { trustedBrowsersForgotten: trustedForgotten } : {}) });
      // Every session ends, this one too; this browser carries on with a new token.
      const token = await replaceAllSessions(tx, actor.accountId, actor.role, actor.mfaPassed);
      return { signedOut: n, trustedForgotten, token };
    });
  } catch (err) {
    if (err instanceof AccountError) return fail(t(err.message, "आपका खाता सक्रिय नहीं है। कृपया फिर से साइन इन करें।"));
    throw err;
  }
  await setSessionCookie(changed.token, actor.role);
  await attemptSucceeded(db, attempt);
  // This browser stays a known device for the account with the new password.
  const [fresh] = await db.select({ id: accounts.id, passwordChangedAt: accounts.passwordChangedAt }).from(accounts).where(eq(accounts.id, actor.accountId));
  if (fresh) await rememberDevice(fresh);
  const signedOut = changed.signedOut;
  refresh();
  const elsewhere = signedOut
    ? t(
        ` You have been signed out on ${signedOut === 1 ? "1 other device" : `${signedOut} other devices`}.`,
        ` ${signedOut} अन्य ${signedOut === 1 ? "डिवाइस" : "डिवाइसों"} पर आपको साइन आउट कर दिया गया है।`,
      )
    : "";
  return done(
    t(`Your password has been changed. You stay signed in here.${elsewhere}`, `आपका पासवर्ड बदल दिया गया है। इस डिवाइस पर आप साइन इन रहेंगे।${elsewhere}`) +
      trustedForgottenNote(changed.trustedForgotten),
  );
}

/**
 * Sign out every other browser or device this account is signed in on, and
 * forget the account's trusted browsers there (this browser stays trusted).
 */
export async function signOutOthersAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const actor = await requireActor();
  const t = await translator(actor.role);
  const who = await auditActor(actor);
  const db = await getDb();
  const here = await thisBrowserTrustId(actor.accountId);
  const { n, trustedForgotten } = await db.transaction(async (tx) => {
    const count = await otherSessionCount(tx, actor.accountId, actor.sessionId);
    await endAllSessions(tx, actor.accountId, actor.sessionId);
    const forgotten = await forgetTrustedBrowsers(tx, actor.accountId, { except: here });
    await audit(tx, who, "account.signed_out_elsewhere", {
      schoolId: actor.schoolId,
      targetType: "account",
      targetId: actor.accountId,
      details: { sessions: count, ...(forgotten ? { trustedBrowsers: forgotten } : {}) },
    });
    return { n: count, trustedForgotten: forgotten };
  });
  refresh();
  const note = trustedForgottenNote(trustedForgotten);
  if (!n) return done(t(`You weren’t signed in anywhere else.${note} You stay signed in here.`, "आप कहीं और साइन इन नहीं थे। इस डिवाइस पर आप साइन इन रहेंगे।"));
  return done(
    t(
      `Signed out on ${n === 1 ? "1 other device" : `${n} other devices`}.${note} You stay signed in here.`,
      `${n} अन्य ${n === 1 ? "डिवाइस" : "डिवाइसों"} पर साइन आउट कर दिया गया। इस डिवाइस पर आप साइन इन रहेंगे।`,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Trusted browsers (administrators; lib/auth/trusted.ts)              */
/* ------------------------------------------------------------------ */

/** Forget one of one's own trusted browsers: signing in there asks for the authenticator code again. */
export async function forgetTrustedBrowserAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  if (!needsTwoFactor(actor.role)) redirect("/account");
  const id = String(formData.get("id") ?? "").slice(0, 64);
  const who = await auditActor(actor);
  const db = await getDb();
  // Only the person's own: another account's id (or one already gone) forgets nothing.
  const gone = await db.transaction(async (tx) => {
    const row = await forgetTrustedBrowser(tx, actor.accountId, id);
    if (row) {
      await audit(tx, who, "account.trusted_browsers_forgotten", {
        schoolId: actor.schoolId,
        targetType: "account",
        targetId: actor.accountId,
        details: { scope: "one", count: 1, browser: row.browser },
      });
    }
    return row;
  });
  if (gone && gone.id === (await thisBrowserTrustId(actor.accountId))) await dropThisBrowserTrust(actor.accountId);
  redirect("/account?done=browser_forgotten");
}

/** Forget every trusted browser of one's account, this one too. */
export async function forgetAllTrustedBrowsersAction(_formData: FormData): Promise<void> {
  const actor = await requireActor();
  if (!needsTwoFactor(actor.role)) redirect("/account");
  const who = await auditActor(actor);
  const db = await getDb();
  await db.transaction(async (tx) => {
    const count = await forgetTrustedBrowsers(tx, actor.accountId);
    if (count) {
      await audit(tx, who, "account.trusted_browsers_forgotten", { schoolId: actor.schoolId, targetType: "account", targetId: actor.accountId, details: { scope: "all", count } });
    }
  });
  await dropThisBrowserTrust(actor.accountId);
  redirect("/account?done=browsers_forgotten");
}
