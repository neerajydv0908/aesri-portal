"use server";

import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/auth/next-path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import { normalizeCode, passwordProblem, verifyPassword } from "@/lib/auth/crypto";
import { checkTotp } from "@/lib/auth/totp";
import { clientIp, endSession, markMfaPassed, readSession, startSession } from "@/lib/auth/session";
import { attemptNotCounted, attemptSucceeded, beginAttempt, clockTime, dayAndTime, type Attempt } from "@/lib/auth/throttle";
import { knownDevice, rememberDevice } from "@/lib/auth/device";
import { trustedBrowserHere, trustThisBrowser } from "@/lib/auth/trusted-browser";
import type { FormState } from "@/lib/forms";
import { displayLoginId, normalizeLoginId } from "@/lib/ids";
import { getLang } from "@/lib/i18n/server";
import { tr, type Lang } from "@/lib/i18n";
import { redeemCode } from "@/lib/services/accounts";
import { needsTwoFactor, type Role } from "@/lib/roles";

/**
 * What the sign-in forms get back: an error for the summary, errors per
 * field, and (in `data`) what to put back in the boxes when the page is
 * used without JavaScript. Passwords and one-time codes are never sent
 * back: with JavaScript the boxes simply keep what was typed.
 */
export type AuthKeep = { loginId?: string; privacy?: boolean; credentials?: boolean; trust?: boolean };

const isAdmin = (role: Role) => needsTwoFactor(role);

function safeNext(next: FormDataEntryValue | null): string {
  return safeNextPath(typeof next === "string" ? next : "");
}

const answer = (error: string, fields: Record<string, string> | undefined, keep: AuthKeep): FormState => ({ error, fields, data: keep });

/** The same words whether or not the login ID exists. */
function tooManyTries(blocked: Extract<Attempt, { ok: false }>, lang: Lang): string {
  const t = tr(lang);
  if (blocked.blocked === "codes" || !blocked.until) {
    // Two-step sign-in (administrators, in English): until someone unlocks it.
    return "Too many wrong codes in a row, so two-step sign-in is locked for this account. Ask an administrator to unlock it: the principal or office admin for an accountant, an AESRI administrator for a principal or office admin, another AESRI administrator for an AESRI administrator.";
  }
  // A known device's own daily limit ends up to a day later: say which day.
  const at = blocked.until.getTime() - Date.now() > 6 * 60 * 60_000 ? dayAndTime(blocked.until, lang) : clockTime(blocked.until, lang);
  if (blocked.blocked === "day") {
    // The daily cap: from a new phone or computer, one try every 10 minutes for the rest of the day.
    return t(
      `Too many wrong passwords for this login ID today. On a phone or computer that hasn't signed in with it before, it can now be tried only once every 10 minutes: please try again after ${at}. A phone or computer you have signed in with before still works, or ask the school office to unlock it.`,
      `इस लॉगिन आईडी के लिए आज बहुत अधिक गलत पासवर्ड डाले गए। जिस फ़ोन या कंप्यूटर से इससे पहले साइन इन नहीं हुआ है, उस पर अब हर 10 मिनट में केवल एक बार कोशिश की जा सकती है: कृपया ${at} के बाद फिर कोशिश करें। जिस फ़ोन या कंप्यूटर से आप पहले साइन इन कर चुके हैं, उस पर साइन इन हो जाएगा, या विद्यालय कार्यालय से इसे खुलवा लें।`,
    );
  }
  return blocked.blocked === "address"
    ? t(
        `Too many wrong tries from this internet connection. Please try again after ${at}.`,
        `इस इंटरनेट कनेक्शन से बहुत अधिक गलत प्रयास हुए। कृपया ${at} के बाद फिर कोशिश करें।`,
      )
    : t(
        `Too many wrong tries. Please try again after ${at}, or ask the school office for help.`,
        `बहुत अधिक गलत प्रयास हुए। कृपया ${at} के बाद फिर कोशिश करें, या विद्यालय कार्यालय से सहायता लें।`,
      );
}

/** A lock started with this wrong try: say so in the activity log (once, as it starts). */
async function auditLockStart(db: Awaited<ReturnType<typeof getDb>>, attempt: Extract<Attempt, { ok: true }>, acc: { id: string; schoolId: string | null; loginId: string } | undefined, ip: string) {
  if (!acc || !attempt.locksIfWrong.length) return;
  for (const reason of attempt.locksIfWrong) {
    await audit(db, { accountId: acc.id, loginId: displayLoginId(acc.loginId), ip }, "auth.locked", {
      schoolId: acc.schoolId,
      targetType: "account",
      targetId: acc.id,
      details: { loginId: displayLoginId(acc.loginId), reason },
    });
  }
}

function checkBoxes(t: (en: string, hi: string) => string): string {
  return t("Please check the highlighted boxes.", "कृपया चिह्नित बॉक्स जाँचें।");
}

/* ------------------------------------------------------------------ */
/* Sign in                                                             */
/* ------------------------------------------------------------------ */

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const lang = await getLang();
  const t = tr(lang);
  const rawId = String(formData.get("loginId") ?? "").slice(0, 100);
  const password = String(formData.get("password") ?? "");
  const loginId = normalizeLoginId(rawId);
  const keep: AuthKeep = { loginId: rawId };

  const fields: Record<string, string> = {};
  if (!loginId) fields.loginId = t("Enter your login ID.", "अपना लॉगिन आईडी लिखें।");
  if (!password) fields.password = t("Enter your password.", "अपना पासवर्ड लिखें।");
  if (Object.keys(fields).length) return answer(checkBoxes(t), fields, keep);

  const ip = await clientIp();
  const db = await getDb();
  const [acc] = await db.select().from(accounts).where(eq(accounts.loginId, loginId));
  // A phone or computer that has signed in to this account before tries on its own counter (lib/auth/device.ts).
  const device = acc ? await knownDevice(acc) : null;
  // Counted before the password is checked, so parallel tries can't get past the limit.
  const attempt = await beginAttempt(db, "signin", loginId, ip, { knownDevice: device });
  if (!attempt.ok) return answer(tooManyTries(attempt, lang), undefined, keep);

  // No account, or one that can't sign in: spend the same time, so the answer doesn't reveal it.
  const hash = acc?.status === "active" && password.length <= 1024 ? acc.passwordHash : null;
  const ok = await verifyPassword(password.slice(0, 1024), hash);
  if (!acc || !ok || acc.status !== "active") {
    if (acc) {
      const who = { accountId: acc.id, loginId: displayLoginId(acc.loginId), ip };
      if (acc.status === "active") await audit(db, who, "auth.login_failed", { schoolId: acc.schoolId });
      // Recorded apart from wrong passwords (the person is told the same thing).
      else await audit(db, who, "auth.login_refused", { schoolId: acc.schoolId, details: { reason: acc.status === "disabled" ? "turned_off" : "not_activated" } });
      await auditLockStart(db, attempt, acc, ip);
    }
    return answer(
      t(
        "The login ID or password is not right. First time here? Use “Activate your account” with the code on your slip.",
        "लॉगिन आईडी या पासवर्ड सही नहीं है। पहली बार? अपनी पर्ची के कोड से “खाता सक्रिय करें” चुनें।",
      ),
      undefined,
      { ...keep, credentials: true },
    );
  }

  await attemptSucceeded(db, attempt);
  await db.update(accounts).set({ lastLoginAt: new Date() }).where(eq(accounts.id, acc.id));
  const who = { accountId: acc.id, loginId: displayLoginId(acc.loginId), ip };
  await audit(db, who, "auth.login", { schoolId: acc.schoolId });
  const admin = isAdmin(acc.role);
  // A browser the administrator trusted after a right authenticator code (lib/auth/trusted.ts): the password is enough here.
  const trusted = admin && acc.totpEnabled ? await trustedBrowserHere(acc) : null;
  await startSession(acc.id, acc.role, !admin || !!trusted);
  if (trusted) {
    await audit(db, who, "auth.2fa_trusted_browser", {
      schoolId: acc.schoolId,
      details: { browser: trusted.browser, trustedAt: trusted.createdAt.toISOString(), until: trusted.expiresAt.toISOString() },
    });
  }
  // Administrators' browsers are remembered once the authenticator code is right too.
  else if (admin) redirect(acc.totpEnabled ? "/login/2fa" : "/setup-2fa");
  await rememberDevice(acc);
  redirect(safeNext(formData.get("next")));
}

/* ------------------------------------------------------------------ */
/* Activate with the code on a slip                                    */
/* ------------------------------------------------------------------ */

export async function activateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const lang = await getLang();
  const t = tr(lang);
  const rawId = String(formData.get("loginId") ?? "").slice(0, 100);
  const code = String(formData.get("code") ?? "").slice(0, 40);
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const privacy = formData.get("privacy") === "yes";
  const loginId = normalizeLoginId(rawId);
  const keep: AuthKeep = { loginId: rawId, privacy };

  const weak: Record<string, string> = {
    missing: t("Choose a password.", "एक पासवर्ड चुनें।"),
    too_short: t("Choose a password with at least 8 characters.", "कम से कम 8 अक्षरों का पासवर्ड चुनें।"),
    too_long: t("That password is too long (128 characters at most).", "पासवर्ड बहुत लंबा है (अधिकतम 128 अक्षर)।"),
    contains_id: t("Don't use your login ID inside your password.", "पासवर्ड में अपना लॉगिन आईडी न रखें।"),
    too_common: t("That password is too common and easy to guess. Try three random words.", "यह पासवर्ड बहुत आम है। तीन अलग-अलग शब्द जोड़कर देखें।"),
  };

  const fields: Record<string, string> = {};
  if (!loginId) fields.loginId = t("Enter the login ID from your slip.", "अपनी पर्ची से लॉगिन आईडी लिखें।");
  if (!normalizeCode(code)) fields.code = t("Enter the one-time code from your slip.", "अपनी पर्ची से एक-बार वाला कोड लिखें।");
  const problem = password ? passwordProblem(password, loginId) : "missing";
  if (problem) fields.password = weak[problem] ?? weak.too_short;
  else if (!confirm) fields.confirm = t("Type the same password again.", "वही पासवर्ड दोबारा लिखें।");
  else if (confirm !== password) fields.confirm = t("The two passwords are different. Type the same password twice.", "दोनों पासवर्ड अलग हैं। एक ही पासवर्ड दो बार लिखें।");
  if (!privacy) fields.privacy = t("Please tick the box to confirm you have read the notice.", "कृपया सूचना पढ़ने की पुष्टि के लिए बॉक्स पर टिक करें।");
  if (Object.keys(fields).length) return answer(checkBoxes(t), fields, keep);

  const ip = await clientIp();
  const db = await getDb();
  // Shares sign-in's 15-minute counters, but not the daily cap: a slip code can't be guessed.
  const attempt = await beginAttempt(db, "activate", loginId, ip);
  if (!attempt.ok) return answer(tooManyTries(attempt, lang), undefined, keep);

  const result = await db.transaction((tx) => redeemCode(tx, loginId, code, password, ip));
  if (!result.ok) {
    if (result.reason === "weak_password") {
      // The code was right, so this wasn't a guess.
      await attemptNotCounted(db, attempt);
      return answer(checkBoxes(t), { password: weak[result.problem ?? "too_short"] ?? weak.too_short }, keep);
    }
    const wrong = t(
      "That login ID and code don't match, or the code has expired or already been used. Check your slip, or ask the school office for a new one.",
      "लॉगिन आईडी और कोड मेल नहीं खाते, या कोड की अवधि समाप्त हो गई है या पहले ही उपयोग हो चुका है। अपनी पर्ची जाँचें या विद्यालय कार्यालय से नई पर्ची लें।",
    );
    return answer(wrong, { code: t("Check the login ID and this code against your slip.", "अपनी पर्ची से लॉगिन आईडी और यह कोड मिलाकर देखें।") }, keep);
  }

  await attemptSucceeded(db, attempt);
  const admin = isAdmin(result.role);
  await startSession(result.accountId, result.role, !admin);
  if (admin) redirect("/setup-2fa");
  const [fresh] = await db.select({ id: accounts.id, passwordChangedAt: accounts.passwordChangedAt }).from(accounts).where(eq(accounts.id, result.accountId));
  if (fresh) await rememberDevice(fresh);
  redirect("/home?welcome=1");
}

/* ------------------------------------------------------------------ */
/* Two-factor (administrators; these screens are in English)           */
/* ------------------------------------------------------------------ */

const SIX_DIGITS = "Enter the 6-digit code shown in your authenticator app, for example 123456.";

function codeOf(formData: FormData): string | null {
  const code = String(formData.get("code") ?? "").replace(/\s/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

/** "Trust this browser for 30 days" (ticked unless the person unticked it). */
const trustOf = (formData: FormData) => formData.get("trust") === "yes";

/** After a right code with the box ticked: trust this browser (lib/auth/trusted.ts), and say so in the activity log. */
async function trustAfterCode(db: Awaited<ReturnType<typeof getDb>>, account: { id: string; schoolId: string | null }, who: { accountId: string; loginId: string; ip: string }) {
  const row = await trustThisBrowser(account.id);
  if (!row) return;
  await audit(db, who, "auth.browser_trusted", {
    schoolId: account.schoolId,
    details: { browser: row.browser, until: row.expiresAt.toISOString() },
  });
}

export async function verifyTotpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const rec = await readSession();
  if (!rec) redirect("/login");
  if (!isAdmin(rec.account.role)) redirect("/home");
  if (rec.session.mfaPassed) redirect("/home");
  const keep: AuthKeep = { trust: trustOf(formData) };
  const code = codeOf(formData);
  if (!code) return answer("Please check the code.", { code: SIX_DIGITS }, keep);
  const ip = await clientIp();
  const db = await getDb();
  const who = { accountId: rec.account.id, loginId: displayLoginId(rec.account.loginId), ip };
  const attempt = await beginAttempt(db, "2fa", rec.account.loginId, ip);
  if (!attempt.ok) return answer(tooManyTries(attempt, "en"), undefined, keep);
  if (!(await checkTotp(rec.account.id, code))) {
    await audit(db, who, "auth.2fa_failed", { schoolId: rec.account.schoolId });
    await auditLockStart(db, attempt, rec.account, ip);
    return answer("That code isn't right.", { code: "Enter the code your authenticator app shows now. Each code works once." }, keep);
  }
  await attemptSucceeded(db, attempt);
  // A new session token now that the second step is done (the one from before stops working).
  if (!(await markMfaPassed(rec.session.id, rec.account.id, rec.account.role))) redirect("/login");
  await audit(db, who, "auth.2fa_passed", { schoolId: rec.account.schoolId });
  if (keep.trust) await trustAfterCode(db, rec.account, who);
  await rememberDevice(rec.account);
  redirect("/home");
}

export async function confirmTotpSetupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const rec = await readSession();
  if (!rec || !isAdmin(rec.account.role)) redirect("/login");
  if (rec.account.totpEnabled) redirect("/login/2fa");
  const keep: AuthKeep = { trust: trustOf(formData) };
  const code = codeOf(formData);
  if (!code) return answer("Please check the code.", { code: SIX_DIGITS }, keep);
  if (!(await checkTotp(rec.account.id, code))) {
    return answer("That code isn't right.", { code: "Make sure your phone's clock is correct, then enter the code the app shows now." }, keep);
  }
  const db = await getDb();
  const ip = await clientIp();
  const who = { accountId: rec.account.id, loginId: displayLoginId(rec.account.loginId), ip };
  await db.update(accounts).set({ totpEnabled: true }).where(eq(accounts.id, rec.account.id));
  if (!(await markMfaPassed(rec.session.id, rec.account.id, rec.account.role))) redirect("/login");
  await audit(db, who, "auth.2fa_enabled", { schoolId: rec.account.schoolId });
  if (keep.trust) await trustAfterCode(db, rec.account, who);
  await rememberDevice(rec.account);
  redirect("/home?secured=1");
}

/* ------------------------------------------------------------------ */
/* Sign out                                                            */
/* ------------------------------------------------------------------ */

export async function logoutAction(): Promise<void> {
  const rec = await readSession();
  if (rec) {
    const db = await getDb();
    await audit(db, { accountId: rec.account.id, loginId: displayLoginId(rec.account.loginId), ip: await clientIp() }, "auth.logout", { schoolId: rec.account.schoolId });
  }
  await endSession();
  redirect("/login?signedout=1");
}
