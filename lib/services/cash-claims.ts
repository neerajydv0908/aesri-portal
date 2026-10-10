/**
 * Cash payments a family records on the portal ("I paid ₹5,000 in cash at
 * the school on 30 September").
 *
 * Recording one changes no money. It is a claim: the family sees it as
 * "waiting for approval", and the principal and office admins see it under
 * Fees → Cash to approve (with a red dot on Fees in the menu). They check it
 * against the cash the school received, then either
 *  - approve it: it becomes an ordinary cash payment with a receipt
 *    (recordPayment — the admission fee first when the family paid it, then
 *    tuition, oldest instalment first), and the family gets the usual "fee
 *    received" text message; or
 *  - decline it: the family gets a text message asking them to contact the
 *    school, and sees the reason (if one was given) on the portal.
 * The family can withdraw a record while it waits.
 *
 * What a family may record follows the rules for paying online
 * (familyPayable): the admission fee whole, tuition from ₹1,000 (or what is
 * left), never more than is due — counting the records already waiting, so
 * the same money can't be recorded twice.
 *
 * Every change is audited. Each locks the student row first, like any change
 * to a student's money, so a record can't be approved twice or approved and
 * withdrawn at the same moment.
 */
import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { accounts, cashClaims, classes, enrolments, paymentOrders, payments, sections, staff, students } from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { sectionLabel } from "@/lib/classes";
import { addDays, isValidIsoDate, todayIST } from "@/lib/dates";
import { queueCashDeclined, type SimpleSmsResult } from "@/lib/sms/outbox";
import {
  checkFamilyChoice,
  familyPayable,
  isAdmissionLine,
  isUuid,
  ledger,
  ledgerLinesFor,
  lockStudent,
  recordPayment,
  rupees,
  sessionDates,
  type ChoiceProblem,
  type FamilyChoice,
  type FamilyPayable,
  type PaymentMethod,
} from "./fees";

export const CASH_CLAIM_LIMITS = {
  /** "Given to the class teacher": what the family may add. */
  note: 120,
  /** Why the school declined it. */
  reason: 300,
  /** Records one child may have waiting at a time. */
  waiting: 3,
} as const;

/** How the receipt of an approved record says where the money was noted (the receipt shows both languages). */
export const FAMILY_CASH_REFERENCE = "Recorded by the family on the portal · परिवार ने पोर्टल पर दर्ज किया";

export type ClaimErrorCode = ChoiceProblem | "date" | "too_many" | "open_order" | "not_found" | "decided" | "too_much";

/** An expected problem with a recorded cash payment; `code` lets family pages say it in Hindi too. */
export class ClaimError extends Error {
  constructor(
    public code: ClaimErrorCode,
    message: string,
    /** For tuition_small / tuition_large: the tuition that may be recorded now (paise). */
    public limits?: { min: number; max: number },
  ) {
    super(message);
  }
}

function choiceProblem(problem: ChoiceProblem, p: FamilyPayable): ClaimError {
  const limits = p.tuition ? { min: p.tuition.min, max: p.tuition.max } : undefined;
  switch (problem) {
    case "nothing":
      return new ClaimError(problem, "Choose the admission fee or enter the amount of tuition you paid.");
    case "tuition_small":
      return new ClaimError(problem, `Record at least ${rupees(limits?.min ?? 0)} of tuition.`, limits);
    case "tuition_large":
      return new ClaimError(problem, `Only ${rupees(limits?.max ?? 0)} of tuition is left to pay this session.`, limits);
    default:
      return new ClaimError(problem, "Some of these fees are already paid, or a recorded payment for them is waiting for approval.");
  }
}

/* ------------------------------------------------------------------ */
/* The family                                                          */
/* ------------------------------------------------------------------ */

/** A second, identical record within this time is the same one sent twice (a double tap, a resent form). */
const REPEAT_WINDOW_MS = 2 * 60_000;

/**
 * The family records a cash payment. A second, identical record sent within
 * two minutes returns the first (`repeated`, so the page can say so) instead
 * of making another.
 */
export async function recordCashClaim(
  tx: Tx,
  input: { schoolId: string; studentId: string; sessionId: string; choice: FamilyChoice; paidOn: string; note: string | null },
  actor: AuditActor,
): Promise<{ id: string; amount: number; repeated: boolean }> {
  if (!actor.accountId) throw new ClaimError("not_found", "Sign in again to record a payment.");
  const today = todayIST();
  const session = await sessionDates(tx, input.sessionId);
  if (!isValidIsoDate(input.paidOn) || input.paidOn > today || (session && input.paidOn < session.startsOn)) {
    throw new ClaimError("date", "Enter the date you paid: today or an earlier day of this session.");
  }
  await lockStudent(tx, input.studentId, input.schoolId);

  // An online payment in progress could pay the same fees: finish or cancel it first.
  const [order] = await tx
    .select({ id: paymentOrders.id })
    .from(paymentOrders)
    .where(and(eq(paymentOrders.studentId, input.studentId), eq(paymentOrders.status, "created"), gte(paymentOrders.createdAt, new Date(Date.now() - 30 * 60_000))))
    .limit(1);
  if (order) throw new ClaimError("open_order", "An online payment is in progress. Finish it or cancel it first.");

  const waiting = await tx
    .select()
    .from(cashClaims)
    .where(and(eq(cashClaims.studentId, input.studentId), eq(cashClaims.sessionId, input.sessionId), eq(cashClaims.status, "pending")));
  const twin = waiting.find(
    (c) =>
      c.createdBy === actor.accountId &&
      c.paidOn === input.paidOn &&
      Date.now() - c.createdAt.getTime() < REPEAT_WINDOW_MS &&
      c.admissionAmount > 0 === input.choice.admission &&
      c.amount - c.admissionAmount === input.choice.tuition,
  );
  if (twin) return { id: twin.id, amount: twin.amount, repeated: true };
  if (waiting.length >= CASH_CLAIM_LIMITS.waiting) {
    throw new ClaimError("too_many", `${waiting.length} recorded payments are already waiting for the school's approval. Please wait until the school has looked at them.`);
  }

  const { lines } = await ledger(tx, input.studentId, input.sessionId);
  const payable = familyPayable(lines, waiting, today);
  const checked = checkFamilyChoice(payable, input.choice);
  if (!checked.ok) throw choiceProblem(checked.problem, payable);
  const note = input.note?.trim().slice(0, CASH_CLAIM_LIMITS.note) || null;
  const { amount, admissionAmount } = checked.value;
  const [row] = await tx
    .insert(cashClaims)
    .values({ schoolId: input.schoolId, studentId: input.studentId, sessionId: input.sessionId, amount, admissionAmount, paidOn: input.paidOn, note, createdBy: actor.accountId })
    .returning({ id: cashClaims.id });
  await audit(tx, actor, "fees.cash_claim_recorded", {
    schoolId: input.schoolId,
    targetType: "cash_claim",
    targetId: row.id,
    details: { studentId: input.studentId, amount, admissionAmount, paidOn: input.paidOn, ...(note ? { note } : {}) },
  });
  return { id: row.id, amount, repeated: false };
}

/** The family withdraws a record that is still waiting (say, typed by mistake). */
export async function withdrawCashClaim(tx: Tx, input: { claimId: string; studentId: string; schoolId: string }, actor: AuditActor): Promise<void> {
  if (!isUuid(input.claimId)) throw new ClaimError("not_found", "That recorded payment was not found.");
  await lockStudent(tx, input.studentId, input.schoolId);
  const [c] = await tx
    .select()
    .from(cashClaims)
    .where(and(eq(cashClaims.id, input.claimId), eq(cashClaims.studentId, input.studentId), eq(cashClaims.schoolId, input.schoolId)))
    .for("update");
  if (!c) throw new ClaimError("not_found", "That recorded payment was not found.");
  if (c.status === "withdrawn") return;
  if (c.status !== "pending") throw new ClaimError("decided", "The school has already looked at this payment, so it can't be removed.");
  await tx.update(cashClaims).set({ status: "withdrawn", decidedBy: actor.accountId, decidedAt: new Date() }).where(eq(cashClaims.id, c.id));
  await audit(tx, actor, "fees.cash_claim_withdrawn", {
    schoolId: input.schoolId,
    targetType: "cash_claim",
    targetId: c.id,
    details: { studentId: c.studentId, amount: c.amount, paidOn: c.paidOn },
  });
}

/* ------------------------------------------------------------------ */
/* The principal and office admins                                     */
/* ------------------------------------------------------------------ */

/** A waiting record of this school, with its student locked (null when there is none). */
async function lockClaim(tx: Tx, claimId: string, schoolId: string) {
  if (!isUuid(claimId)) throw new ClaimError("not_found", "That recorded payment was not found.");
  const [peek] = await tx
    .select({ studentId: cashClaims.studentId })
    .from(cashClaims)
    .where(and(eq(cashClaims.id, claimId), eq(cashClaims.schoolId, schoolId)));
  if (!peek) throw new ClaimError("not_found", "That recorded payment was not found.");
  // The student first, then the record — the same order as every other change to a student's money.
  const student = await lockStudent(tx, peek.studentId, schoolId);
  const [c] = await tx.select().from(cashClaims).where(eq(cashClaims.id, claimId)).for("update");
  if (!c) throw new ClaimError("not_found", "That recorded payment was not found.");
  if (c.status !== "pending") {
    const what = c.status === "approved" ? "approved" : c.status === "declined" ? "declined" : "withdrawn by the family";
    throw new ClaimError("decided", `This recorded payment was already ${what}.`);
  }
  return { claim: c, student };
}

/**
 * Approve a record: the money becomes a cash payment with a receipt dated
 * the day the family paid, paying the admission fee first when the family
 * paid it, then tuition, oldest first. Refused when it is more than is now
 * due (the same cash may already be on a receipt).
 */
export async function approveCashClaim(
  tx: Tx,
  input: { claimId: string; schoolId: string },
  actor: AuditActor,
): Promise<{ paymentId: string; receiptNo: string; amount: number; studentId: string; studentName: string }> {
  const { claim: c, student } = await lockClaim(tx, input.claimId, input.schoolId);
  const { lines } = await ledger(tx, c.studentId, c.sessionId);
  const open = lines.filter((l) => l.outstanding > 0);
  const due = open.reduce((a, l) => a + l.outstanding, 0);
  if (c.amount > due) {
    throw new ClaimError(
      "too_much",
      due > 0
        ? `Only ${rupees(due)} is due for ${student.name} now, less than the ${rupees(c.amount)} recorded. The same cash may already be on a receipt: check ${student.name}'s payments, then decline this record or record the right amount on the student's fees page.`
        : `Nothing is due for ${student.name} now, so the ${rupees(c.amount)} recorded can't be approved. The same cash may already be on a receipt: check ${student.name}'s payments, then decline this record.`,
    );
  }
  // The family said what the money was for: it must still fit each part, so it is never moved
  // from tuition onto the admission fee (or the other way) without anyone noticing.
  const admissionDue = open.filter(isAdmissionLine).reduce((a, l) => a + l.outstanding, 0);
  const tuitionDue = due - admissionDue;
  const tuitionClaimed = c.amount - c.admissionAmount;
  if ((c.admissionAmount > 0 && c.admissionAmount !== admissionDue) || tuitionClaimed > tuitionDue) {
    const parts = [
      c.admissionAmount > 0 ? `admission fee ${rupees(c.admissionAmount)} recorded, ${rupees(admissionDue)} due` : "",
      tuitionClaimed > 0 ? `tuition ${rupees(tuitionClaimed)} recorded, ${rupees(tuitionDue)} due` : "",
    ].filter(Boolean);
    throw new ClaimError(
      "too_much",
      `What was recorded no longer matches what is due for ${student.name} (${parts.join("; ")}). The same cash may already be on a receipt: check ${student.name}'s payments, then decline this record or record the right amount on the student's fees page.`,
    );
  }
  const preferred = [...(c.admissionAmount > 0 ? open.filter(isAdmissionLine) : []), ...open.filter((l) => !isAdmissionLine(l))].map((l) => l.id);
  const r = await recordPayment(
    tx,
    {
      schoolId: input.schoolId,
      studentId: c.studentId,
      sessionId: c.sessionId,
      amount: c.amount,
      method: "cash" satisfies PaymentMethod,
      reference: FAMILY_CASH_REFERENCE,
      paidOn: c.paidOn,
      chargeIds: preferred,
    },
    actor,
  );
  await tx.update(cashClaims).set({ status: "approved", decidedBy: actor.accountId, decidedAt: new Date(), paymentId: r.id }).where(eq(cashClaims.id, c.id));
  await audit(tx, actor, "fees.cash_claim_approved", {
    schoolId: input.schoolId,
    targetType: "cash_claim",
    targetId: c.id,
    details: { studentId: c.studentId, amount: c.amount, paidOn: c.paidOn, paymentId: r.id, receiptNo: r.receiptNo },
  });
  return { paymentId: r.id, receiptNo: r.receiptNo, amount: c.amount, studentId: c.studentId, studentName: student.name };
}

/** Decline a record: nothing is paid, and the family is asked by text message to contact the school. */
export async function declineCashClaim(
  tx: Tx,
  input: { claimId: string; schoolId: string; reason: string | null },
  actor: AuditActor,
): Promise<{ amount: number; studentId: string; studentName: string; sms: SimpleSmsResult }> {
  const { claim: c, student } = await lockClaim(tx, input.claimId, input.schoolId);
  const reason = input.reason?.trim().slice(0, CASH_CLAIM_LIMITS.reason) || null;
  await tx.update(cashClaims).set({ status: "declined", decidedBy: actor.accountId, decidedAt: new Date(), declineReason: reason }).where(eq(cashClaims.id, c.id));
  await audit(tx, actor, "fees.cash_claim_declined", {
    schoolId: input.schoolId,
    targetType: "cash_claim",
    targetId: c.id,
    details: { studentId: c.studentId, amount: c.amount, paidOn: c.paidOn, ...(reason ? { reason } : {}) },
  });
  const sms = await queueCashDeclined(tx, { schoolId: input.schoolId, claimId: c.id, studentId: c.studentId, amount: c.amount, createdBy: actor.accountId });
  return { amount: c.amount, studentId: c.studentId, studentName: student.name, sms };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** How many records are waiting for approval in a school (the red dot on Fees). */
export async function waitingClaimCount(tx: Tx, schoolId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<string>`count(*)`.mapWith(Number) })
    .from(cashClaims)
    .where(and(eq(cashClaims.schoolId, schoolId), eq(cashClaims.status, "pending")));
  return row?.n ?? 0;
}

export type ClaimRow = {
  id: string;
  studentId: string;
  studentName: string;
  srNo: string;
  /** "IV-A" in the record's session, or null. */
  section: string | null;
  sessionId: string;
  amount: number;
  admissionAmount: number;
  paidOn: string;
  note: string | null;
  status: "pending" | "approved" | "declined" | "withdrawn";
  createdAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  declineReason: string | null;
  paymentId: string | null;
  receiptNo: string | null;
  /** The approved record's receipt: "reversed" when the office cancelled it later. */
  receiptStatus: "completed" | "reversed" | null;
};

async function claimRows(tx: Tx, where: ReturnType<typeof and>, order: "oldest" | "newest", limit: number): Promise<ClaimRow[]> {
  const rows = await tx
    .select({
      id: cashClaims.id,
      studentId: cashClaims.studentId,
      studentName: students.name,
      srNo: students.srNo,
      className: classes.name,
      sectionName: sections.name,
      sessionId: cashClaims.sessionId,
      amount: cashClaims.amount,
      admissionAmount: cashClaims.admissionAmount,
      paidOn: cashClaims.paidOn,
      note: cashClaims.note,
      status: cashClaims.status,
      createdAt: cashClaims.createdAt,
      decidedAt: cashClaims.decidedAt,
      decidedBy: cashClaims.decidedBy,
      declineReason: cashClaims.declineReason,
      paymentId: cashClaims.paymentId,
      receiptNo: payments.receiptNo,
      receiptStatus: payments.status,
    })
    .from(cashClaims)
    .innerJoin(students, eq(students.id, cashClaims.studentId))
    .leftJoin(enrolments, and(eq(enrolments.studentId, cashClaims.studentId), eq(enrolments.sessionId, cashClaims.sessionId)))
    .leftJoin(sections, eq(sections.id, enrolments.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(payments, eq(payments.id, cashClaims.paymentId))
    .where(where)
    .orderBy(order === "oldest" ? asc(cashClaims.createdAt) : desc(cashClaims.decidedAt), desc(cashClaims.createdAt))
    .limit(limit);
  const deciders = [...new Set(rows.map((r) => r.decidedBy).filter((x): x is string => !!x))];
  const names = deciders.length
    ? await tx
        .select({ id: accounts.id, role: accounts.role, displayName: accounts.displayName, loginId: accounts.loginId, staffName: staff.name })
        .from(accounts)
        .leftJoin(staff, eq(staff.id, accounts.staffId))
        .where(inArray(accounts.id, deciders))
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n.role === "student" ? "The family" : (n.staffName ?? n.displayName ?? n.loginId)]));
  return rows.map(({ className, sectionName, decidedBy, ...r }) => ({
    ...r,
    section: className && sectionName ? sectionLabel(className, sectionName) : null,
    decidedByName: decidedBy ? (nameOf.get(decidedBy) ?? null) : null,
  }));
}

/** Records waiting for approval in a school, oldest first. */
export function waitingClaims(tx: Tx, schoolId: string, opts: { studentId?: string } = {}): Promise<ClaimRow[]> {
  return claimRows(tx, and(eq(cashClaims.schoolId, schoolId), eq(cashClaims.status, "pending"), opts.studentId ? eq(cashClaims.studentId, opts.studentId) : undefined), "oldest", 500);
}

/** Records the school approved or declined lately (the last 60 days), newest decision first. */
export function decidedClaims(tx: Tx, schoolId: string, limit = 30): Promise<ClaimRow[]> {
  return claimRows(
    tx,
    and(eq(cashClaims.schoolId, schoolId), inArray(cashClaims.status, ["approved", "declined"]), gte(cashClaims.decidedAt, new Date(Date.now() - 60 * 86_400_000))),
    "newest",
    limit,
  );
}

/**
 * What the family sees of their records: those waiting, those approved in
 * the last 30 days, and those declined in the last 60 (so a family that
 * seldom signs in still learns why). Waiting ones come first. Any session:
 * a record made just before the new session starts stays in sight (each
 * row says its session).
 */
export async function familyClaims(tx: Tx, studentId: string): Promise<ClaimRow[]> {
  const rows = await claimRows(tx, and(eq(cashClaims.studentId, studentId), inArray(cashClaims.status, ["pending", "approved", "declined"])), "newest", 40);
  const today = todayIST();
  const recent = (d: Date | null, days: number) => !!d && d.toISOString().slice(0, 10) >= addDays(today, -days);
  return rows
    .filter((r) => r.status === "pending" || recent(r.decidedAt, r.status === "declined" ? 60 : 30))
    .sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.createdAt.getTime() - a.createdAt.getTime());
}

/** A receipt shown beside a waiting record. */
export type NearbyReceipt = {
  id: string;
  receiptNo: string;
  amount: number;
  method: PaymentMethod;
  paidOn: string;
  status: "completed" | "reversed";
  /** The receipt of an earlier record the family made on the portal (approved). */
  fromFamilyRecord: boolean;
};

/** What the person deciding a waiting record should see beside it. */
export type ClaimCheck = {
  /** Still due now for the student, in the record's session, by kind of fee. */
  due: { admission: number; tuition: number };
  /**
   * The student's receipts from a week before the day the family says they
   * paid, or made after the record: the same cash may be on one of them.
   */
  receipts: NearbyReceipt[];
  /** How many of them are cash, cheque or bank receipts, not cancelled: one may be this same money. */
  cashReceipts: number;
};

/** How far before the family's payment date a receipt still counts as "close to it". */
const NEARBY_DAYS = 7;

/**
 * For the approval list and the student's fees page: what is due for each
 * waiting record now, and the receipts close to it — so the principal sees
 * when the same cash may already be on a receipt, or the fees changed since
 * the family recorded it.
 */
export async function claimChecks(tx: Tx, claims: ClaimRow[]): Promise<Map<string, ClaimCheck>> {
  const out = new Map<string, ClaimCheck>();
  if (!claims.length) return out;

  const due = new Map<string, { admission: number; tuition: number }>();
  const bySession = new Map<string, string[]>();
  for (const c of claims) bySession.set(c.sessionId, [...new Set([...(bySession.get(c.sessionId) ?? []), c.studentId])]);
  for (const [sessionId, ids] of bySession) {
    const lines = await ledgerLinesFor(tx, ids, sessionId);
    for (const id of ids) {
      const d = { admission: 0, tuition: 0 };
      for (const l of lines.get(id) ?? []) if (l.outstanding > 0) d[isAdmissionLine(l) ? "admission" : "tuition"] += l.outstanding;
      due.set(`${sessionId}:${id}`, d);
    }
  }

  const ids = [...new Set(claims.map((c) => c.studentId))];
  const fromDay = claims.map((c) => addDays(c.paidOn, -NEARBY_DAYS)).sort()[0];
  const since = new Date(Math.min(...claims.map((c) => c.createdAt.getTime())));
  const rows = await tx
    .select({
      id: payments.id,
      studentId: payments.studentId,
      receiptNo: payments.receiptNo,
      amount: payments.amount,
      method: payments.method,
      paidOn: payments.paidOn,
      status: payments.status,
      reference: payments.reference,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(and(inArray(payments.studentId, ids), or(gte(payments.paidOn, fromDay), gte(payments.createdAt, since))))
    .orderBy(desc(payments.paidOn), desc(payments.createdAt))
    .limit(ids.length * 40);

  for (const c of claims) {
    const from = addDays(c.paidOn, -NEARBY_DAYS);
    const receipts = rows
      .filter((r) => r.studentId === c.studentId && r.method !== "opening" && (r.paidOn >= from || r.createdAt >= c.createdAt))
      .slice(0, 8)
      .map((r) => ({
        id: r.id,
        receiptNo: r.receiptNo,
        amount: r.amount,
        method: r.method,
        paidOn: r.paidOn,
        status: r.status,
        fromFamilyRecord: r.reference === FAMILY_CASH_REFERENCE,
      }));
    out.set(c.id, {
      due: due.get(`${c.sessionId}:${c.studentId}`) ?? { admission: 0, tuition: 0 },
      receipts,
      cashReceipts: receipts.filter((r) => r.status === "completed" && r.method !== "online").length,
    });
  }
  return out;
}

/** Students among these with an online payment in progress (the last 30 minutes). */
export async function payingOnlineNow(tx: Tx, studentIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(studentIds)];
  if (!ids.length) return new Set();
  const rows = await tx
    .select({ studentId: paymentOrders.studentId })
    .from(paymentOrders)
    .where(and(inArray(paymentOrders.studentId, ids), eq(paymentOrders.status, "created"), gte(paymentOrders.createdAt, new Date(Date.now() - 30 * 60_000))));
  return new Set(rows.map((r) => r.studentId));
}
