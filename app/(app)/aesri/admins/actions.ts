"use server";

import { notFound } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/lib/db/client";
import { auditActor, requireActor } from "@/lib/auth/dal";
import { audit } from "@/lib/audit";
import { clearLoginId } from "@/lib/auth/throttle";
import { normalizeLoginId } from "@/lib/ids";
import { done, fail, type FormState } from "@/lib/forms";
import {
  AccountError,
  aesriLoginIdProblem,
  createAesriAdmin,
  issueSlips,
  setSignInEnabled,
  slipTargets,
  type IssuedCode,
  type SlipTarget,
} from "@/lib/services/accounts";
import { cleanText, str } from "@/lib/validation";
import { buildSlipBatch } from "@/components/access/slip-data";
import type { SlipActionData, SlipBatch } from "@/components/access/slip-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AESRI_ORG: SlipBatch["org"] = { name: "AESRI Campus Portal", nameHi: "एईएसआरआई कैंपस पोर्टल", kind: "aesri" };

/** Postgres "unique violation": someone else took the login ID at the same moment. */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 3; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
}

/**
 * Add an AESRI administrator: a pending account and its activation slip,
 * shown once. They activate with the slip, then set up an authenticator app.
 */
export async function addAdminAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(["super_admin"]);
  const loginId = str(formData, "loginId").toLowerCase();
  const name = cleanText(formData.get("name"), 100);
  const fields: Record<string, string> = {};
  const idProblem = loginId ? aesriLoginIdProblem(loginId) : "Choose a login ID, for example aesri.meena.";
  if (idProblem) fields.loginId = idProblem;
  if (!name || name.length < 2) fields.name = "Type the administrator’s full name.";
  else if (name.length > 80) fields.name = "Use at most 80 characters.";
  if (Object.keys(fields).length) return fail("Please check the highlighted boxes.", fields);

  const who = await auditActor(actor);
  const db = await getDb();
  let printed: { issued: IssuedCode[]; targets: SlipTarget[] };
  try {
    printed = await db.transaction(async (tx) => {
      const created = await createAesriAdmin(tx, { loginId, name: name! }, who);
      const targets = await slipTargets(tx, [created.accountId], null);
      const issued = await issueSlips(tx, [created.accountId], who);
      return { issued, targets };
    });
  } catch (err) {
    if (err instanceof AccountError) return fail("Please check the highlighted boxes.", { loginId: err.message });
    if (isUniqueViolation(err)) return fail("Please check the highlighted boxes.", { loginId: `The login ID ${loginId} is already in use. Choose another.` });
    throw err;
  }
  refresh();
  const batch = await buildSlipBatch(AESRI_ORG, printed.issued, printed.targets);
  return done(`Added ${name} as an AESRI administrator (${loginId}). Give them this slip: they activate their account with it, then set up an authenticator app.`, {
    batch,
  } satisfies SlipActionData);
}

/**
 * A row action on another AESRI administrator: "slip:<id>" prints a new slip
 * (resetting their password and authenticator), "off:<id>" / "on:<id>"
 * turns their sign-in off or on, "unlock:<id>" clears a lock after too many
 * wrong tries (wrong passwords, or wrong authenticator codes in a row —
 * that lock never ends by itself). Never one's own account; never the last
 * active administrator. Recorded in the activity log.
 */
export async function adminAccountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(["super_admin"]);
  const m = /^(slip|off|on|unlock):(.+)$/.exec(str(formData, "intent"));
  if (!m || !UUID.test(m[2])) return fail("Something went wrong with that request. Reload the page and try again.");
  const [, kind, accountId] = m;
  const who = await auditActor(actor);
  const db = await getDb();

  type Outcome =
    | { kind: "missing" }
    | { kind: "refused"; message: string }
    | { kind: "printed"; issued: IssuedCode[]; targets: SlipTarget[] }
    | { kind: "switched"; t: SlipTarget; changed: boolean; status: string }
    | { kind: "unlocked"; t: SlipTarget; wasLocked: boolean };
  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const [t] = await slipTargets(tx, [accountId], null);
      if (!t || t.role !== "super_admin") return { kind: "missing" };
      if (t.accountId === actor.accountId) {
        return { kind: "refused", message: "You can’t change your own account here. To change your password, open “Account” under your name." };
      }
      if (kind === "unlock") {
        if (t.status === "disabled") return { kind: "refused", message: `Sign-in is turned off for ${t.loginId}, so there is nothing to unlock.` };
        const locks = await clearLoginId(tx, normalizeLoginId(t.loginId));
        if (locks) await audit(tx, who, "account.unlocked", { schoolId: null, targetType: "account", targetId: t.accountId, details: { loginId: t.loginId } });
        return { kind: "unlocked", t, wasLocked: locks > 0 };
      }
      if (kind === "slip") {
        if (t.status === "disabled") return { kind: "refused", message: `Sign-in is turned off for ${t.loginId}. Turn it on first, then print a new slip.` };
        const issued = await issueSlips(tx, [t.accountId], who);
        return { kind: "printed", issued, targets: [t] };
      }
      const r = await setSignInEnabled(tx, t.accountId, kind === "on", who);
      return { kind: "switched", t, changed: r.changed, status: r.status };
    });
  } catch (err) {
    if (err instanceof AccountError) return fail(err.message);
    throw err;
  }
  if (outcome.kind === "missing") notFound();
  if (outcome.kind === "refused") return fail(outcome.message);
  refresh();
  if (outcome.kind === "printed") {
    const batch = await buildSlipBatch(AESRI_ORG, outcome.issued, outcome.targets);
    const t = outcome.targets[0];
    const reset = outcome.issued[0]?.purpose === "reset";
    return done(
      reset
        ? `New slip for ${t.person.name} (${t.loginId}). Their password and authenticator app have been reset and they have been signed out.`
        : `New slip for ${t.person.name} (${t.loginId}). Any earlier slip for them no longer works.`,
      { batch } satisfies SlipActionData,
    );
  }
  if (outcome.kind === "unlocked") {
    const whoText = `${outcome.t.person.name} (${outcome.t.loginId})`;
    return done(outcome.wasLocked ? `Unlocked ${whoText}. They can sign in again now.` : `${whoText} isn’t locked any more, so there was nothing to unlock.`);
  }
  const { t } = outcome;
  const whoText = `${t.person.name} (${t.loginId})`;
  if (!outcome.changed) return done(kind === "on" ? `Sign-in was already on for ${whoText}.` : `Sign-in was already off for ${whoText}.`);
  if (kind === "off") return done(`Sign-in turned off for ${whoText}. They have been signed out everywhere.`);
  return done(outcome.status === "active" ? `Sign-in turned on for ${whoText}. They can sign in again.` : `Sign-in turned on for ${whoText}. They haven’t activated yet, so print a new slip for them.`);
}
