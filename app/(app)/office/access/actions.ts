"use server";

import { notFound } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/lib/db/client";
import { audit } from "@/lib/audit";
import { auditActor } from "@/lib/auth/dal";
import { clearLoginId } from "@/lib/auth/throttle";
import { done, fail, type FormState } from "@/lib/forms";
import { normalizeLoginId } from "@/lib/ids";
import { officePage, type OfficeContext } from "@/lib/page";
import { narrowPeople, slipQueue, staffAccessPeople, studentAccessPeople, type SlipQueue } from "@/lib/queries/access";
import { getSchool, listSections } from "@/lib/queries/school";
import {
  AccountError,
  issueSlips,
  setSignInEnabled,
  slipRefusal,
  slipTargets,
  unusedSlipCount,
  type IssuedCode,
  type SlipRefusal,
  type SlipTarget,
} from "@/lib/services/accounts";
import { batchCreated, getBatch } from "@/lib/services/import";
import { str } from "@/lib/validation";
import { buildSlipBatch } from "@/components/access/slip-data";
import { bulkKey, bulkNeedsConfirm, MAX_BULK_PRINT, sheetsFor, type BulkIntent, type SlipActionData } from "@/components/access/slip-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ticked rows: more than this in one go is almost certainly a mistake (and a very long print). */
const MAX_SLIPS = 300;

const BULK_INTENTS = ["section", "everyone-students", "everyone-staff", "import"] as const satisfies readonly BulkIntent[];
const isBulkIntent = (v: string): v is BulkIntent => (BULK_INTENTS as readonly string[]).includes(v);

const n = (x: number) => x.toLocaleString("en-IN");
const slipsText = (x: number) => (x === 1 ? "1 slip" : `${n(x)} slips`);

const SOMETHING_WRONG = "Something went wrong with that request. Reload the page and try again.";

/** "Arya7634", "Arya7634 and Arya7635", "Arya7634, Arya7635, Arya7636 and 4 more" */
function listIds(ids: string[]): string {
  const shown = ids.slice(0, 3);
  const rest = ids.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
}

function refusalMessage(refused: { t: SlipTarget; why: SlipRefusal }[]): string {
  const of = (why: SlipRefusal) => refused.filter((r) => r.why === why).map((r) => r.t.loginId);
  const own = of("own");
  if (own.length) return "You can’t print a slip for your own account here. To change your password, open “Account” under your name.";
  const adminOnly = of("admin_only");
  if (adminOnly.length) {
    return `Slips for the principal and office admins (${listIds(adminOnly)}) can only be printed by an AESRI administrator. Untick them and try again.`;
  }
  const off = of("turned_off");
  if (off.length) {
    return `Sign-in is turned off for ${listIds(off)}, so no slips were printed. Untick ${off.length === 1 ? "them" : "those people"}, or turn their sign-in on first.`;
  }
  const left = of("left");
  return `${listIds(left)} ${left.length === 1 ? "has" : "have"} left the school, so no slips were printed. Untick ${left.length === 1 ? "them" : "those people"} and try again.`;
}

type PrintOutcome =
  | { kind: "missing" }
  | { kind: "refused"; message: string }
  | { kind: "confirm"; resets: number; total: number }
  | { kind: "none" }
  | { kind: "printed"; issued: IssuedCode[]; targets: SlipTarget[]; replaced: number; skipped: number };

const ADMIN_ONLY_NOTE = " The principal’s and office admins’ slips are printed by an AESRI administrator.";

/** A print for many people, as it stands now: who, and the words for what happened. */
type WaitingList = {
  queue: SlipQueue;
  /** Nobody is waiting (said before anything is printed). */
  nobodyWaiting: string;
  /** Everybody activated between the list and the print (rare). */
  nobodyLeft: string;
  /** "for V-A", "for everyone not yet activated, in order of …" */
  printedFor: string;
};

/**
 * Who a print for many people covers at this moment (see slipQueue):
 * everyone waiting in a class, in the school (students, or staff), or
 * everyone a finished import of this session added. A message instead when
 * the class isn't this school's, or the import's list can't be used (an
 * import from before the list was kept, or from another session).
 */
async function waitingList(ctx: OfficeContext, intent: BulkIntent, formData: FormData): Promise<WaitingList | { error: string }> {
  if (intent === "section") {
    const sec = (await listSections(ctx.schoolId, ctx.sessionId)).find((s) => s.id === str(formData, "section"));
    if (!sec) return { error: "Choose a class first, then press the button again." };
    const people = narrowPeople(await studentAccessPeople(ctx.schoolId, ctx.sessionId), { sectionId: sec.id });
    return {
      queue: slipQueue(people, ctx.actor),
      nobodyWaiting: people.some((p) => p.current)
        ? `Everyone in ${sec.label} has already activated, so there are no slips to print.`
        : `There are no students in ${sec.label} yet, so there are no slips to print.`,
      nobodyLeft: `Everyone in ${sec.label} has activated in the meantime, so there are no slips to print.`,
      printedFor: `for ${sec.label}`,
    };
  }
  if (intent === "everyone-students") {
    const nobody = "Every current student has activated (or has their sign-in turned off), so there are no slips to print.";
    return {
      queue: slipQueue(await studentAccessPeople(ctx.schoolId, ctx.sessionId), ctx.actor),
      nobodyWaiting: nobody,
      nobodyLeft: nobody,
      printedFor: "for everyone not yet activated, in order of class, section and roll number",
    };
  }
  if (intent === "everyone-staff") {
    const queue = slipQueue(await staffAccessPeople(ctx.schoolId), ctx.actor);
    const nobody = `Every member of staff with portal access has activated, so there are no slips to print.${queue.adminOnly ? ADMIN_ONLY_NOTE : ""}`;
    return { queue, nobodyWaiting: nobody, nobodyLeft: nobody, printedFor: "for the staff not yet activated, in order of employee number" };
  }
  // Only this school's batches, and only people who are this school's records today.
  const batch = await getBatch(await getDb(), ctx.schoolId, str(formData, "batch"));
  if (!batch) notFound();
  const created = batch.sessionId === ctx.sessionId ? batchCreated(batch) : null;
  if (!created) return { error: "Slips for this import can’t be printed from here. Print them on Slips & sign-in instead, class by class." };
  const [students, staffList] = await Promise.all([studentAccessPeople(ctx.schoolId, ctx.sessionId), staffAccessPeople(ctx.schoolId)]);
  const studentIds = new Set(created.studentIds);
  const staffIds = new Set(created.staffIds);
  const queue = slipQueue([...staffList.filter((p) => staffIds.has(p.id)), ...students.filter((p) => studentIds.has(p.id))], ctx.actor);
  const nobody = `Everyone this import added has activated, so there are no slips to print.${queue.adminOnly ? ADMIN_ONLY_NOTE : ""}`;
  return {
    queue,
    nobodyWaiting: nobody,
    nobodyLeft: nobody,
    printedFor: "for everyone this import added who hasn’t activated yet: staff by employee number, then students by class, section and roll number",
  };
}

/**
 * Print slips: for the ticked accounts ("selected"); or for people still
 * waiting to activate — everyone in a class ("section"), everyone in the
 * school ("everyone-students", "everyone-staff") or everyone an Excel import
 * added ("import"), in the order class teachers hand them out.
 *
 * Ticked rows: asks for confirmation (and says how many) before resetting
 * any account that already has a password. Waiting people: nobody is ever
 * reset (anyone who activates meanwhile is left out); a long print, or one
 * that cancels slips that still work, is confirmed first with its number of
 * slips and sheets, and asked again if the list changed since.
 * The codes exist only in this action's result — never stored or logged.
 */
export async function printSlipsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const intent = str(formData, "intent");
  let ids: string[];
  /** Only people still waiting to activate: never reset anyone, leave out whoever changed meanwhile. */
  let waitingOnly = false;
  let printedFor = "";
  let nobodyLeft = "";
  // "everyone-students", or "everyone-students+new": only the people without a slip that still works.
  const [bulkIntent, only] = intent.split("+");
  if (isBulkIntent(bulkIntent) && (only === undefined || only === "new")) {
    const list = await waitingList(ctx, bulkIntent, formData);
    if ("error" in list) return fail(list.error);
    const total = list.queue.people.length;
    if (!total) return fail(list.nobodyWaiting);
    if (total > MAX_BULK_PRINT) {
      return fail(
        `That would be ${n(total)} slips, more than the ${n(MAX_BULK_PRINT)} that can be printed at once. ${bulkIntent === "everyone-staff" ? "Tick the people who need a slip instead." : "Print them class by class instead: choose a class on Slips & sign-in."}`,
      );
    }
    const replaced = list.queue.replaced;
    const seen = str(formData, "bulkSeen");
    const key = bulkKey(total, replaced);
    // Asked about (long, or cancelling working slips) and not confirmed for exactly these numbers: ask, with the numbers as they are now.
    if ((bulkNeedsConfirm(total, replaced) || only) && !(str(formData, "bulkConfirmed") === "1" && seen === key)) {
      const changed = seen !== "" && seen !== key;
      return {
        error: `${changed ? "The list has changed since this page was opened. " : ""}Print ${slipsText(total)} on ${n(sheetsFor(total))} A4 ${sheetsFor(total) === 1 ? "sheet" : "sheets"}? Confirm to print them.`,
        data: { bulk: { intent: bulkIntent, total, replaced, changed } } satisfies SlipActionData,
      };
    }
    const people = only ? list.queue.people.filter((p) => p.signIn!.slip.kind !== "valid") : list.queue.people;
    if (!people.length) return fail("Everyone on the list already has a slip that still works, so there are no new slips to print.");
    ids = people.map((p) => p.signIn!.accountId);
    waitingOnly = true;
    printedFor = ` ${list.printedFor}${only ? ", leaving out those who already had a slip that still works" : ""}`;
    nobodyLeft = list.nobodyLeft;
  } else if (intent === "selected") {
    ids = [...new Set(formData.getAll("accountId").filter((v): v is string => typeof v === "string" && UUID.test(v)))];
    if (!ids.length) return fail("Tick the people who need a slip in the table first, then press “Print slips for selected”.");
    if (ids.length > MAX_SLIPS) return fail(`You can print up to ${MAX_SLIPS} slips at a time. Choose a class, or tick fewer people.`);
  } else {
    return fail(SOMETHING_WRONG);
  }

  const confirmedResets = Number.parseInt(str(formData, "confirmReset"), 10) || 0;
  const school = await getSchool(ctx.schoolId);
  if (!school) notFound();
  const who = await auditActor(ctx.actor);
  const db = await getDb();

  let outcome: PrintOutcome;
  try {
    outcome = await db.transaction(async (tx): Promise<PrintOutcome> => {
      const locked = await slipTargets(tx, ids, ctx.sessionId);
      // An ID that isn't one of this school's accounts: say nothing about it.
      if (locked.length !== ids.length || locked.some((t) => t.schoolId !== ctx.schoolId || t.role === "super_admin")) return { kind: "missing" };
      let targets = locked;
      if (waitingOnly) {
        // Checked again now that the rows are locked: anyone who activated, left or was turned off a moment ago is left out.
        targets = locked.filter((t) => t.status === "pending" && !t.hasPassword && slipRefusal(ctx.actor, t) === null);
        if (!targets.length) return { kind: "none" };
      } else {
        const refused = locked.map((t) => ({ t, why: slipRefusal(ctx.actor, t) })).filter((r): r is { t: SlipTarget; why: SlipRefusal } => r.why !== null);
        if (refused.length) return { kind: "refused", message: refusalMessage(refused) };
        const resets = locked.filter((t) => t.hasPassword).length;
        if (resets > confirmedResets) return { kind: "confirm", resets, total: locked.length };
      }
      const replaced = await unusedSlipCount(
        tx,
        targets.map((t) => t.accountId),
      );
      const issued = await issueSlips(
        tx,
        targets.map((t) => t.accountId),
        who,
      );
      return { kind: "printed", issued, targets, replaced, skipped: locked.length - targets.length };
    });
  } catch (err) {
    if (err instanceof AccountError) return fail(err.message);
    throw err;
  }

  if (outcome.kind === "missing") notFound();
  if (outcome.kind === "refused") return fail(outcome.message);
  if (outcome.kind === "none") return fail(nobodyLeft);
  if (outcome.kind === "confirm") {
    const { resets, total } = outcome;
    return {
      error: `${resets === total ? (total === 1 ? "This person has" : `All ${total} people have`) : `${resets} of the ${total} people ${resets === 1 ? "has" : "have"}`} already activated. Confirm to reset ${resets === 1 ? "their password" : "their passwords"} and print the slips.`,
      data: { confirm: { resets, total } } satisfies SlipActionData,
    };
  }

  refresh();
  const batch = await buildSlipBatch({ name: school.name, nameHi: school.nameHi, kind: "school" }, outcome.issued, outcome.targets);
  const count = batch.slips.length;
  const resets = outcome.issued.filter((c) => c.purpose === "reset").length;
  const parts = [`Printed ${slipsText(count)}${printedFor}.`];
  if (outcome.skipped) {
    parts.push(`${outcome.skipped === 1 ? "1 person was" : `${n(outcome.skipped)} people were`} left out because they activated, or their sign-in changed, a moment ago.`);
  }
  if (resets) parts.push(`${resets === 1 ? "1 password was" : `${resets} passwords were`} reset: ${resets === 1 ? "that person has" : "those people have"} been signed out and must use the new slip.`);
  if (outcome.replaced) parts.push(`${outcome.replaced === 1 ? "1 earlier slip" : `${n(outcome.replaced)} earlier slips`} that hadn’t been used no longer ${outcome.replaced === 1 ? "works" : "work"}.`);
  return done(parts.join(" "), { batch } satisfies SlipActionData);
}

/**
 * A row action on Slips & sign-in; the button's value says which:
 *   "off:<account id>" / "on:<account id>": turn a family's sign-in off or on
 *     (student accounts only; staff sign-in follows their portal access on the staff page);
 *   "unlock:<account id>": clear the counters after too many wrong tries, so the
 *     person can try again at once (see unlockSignIn).
 */
export async function signInSwitchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const m = /^(on|off|unlock):(.+)$/.exec(str(formData, "switch"));
  if (!m || !UUID.test(m[2])) return fail(SOMETHING_WRONG);
  if (m[1] === "unlock") return unlockSignIn(ctx, m[2]);
  const turnOn = m[1] === "on";
  const accountId = m[2];
  const who = await auditActor(ctx.actor);
  const db = await getDb();

  type SwitchOutcome = { kind: "missing" } | { kind: "refused"; message: string } | { kind: "done"; t: SlipTarget; changed: boolean; status: string };
  let outcome: SwitchOutcome;
  try {
    outcome = await db.transaction(async (tx): Promise<SwitchOutcome> => {
      const [t] = await slipTargets(tx, [accountId], ctx.sessionId);
      if (!t || t.schoolId !== ctx.schoolId || t.role === "super_admin") return { kind: "missing" };
      if (t.person.kind !== "student") {
        return { kind: "refused", message: "A staff member’s sign-in follows their portal access. Change it on their staff page." };
      }
      if (turnOn && !t.person.active) {
        return {
          kind: "refused",
          message: `${t.person.name} has left the school, so their sign-in stays off. If they have come back, change their status on their student page first.`,
        };
      }
      const r = await setSignInEnabled(tx, t.accountId, turnOn, who);
      return { kind: "done", t, changed: r.changed, status: r.status };
    });
  } catch (err) {
    if (err instanceof AccountError) return fail(err.message);
    throw err;
  }
  if (outcome.kind === "missing") notFound();
  if (outcome.kind === "refused") return fail(outcome.message);

  const { t } = outcome;
  const who2 = `${t.person.name} (${t.loginId})`;
  refresh();
  if (!outcome.changed) return done(turnOn ? `Sign-in was already on for ${who2}.` : `Sign-in was already off for ${who2}.`);
  if (!turnOn) return done(`Sign-in turned off for ${who2}. They have been signed out, and can’t sign in or use a slip until you turn it on again.`);
  return done(
    outcome.status === "active"
      ? `Sign-in turned on for ${who2}. They can sign in with their password again.`
      : `Sign-in turned on for ${who2}. They haven’t activated yet, so print a slip for them.`,
  );
}

/**
 * "Unlock": after too many wrong tries (5 from one connection, or 20 from
 * anywhere, in 15 minutes) a login ID can't be used until the 15 minutes
 * are up; after 100 wrong passwords in a day, devices that never signed in
 * to it get one try every 10 minutes until the day is over (devices that
 * did sign in before work as usual); after 20 wrong authenticator
 * codes in a row two-step sign-in stays locked (lib/auth/throttle.ts). The
 * office may clear all of that at once for the people it may print slips
 * for (same rules: this school's families, teachers and accountants; the
 * principal's and office admins' only by an AESRI administrator; never
 * one's own). Recorded in the activity log.
 */
async function unlockSignIn(ctx: OfficeContext, accountId: string): Promise<FormState> {
  const who = await auditActor(ctx.actor);
  const db = await getDb();
  type UnlockOutcome = { kind: "missing" } | { kind: "refused"; message: string } | { kind: "done"; t: SlipTarget; wasLocked: boolean };
  const outcome = await db.transaction(async (tx): Promise<UnlockOutcome> => {
    const [t] = await slipTargets(tx, [accountId], ctx.sessionId);
    if (!t || t.schoolId !== ctx.schoolId || t.role === "super_admin") return { kind: "missing" };
    const why = slipRefusal(ctx.actor, t);
    if (why === "own") return { kind: "refused", message: "You can’t unlock your own account here." };
    if (why === "admin_only") {
      return { kind: "refused", message: `Only an AESRI administrator can unlock the sign-in of the principal and office admins (${t.loginId}).` };
    }
    if (why === "turned_off") return { kind: "refused", message: `Sign-in is turned off for ${t.loginId}, so there is nothing to unlock.` };
    if (why === "left") return { kind: "refused", message: `${t.person.name} has left the school, so their sign-in stays off.` };
    const locks = await clearLoginId(tx, normalizeLoginId(t.loginId));
    if (locks) {
      await audit(tx, who, "account.unlocked", { schoolId: t.schoolId, targetType: "account", targetId: t.accountId, details: { loginId: t.loginId } });
    }
    return { kind: "done", t, wasLocked: locks > 0 };
  });
  if (outcome.kind === "missing") notFound();
  if (outcome.kind === "refused") return fail(outcome.message);
  const who2 = `${outcome.t.person.name} (${outcome.t.loginId})`;
  refresh();
  if (!outcome.wasLocked) return done(`${who2} isn’t locked any more, so there was nothing to unlock. They can sign in now.`);
  return done(`Unlocked ${who2}. They can try to sign in again now.`);
}
