"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { auditActor } from "@/lib/auth/dal";
import { getDb } from "@/lib/db/client";
import { officePage } from "@/lib/page";
import { OFFICE_ROLES } from "@/lib/roles";
import { listSections, sectionStudents } from "@/lib/queries/school";
import { openingDone, openingProgress } from "@/lib/queries/home";
import { done, fail, type FormState } from "@/lib/forms";
import { cleanText, parseDate, str } from "@/lib/validation";
import { failKeeping } from "@/components/fees/remember";
import { addDays, todayIST } from "@/lib/dates";
import {
  isUuid,
  ledgerLinesFor,
  markNoOpeningBalances,
  OpeningError,
  parseRupees,
  PaymentError,
  recordOpeningBalances,
  rupees,
  sessionDates,
  type LedgerCharge,
  type OpeningEntry,
} from "@/lib/services/fees";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Opening balances mark fees as paid without money passing through the
 * portal, so only the principal and office admins (and AESRI administrators)
 * may record them — never the accounts role (lib/roles.ts OFFICE_ROLES).
 */

/**
 * Save a class's opening balances. Every box is checked first and every
 * problem is shown beside its box at once. Safe to submit again: lines
 * already paid are left alone.
 */
export async function saveOpeningAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, schoolId, sessionId } = await officePage(OFFICE_ROLES);
  const sectionId = str(formData, "section");
  const section = (await listSections(schoolId, sessionId)).find((s) => s.id === sectionId);
  if (!section) return fail("Choose a class of your school first.");

  const db = await getDb();
  const session = await sessionDates(db, sessionId);
  const fields: Record<string, string> = {};

  const paidOn = parseDate(str(formData, "paidOn"));
  if (!paidOn || paidOn === "invalid") fields.paidOn = "Enter the date to show on these receipts.";
  else if (paidOn > todayIST()) fields.paidOn = "The date can't be in the future.";
  else if (session && paidOn < addDays(session.startsOn, -120)) fields.paidOn = "That date is too early for this session. Check the year.";
  const reference = cleanText(formData.get("reference"), 80);

  // The fee lines of this class's students, as the form showed them.
  const students = await sectionStudents(section.id);
  const linesBy = await ledgerLinesFor(
    db,
    students.map((s) => s.id),
    sessionId,
  );
  const lineById = new Map<string, LedgerCharge>();
  for (const list of linesBy.values()) for (const l of list) lineById.set(l.id, l);

  let stale = false;
  const full = new Set<string>();
  for (const v of formData.getAll("full")) {
    if (typeof v !== "string") continue;
    if (!isUuid(v) || !lineById.has(v)) stale = true;
    else full.add(v);
  }
  const entries: OpeningEntry[] = [...full].map((chargeId) => ({ chargeId, paid: "full" as const }));
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string" || !key.startsWith("part:") || !value.trim()) continue;
    const chargeId = key.slice(5);
    const line = isUuid(chargeId) ? lineById.get(chargeId) : undefined;
    if (!line) {
      stale = true;
      continue;
    }
    const amount = parseRupees(value);
    if (!amount) fields[key] = "Enter the amount in rupees, for example 2500.";
    else if (full.has(chargeId)) {
      if (amount !== line.amount) fields[key] = "“Paid in full” is ticked too. Untick it, or clear this box.";
    } else if (amount > line.amount) fields[key] = `More than the ${rupees(line.amount)} fee. Type the total paid so far.`;
    else if (amount < line.paid) fields[key] = `${rupees(line.paid)} is already recorded. Type the total paid so far, or clear this box.`;
    else entries.push({ chargeId, paid: amount });
  }
  if (stale) {
    return failKeeping(formData, "The class list or its fees have changed since this page was opened. Reload the page, then enter the amounts again.");
  }
  const amountProblems = Object.keys(fields).filter((k) => k.startsWith("part:")).length;
  if (Object.keys(fields).length) {
    const top =
      amountProblems && fields.paidOn
        ? `Check the date and ${plural(amountProblems, "amount", "amounts")}: each problem is shown beside its box. Nothing was saved.`
        : amountProblems
          ? `${amountProblems === 1 ? "One amount needs" : `${amountProblems} amounts need`} checking: ${amountProblems === 1 ? "it is" : "each is"} marked in the table. Nothing was saved.`
          : fields.paidOn;
    return failKeeping(formData, top, fields);
  }
  if (!entries.length) return failKeeping(formData, "Tick “Paid in full” or enter an amount for at least one fee.");

  const who = await auditActor(actor);
  try {
    const r = await db.transaction((tx) =>
      recordOpeningBalances(tx, { schoolId, sessionId, paidOn: paidOn as string, reference, entries, section: { id: section.id, label: section.label } }, who),
    );
    refresh();
    const skipped = r.alreadyPaid ? ` ${r.alreadyPaid} ${r.alreadyPaid === 1 ? "fee was" : "fees were"} already recorded and left unchanged.` : "";
    if (!r.receipts.length) return done(`Nothing new to save.${skipped}`);
    return done(`Saved ${r.receipts.length} opening ${r.receipts.length === 1 ? "receipt" : "receipts"} for ${rupees(r.total)} in ${section.label}.${skipped}`);
  } catch (err) {
    if (err instanceof OpeningError) return failKeeping(formData, err.message, { [`part:${err.chargeId}`]: err.message });
    if (err instanceof PaymentError) return failKeeping(formData, err.message);
    throw err;
  }
}

/** Nobody in this class paid on paper: nothing to bring forward, so the class counts as done. */
export async function markNothingPaidAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, schoolId, sessionId } = await officePage(OFFICE_ROLES);
  const section = (await listSections(schoolId, sessionId)).find((s) => s.id === str(formData, "section"));
  if (!section) return fail("Choose a class of your school first.");
  if (openingDone(await openingProgress(schoolId, sessionId), section.id)) {
    refresh();
    return done(`${section.label} is already done. Nothing needed changing.`);
  }
  const db = await getDb();
  const who = await auditActor(actor);
  try {
    await db.transaction((tx) => markNoOpeningBalances(tx, { schoolId, sessionId, sectionId: section.id, sectionLabel: section.label }, who));
  } catch (err) {
    if (err instanceof PaymentError) return fail(err.message);
    throw err;
  }
  // The "Nobody paid on paper" box goes once the class is done, so the page confirms it instead.
  redirect(`/office/fees/opening?section=${section.id}&done=nothing-paid`);
}
