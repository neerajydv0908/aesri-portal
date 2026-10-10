/**
 * Refunds: money given back on a payment.
 *
 *   - Online payments are refunded in the Razorpay Dashboard. The portal then
 *     records each refund Razorpay has processed — by itself when Razorpay's
 *     webhook says so (refund.processed), or when the principal or office
 *     admin presses "Record refunds made in Razorpay" — taking the amount and
 *     date from Razorpay, once per Razorpay refund. An online refund can't be
 *     typed in by hand.
 *   - Payments taken at the counter (cash, cheque, bank transfer) are paid
 *     back by the school; the principal or office admin records the refund,
 *     how the money was given back and why.
 *   - Opening balances (paper receipts from before the portal) and cancelled
 *     receipts can't be refunded, and a receipt with refunds can't be cancelled.
 *   - An office refund entered by mistake is cancelled (cancelRefund): it stays
 *     on record, marked, and stops counting. A Razorpay refund can't be
 *     cancelled (the money really went back).
 *
 * Where the money comes from (planRefund): first what the payment had beyond
 * the fees due (an online payment for fees already settled); the rest comes
 * off the fee lines the payment paid, the latest-due line first, and those
 * fees are due again (waive them if the student has left, for example). The
 * payment keeps its receipt as it was; each refund gets its own voucher
 * number (ARY/26-27/RF00001) and appears in the collections report as money
 * paid out on its date. All amounts are in paise.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import { paymentAllocations, paymentRefunds, payments, refundAllocations, studentCharges } from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { isValidIsoDate, todayIST } from "@/lib/dates";
import { gatewayFor, type GatewayRefund } from "@/lib/payments";
import { isUuid, lockStudent, nextRefundVoucherNo, paidByCharge, PaymentError, rupees } from "./fees";

export type RefundMethod = "online" | "cash" | "cheque" | "bank";
/** How the office can give money back for a counter payment. */
export const REFUND_METHODS = ["cash", "cheque", "bank"] as const;
export const REFUND_METHOD_LABELS: Record<RefundMethod, { en: string; hi: string }> = {
  online: { en: "Razorpay refund", hi: "रेज़रपे से वापसी" },
  cash: { en: "Cash", hi: "नकद" },
  cheque: { en: "Cheque", hi: "चेक" },
  bank: { en: "Bank transfer", hi: "बैंक ट्रांसफ़र" },
};
/** The note on refunds recorded from Razorpay. */
export const GATEWAY_REFUND_NOTE = "Refunded through Razorpay";

/** An expected problem with a refund; the message can be shown as it is. */
export class RefundError extends PaymentError {}

/* ------------------------------------------------------------------ */
/* Where a refund's money comes from                                   */
/* ------------------------------------------------------------------ */

export type RefundPlan = {
  /** Taken from what the payment had beyond the fees due. */
  fromExcess: number;
  /** Taken off fee lines the payment paid (latest-due first): these fees are due again. */
  lines: { chargeId: string; amount: number }[];
};

/**
 * Plan a refund of `amount` on a payment, or null when it is more than can
 * still be refunded. `allocations` are the fee lines the payment paid (with
 * each line's due date, and `order` to break ties: later-created lines first);
 * `refundedFromLines` is what earlier refunds already took from each line,
 * `refundedTotal` everything earlier refunds took (lines and extra together).
 */
export function planRefund(input: {
  paymentAmount: number;
  allocations: { chargeId: string; amount: number; dueOn: string; order: number }[];
  refundedFromLines: Map<string, number>;
  refundedTotal: number;
  amount: number;
}): RefundPlan | null {
  const { paymentAmount, allocations, refundedFromLines, refundedTotal, amount } = input;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > paymentAmount - refundedTotal) return null;
  const allocated = allocations.reduce((a, l) => a + l.amount, 0);
  const refundedLines = [...refundedFromLines.values()].reduce((a, n) => a + n, 0);
  const extraLeft = Math.max(0, paymentAmount - allocated - (refundedTotal - refundedLines));
  let left = amount;
  const fromExcess = Math.min(left, extraLeft);
  left -= fromExcess;
  const lines: RefundPlan["lines"] = [];
  const latestFirst = [...allocations].sort((a, b) => b.dueOn.localeCompare(a.dueOn) || b.order - a.order);
  for (const a of latestFirst) {
    if (left <= 0) break;
    const room = a.amount - (refundedFromLines.get(a.chargeId) ?? 0);
    if (room <= 0) continue;
    const take = Math.min(room, left);
    lines.push({ chargeId: a.chargeId, amount: take });
    left -= take;
  }
  return left === 0 ? { fromExcess, lines } : null;
}

/* ------------------------------------------------------------------ */
/* Reading a payment's refunds                                         */
/* ------------------------------------------------------------------ */

/** What can still be refunded on a payment (0 for opening balances and cancelled receipts); `refunded` counts refunds not cancelled. */
export function refundableOf(p: { amount: number; method: string; status: string }, refunded: number): number {
  if (p.status !== "completed" || p.method === "opening") return 0;
  return Math.max(0, p.amount - refunded);
}

/* ------------------------------------------------------------------ */
/* Recording a refund                                                  */
/* ------------------------------------------------------------------ */

export type RefundInput = {
  schoolId: string;
  paymentId: string;
  amount: number;
  refundedOn: string;
  method: RefundMethod;
  reference?: string | null;
  note: string;
  /** Razorpay's refund id (online refunds only): each is recorded once. */
  providerRefundId?: string | null;
  /** The office form's one-time id (a UUID): a retried or repeated submit records nothing more. */
  requestId?: string | null;
};

export type RefundResult =
  | {
      status: "recorded";
      id: string;
      voucherNo: string;
      fromExcess: number;
      /** The fee lines the refund took money from (`waived`: nothing becomes due on those). */
      reopened: { chargeId: string; label: string; amount: number; waived: boolean }[];
    }
  | { status: "already"; id: string; voucherNo: string; cancelled: boolean };

/**
 * Record a refund on a payment, in the caller's transaction. The student is
 * locked first (like every money change), so two refunds at once can't both
 * use the same balance; a Razorpay refund already recorded is returned as
 * "already". Throws RefundError for anything the office should be told.
 */
export async function recordRefund(tx: Tx, input: RefundInput, actor: AuditActor): Promise<RefundResult> {
  if (!isUuid(input.paymentId)) throw new RefundError("That payment was not found.");
  const [p] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.id, input.paymentId), eq(payments.schoolId, input.schoolId)));
  if (!p) throw new RefundError("That payment was not found.");
  await lockStudent(tx, p.studentId, input.schoolId);
  // Read the status again now that the student is locked (a cancellation may have just happened).
  const [now] = await tx.select({ status: payments.status }).from(payments).where(eq(payments.id, p.id)).for("update");
  if (!now || now.status !== "completed") throw new RefundError("This receipt was cancelled, so there is nothing to refund.");
  if (p.method === "opening") throw new RefundError("This is an opening balance (a paper receipt from before the portal), so it can't be refunded here.");

  const gatewayRefund = !!input.providerRefundId;
  if (gatewayRefund) {
    if (p.method !== "online" || input.method !== "online") throw new RefundError("Only an online payment can have a Razorpay refund.");
    const [existing] = await tx
      .select({ id: paymentRefunds.id, paymentId: paymentRefunds.paymentId, voucherNo: paymentRefunds.voucherNo, status: paymentRefunds.status })
      .from(paymentRefunds)
      .where(eq(paymentRefunds.providerRefundId, input.providerRefundId!));
    if (existing) {
      if (existing.paymentId === p.id) return { status: "already", id: existing.id, voucherNo: existing.voucherNo, cancelled: existing.status !== "completed" };
      throw new RefundError("This Razorpay refund is already recorded on another payment.");
    }
  } else {
    if (p.method === "online") {
      throw new RefundError("Online payments are refunded in the Razorpay Dashboard. Then press “Record refunds made in Razorpay” on this payment.");
    }
    if (!(REFUND_METHODS as readonly string[]).includes(input.method)) throw new RefundError("Choose how the money was given back: cash, cheque or bank transfer.");
    if (input.requestId) {
      if (!isUuid(input.requestId)) throw new RefundError("Reload the page and try again.");
      const [same] = await tx
        .select({ id: paymentRefunds.id, paymentId: paymentRefunds.paymentId, voucherNo: paymentRefunds.voucherNo, status: paymentRefunds.status })
        .from(paymentRefunds)
        .where(eq(paymentRefunds.requestId, input.requestId));
      if (same) {
        if (same.paymentId === p.id) return { status: "already", id: same.id, voucherNo: same.voucherNo, cancelled: same.status !== "completed" };
        throw new RefundError("Reload the page and try again.");
      }
    }
  }

  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new RefundError("Enter an amount greater than zero.");
  if (!isValidIsoDate(input.refundedOn)) throw new RefundError("Enter the date the money was given back.");
  if (input.refundedOn > todayIST()) throw new RefundError("The refund date can't be in the future.");
  if (input.refundedOn < p.paidOn) throw new RefundError("The refund date can't be before the payment's date.");
  const note = input.note.trim().slice(0, 300);
  if (!note) throw new RefundError("Write why the money is being given back.");

  const [paid, earlier] = await Promise.all([
    tx
      .select({
        chargeId: paymentAllocations.chargeId,
        amount: paymentAllocations.amount,
        dueOn: studentCharges.dueOn,
        createdAt: studentCharges.createdAt,
        label: studentCharges.label,
        waived: studentCharges.waived,
      })
      .from(paymentAllocations)
      .innerJoin(studentCharges, eq(studentCharges.id, paymentAllocations.chargeId))
      .where(eq(paymentAllocations.paymentId, p.id)),
    // Refunds cancelled as mistakes don't count.
    tx
      .select({ id: paymentRefunds.id, amount: paymentRefunds.amount })
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.paymentId, p.id), eq(paymentRefunds.status, "completed"))),
  ]);
  const fromLines = earlier.length
    ? await tx
        .select({ chargeId: refundAllocations.chargeId, amount: sql<string>`sum(${refundAllocations.amount})`.mapWith(Number) })
        .from(refundAllocations)
        .where(inArray(refundAllocations.refundId, earlier.map((r) => r.id)))
        .groupBy(refundAllocations.chargeId)
    : [];
  const refundedTotal = earlier.reduce((a, r) => a + r.amount, 0);
  const plan = planRefund({
    paymentAmount: p.amount,
    allocations: paid.map((a) => ({ chargeId: a.chargeId, amount: a.amount, dueOn: a.dueOn, order: a.createdAt.getTime() })),
    refundedFromLines: new Map(fromLines.map((r) => [r.chargeId, r.amount])),
    refundedTotal,
    amount: input.amount,
  });
  if (!plan) {
    const left = p.amount - refundedTotal;
    throw new RefundError(left > 0 ? `At most ${rupees(left)} can still be refunded on receipt ${p.receiptNo}.` : `Everything paid on receipt ${p.receiptNo} has already been refunded.`);
  }

  const voucherNo = await nextRefundVoucherNo(tx, input.schoolId, p.sessionId);
  const [r] = await tx
    .insert(paymentRefunds)
    .values({
      schoolId: input.schoolId,
      paymentId: p.id,
      studentId: p.studentId,
      sessionId: p.sessionId,
      voucherNo,
      amount: input.amount,
      refundedOn: input.refundedOn,
      method: input.method,
      reference: input.reference?.trim() || null,
      note,
      provider: gatewayRefund ? p.provider : null,
      providerRefundId: input.providerRefundId ?? null,
      requestId: gatewayRefund ? null : (input.requestId ?? null),
      recordedBy: actor.accountId,
    })
    .returning({ id: paymentRefunds.id });
  if (plan.lines.length) await tx.insert(refundAllocations).values(plan.lines.map((l) => ({ refundId: r.id, ...l })));
  const lineOf = new Map(paid.map((a) => [a.chargeId, a]));
  const reopened = plan.lines.map((l) => ({ ...l, label: lineOf.get(l.chargeId)?.label ?? "Fee", waived: lineOf.get(l.chargeId)?.waived ?? false }));
  const dueAgain = reopened.filter((l) => !l.waived);
  await audit(tx, actor, "fees.refund", {
    schoolId: input.schoolId,
    targetType: "payment",
    targetId: p.id,
    details: {
      voucherNo,
      receiptNo: p.receiptNo,
      amount: input.amount,
      method: input.method,
      studentId: p.studentId,
      refundedOn: input.refundedOn,
      note,
      ...(plan.fromExcess ? { fromExtra: plan.fromExcess } : {}),
      ...(reopened.length ? { fromFees: reopened.map((l) => `${l.label}: ${rupees(l.amount)}`).join("; ") } : {}),
      ...(dueAgain.length ? { dueAgain: dueAgain.map((l) => `${l.label}: ${rupees(l.amount)}`).join("; ") } : {}),
      ...(input.providerRefundId ? { providerRefundId: input.providerRefundId } : {}),
    },
  });
  return { status: "recorded", id: r.id, voucherNo, fromExcess: plan.fromExcess, reopened };
}

/**
 * Cancel an office refund entered by mistake (the wrong amount, the wrong
 * receipt, recorded twice). It stays on record, marked cancelled with the
 * reason, and stops counting: the fees it took money from are paid again.
 * Refused when one of those fees has been paid again since (cancelling would
 * count it twice: refund the later payment instead), and for Razorpay
 * refunds. Returns false when it was already cancelled.
 */
export async function cancelRefund(tx: Tx, input: { schoolId: string; refundId: string; reason: string }, actor: AuditActor): Promise<boolean> {
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) throw new RefundError("Write why the refund is being cancelled (for example “Entered twice by mistake”).");
  if (!isUuid(input.refundId)) throw new RefundError("That refund was not found.");
  const [r] = await tx
    .select()
    .from(paymentRefunds)
    .where(and(eq(paymentRefunds.id, input.refundId), eq(paymentRefunds.schoolId, input.schoolId)));
  if (!r) throw new RefundError("That refund was not found.");
  await lockStudent(tx, r.studentId, input.schoolId);
  // Read it again now that the student is locked: two people cancelling at once cancel it once.
  const [now] = await tx.select({ status: paymentRefunds.status }).from(paymentRefunds).where(eq(paymentRefunds.id, r.id)).for("update");
  if (!now || now.status !== "completed") return false;
  if (r.method === "online" || r.providerRefundId) {
    throw new RefundError("A refund made through Razorpay can't be cancelled here: the money has gone back to the family. If it was a mistake, the family pays again.");
  }
  // Cancelling gives the fee lines back the money this refund took. A line paid again since would then count twice.
  const lines = await tx
    .select({ chargeId: refundAllocations.chargeId, amount: refundAllocations.amount, label: studentCharges.label, charge: studentCharges.amount })
    .from(refundAllocations)
    .innerJoin(studentCharges, eq(studentCharges.id, refundAllocations.chargeId))
    .where(eq(refundAllocations.refundId, r.id));
  const paidNow = await paidByCharge(
    tx,
    lines.map((l) => l.chargeId),
  );
  const overpaid = lines.filter((l) => (paidNow.get(l.chargeId) ?? 0) + l.amount > l.charge);
  if (overpaid.length) {
    throw new RefundError(
      `${overpaid.map((l) => l.label).join(", ")} ${overpaid.length === 1 ? "has" : "have"} been paid again since this refund, so cancelling it would count ${overpaid.length === 1 ? "that fee" : "those fees"} twice. First reverse (or refund) the later payment, then cancel this refund; record that later money again afterwards if the school keeps it.`,
    );
  }
  await tx.update(paymentRefunds).set({ status: "reversed", cancellationNote: reason, cancelledBy: actor.accountId, cancelledAt: new Date() }).where(eq(paymentRefunds.id, r.id));
  const [p] = await tx.select({ receiptNo: payments.receiptNo }).from(payments).where(eq(payments.id, r.paymentId));
  await audit(tx, actor, "fees.refund_cancelled", {
    schoolId: input.schoolId,
    targetType: "payment",
    targetId: r.paymentId,
    details: { voucherNo: r.voucherNo, receiptNo: p?.receiptNo ?? null, amount: r.amount, studentId: r.studentId, reason },
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* Refunds made at Razorpay                                            */
/* ------------------------------------------------------------------ */

/** The refund's date in India, never before the payment's own date. */
function refundDate(r: GatewayRefund, paidOn: string): string {
  const d = r.createdAt ? todayIST(r.createdAt) : todayIST();
  return d < paidOn ? paidOn : d > todayIST() ? todayIST() : d;
}

export type RefundSync = {
  recorded: { voucherNo: string; amount: number }[];
  already: number;
  /** Refunds Razorpay hasn't finished yet (recorded once processed). */
  pending: number;
  failed: number;
  problems: string[];
};

/** Record a refund Razorpay has processed, in the caller's transaction (webhook and office button). */
export async function recordGatewayRefund(tx: Tx, p: { id: string; schoolId: string; paidOn: string }, r: GatewayRefund, actor: AuditActor): Promise<RefundResult> {
  if (r.currency !== "INR") throw new RefundError(`Razorpay refund ${r.id} is in ${r.currency}, not rupees.`);
  return recordRefund(
    tx,
    { schoolId: p.schoolId, paymentId: p.id, amount: r.amount, refundedOn: refundDate(r, p.paidOn), method: "online", note: GATEWAY_REFUND_NOTE, providerRefundId: r.id },
    actor,
  );
}

/**
 * "Record refunds made in Razorpay": ask Razorpay for an online payment's
 * refunds and record the processed ones not recorded yet. Razorpay is asked
 * outside any database transaction; a GatewayError (Razorpay unreachable)
 * reaches the caller.
 */
export async function syncGatewayRefunds(input: { schoolId: string; paymentId: string }, actor: AuditActor): Promise<RefundSync> {
  const out: RefundSync = { recorded: [], already: 0, pending: 0, failed: 0, problems: [] };
  if (!isUuid(input.paymentId)) throw new RefundError("That payment was not found.");
  const db = await getDb();
  const [p] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, input.paymentId), eq(payments.schoolId, input.schoolId)));
  if (!p) throw new RefundError("That payment was not found.");
  if (p.method !== "online" || !p.provider || !p.providerPaymentId) throw new RefundError("This isn't an online payment, so there is nothing to look up at Razorpay.");
  const found = await gatewayFor(p.provider).fetchRefunds(p.providerPaymentId);
  found.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  for (const r of found) {
    if (r.status !== "processed") {
      if (r.status === "failed") out.failed++;
      else out.pending++;
      continue;
    }
    try {
      const res = await db.transaction((tx) => recordGatewayRefund(tx, p, r, actor));
      if (res.status === "recorded") out.recorded.push({ voucherNo: res.voucherNo, amount: r.amount });
      else out.already++;
    } catch (err) {
      if (!(err instanceof RefundError)) throw err;
      out.problems.push(err.message);
    }
  }
  return out;
}
