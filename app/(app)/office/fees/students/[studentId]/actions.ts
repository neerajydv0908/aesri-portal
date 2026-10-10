"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { paymentRefunds, payments, students } from "@/lib/db/schema";
import { auditActor } from "@/lib/auth/dal";
import { officePage } from "@/lib/page";
import { FEE_ROLES, OFFICE_ROLES } from "@/lib/roles";
import { done, fail, type FormState } from "@/lib/forms";
import { cleanText, parseDate, str } from "@/lib/validation";
import { failKeeping } from "@/components/fees/remember";
import { addDays, todayIST } from "@/lib/dates";
import {
  addAdmissionFee,
  isUuid,
  METHOD_LABELS,
  OFFICE_METHODS,
  parseRupees,
  PaymentError,
  recordPayment,
  restoreCharge,
  reversePayment,
  rupees,
  sessionDates,
  waiveCharge,
} from "@/lib/services/fees";
import { GatewayError, razorpayGateway } from "@/lib/payments";
import { checkStudentOrders } from "@/lib/services/payment-check";
import { cancelRefund, recordRefund, REFUND_METHOD_LABELS, REFUND_METHODS, RefundError, syncGatewayRefunds } from "@/lib/services/refunds";

const ADMIN_ONLY = "Only the principal or the office administrator can do this. Please ask them.";

async function studentInSchool(studentId: string, schoolId: string): Promise<boolean> {
  if (!isUuid(studentId)) return false;
  const db = await getDb();
  const [s] = await db
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)));
  return !!s;
}

/** Accountants and administrators: money received at the counter. */
export async function recordPaymentAction(studentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, schoolId, sessionId } = await officePage(FEE_ROLES);
  if (!(await studentInSchool(studentId, schoolId))) return fail("This student was not found in your school.");

  const amount = parseRupees(str(formData, "amount"));
  const method = str(formData, "method") as (typeof OFFICE_METHODS)[number];
  const reference = cleanText(formData.get("reference"), 80);
  const paidOn = parseDate(str(formData, "paidOn"));
  const db = await getDb();
  const session = await sessionDates(db, sessionId);
  const earliest = session ? addDays(session.startsOn, -120) : "2000-01-01";

  const fields: Record<string, string> = {};
  if (!amount) fields.amount = "Enter the amount received in rupees, for example 5000.";
  if (!OFFICE_METHODS.includes(method)) fields.method = "Choose cash, cheque or bank transfer.";
  else if (method === "cheque" && !reference) fields.reference = "Enter the cheque number and the bank's name.";
  else if (method === "bank" && !reference) fields.reference = "Enter the transfer reference (UTR number).";
  if (!paidOn || paidOn === "invalid") fields.paidOn = "Enter the date the money was received.";
  else if (paidOn > todayIST()) fields.paidOn = "The date can't be in the future.";
  else if (paidOn < earliest) fields.paidOn = "That date is too early for this session. Check the year.";
  if (Object.keys(fields).length) return failKeeping(formData, "Please check the highlighted fields.", fields);

  const who = await auditActor(actor);
  try {
    const r = await db.transaction((tx) => recordPayment(tx, { schoolId, studentId, sessionId, amount: amount!, method, reference, paidOn: paidOn as string }, who));
    refresh();
    return done(`${rupees(amount!)} received (${METHOD_LABELS[method].en.toLowerCase()}). Receipt ${r.receiptNo} is ready to print.`, { paymentId: r.id, receiptNo: r.receiptNo });
  } catch (err) {
    if (err instanceof PaymentError) return failKeeping(formData, err.message, { amount: err.message });
    throw err;
  }
}

/** Administrators only: cancel a payment (e.g. a bounced cheque). The receipt stays, marked cancelled. */
export async function reversePaymentAction(studentId: string, paymentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, schoolId } = await officePage(FEE_ROLES);
  if (!OFFICE_ROLES.includes(actor.role)) return fail(ADMIN_ONLY);
  if (!isUuid(paymentId) || !(await studentInSchool(studentId, schoolId))) return fail("That payment was not found.");
  const reason = cleanText(formData.get("reason"), 300);
  if (!reason) return fail("Write why the payment is being reversed, for example “Cheque bounced”.");
  const db = await getDb();
  const [p] = await db
    .select({ id: payments.id, receiptNo: payments.receiptNo })
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.schoolId, schoolId), eq(payments.studentId, studentId)));
  if (!p) return fail("That payment was not found.");
  const who = await auditActor(actor);
  try {
    await db.transaction((tx) => reversePayment(tx, p.id, schoolId, reason, who));
  } catch (err) {
    if (err instanceof PaymentError) return fail(err.message);
    throw err;
  }
  refresh();
  return done(`Receipt ${p.receiptNo} is now cancelled. The amount is due again.`);
}

/** Administrators only: waive what is still due on a fee line, with a note. */
export async function waiveLineAction(studentId: string, chargeId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, schoolId, sessionId } = await officePage(FEE_ROLES);
  if (!OFFICE_ROLES.includes(actor.role)) return fail(ADMIN_ONLY);
  if (!(await studentInSchool(studentId, schoolId))) return fail("That fee line was not found.");
  const note = cleanText(formData.get("note"), 300);
  if (!note) return fail("Write why this fee is being waived.");
  const db = await getDb();
  const who = await auditActor(actor);
  try {
    const r = await db.transaction((tx) => waiveCharge(tx, { schoolId, sessionId, chargeId, studentId, note }, who));
    refresh();
    return done(`${rupees(r.waived)} waived.`);
  } catch (err) {
    if (err instanceof PaymentError) return fail(err.message);
    throw err;
  }
}

/** Administrators only: undo a waiver made by mistake. */
export async function restoreLineAction(studentId: string, chargeId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const { actor, schoolId, sessionId } = await officePage(FEE_ROLES);
  if (!OFFICE_ROLES.includes(actor.role)) return fail(ADMIN_ONLY);
  if (!(await studentInSchool(studentId, schoolId))) return fail("That fee line was not found.");
  const db = await getDb();
  const who = await auditActor(actor);
  try {
    await db.transaction((tx) => restoreCharge(tx, { schoolId, sessionId, chargeId, studentId }, who));
  } catch (err) {
    if (err instanceof PaymentError) return fail(err.message);
    throw err;
  }
  refresh();
  return done("The waiver was removed. The fee is due again.");
}

/** One form per fee line: waive its balance, or undo a waiver ("op" says which). */
export async function lineAction(studentId: string, chargeId: string, prev: FormState, formData: FormData): Promise<FormState> {
  const op = str(formData, "op");
  if (op === "waive") return waiveLineAction(studentId, chargeId, prev, formData);
  if (op === "restore") return restoreLineAction(studentId, chargeId, prev, formData);
  await officePage(FEE_ROLES);
  return fail("Reload the page and try again.");
}

/** Administrators only: the one-time admission fee for a new admission this session. */
export async function addAdmissionFeeAction(studentId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const { actor, schoolId, sessionId } = await officePage(FEE_ROLES);
  if (!OFFICE_ROLES.includes(actor.role)) return fail(ADMIN_ONLY);
  if (!(await studentInSchool(studentId, schoolId))) return fail("This student was not found in your school.");
  const db = await getDb();
  const who = await auditActor(actor);
  try {
    await db.transaction((tx) => addAdmissionFee(tx, { schoolId, sessionId, studentId }, who));
  } catch (err) {
    if (err instanceof PaymentError) return fail(err.message);
    throw err;
  }
  refresh();
  return done("The admission fee was added to this student's fees.");
}

/* ------------------------------------------------------------------ */
/* Online payments and refunds                                         */
/* ------------------------------------------------------------------ */

const RAZORPAY_UNREACHABLE = "Razorpay couldn’t be reached just now. Please try again in a few minutes.";
const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;

/**
 * Accountants and administrators: "Check with Razorpay" — ask Razorpay at once
 * about this student's unfinished online payments, and record any that were
 * paid but never got a receipt (the portal also does this by itself every 10 minutes).
 */
export async function checkRazorpayAction(studentId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const { actor, schoolId } = await officePage(FEE_ROLES);
  if (!(await studentInSchool(studentId, schoolId))) return fail("This student was not found in your school.");
  if (!razorpayGateway.isConfigured()) return fail("Razorpay isn’t set up on this server, so there is nothing to check.");
  const who = await auditActor(actor);
  const s = await checkStudentOrders({ schoolId, studentId }, who);
  refresh();
  if (!s.orders) return done("This student has no unfinished Razorpay payments from the last 30 days to check.");
  const parts: string[] = [];
  if (s.recorded.length) {
    parts.push(
      `Found ${n(s.recorded.length, "payment", "payments")} at Razorpay that had no receipt: ${s.recorded.map((r) => `receipt ${r.receiptNo} (${rupees(r.amount)})`).join(", ")} ${s.recorded.length === 1 ? "is" : "are"} now recorded, and the family gets the usual text message.`,
    );
  }
  if (s.waiting) parts.push(`${n(s.waiting, "payment is", "payments are")} authorised at Razorpay but not captured yet: Razorpay captures it automatically (it is then recorded here) or returns the money to the family.`);
  if (s.refundedThere) parts.push(`${n(s.refundedThere, "payment was", "payments were")} paid and then refunded in full at Razorpay, so there is nothing to record.`);
  if (s.problems) parts.push(`${n(s.problems, "payment needs", "payments need")} attention and got no receipt: see the activity log (Fees).`);
  if (s.errors) parts.push(RAZORPAY_UNREACHABLE);
  if (!parts.length) parts.push(`Checked ${n(s.orders, "unfinished online payment", "unfinished online payments")} with Razorpay: no money was taken for ${s.orders === 1 ? "it" : "them"}.`);
  return s.errors && !s.recorded.length ? fail(parts.join(" ")) : done(parts.join(" "));
}

/**
 * Administrators only: refunds. "op" says which:
 *   "office":  money given back for a counter payment (cash, cheque or bank transfer), with a reason;
 *   "gateway": record the refunds made in the Razorpay Dashboard for an online payment.
 */
export async function refundAction(studentId: string, paymentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, schoolId } = await officePage(FEE_ROLES);
  if (!OFFICE_ROLES.includes(actor.role)) return fail(ADMIN_ONLY);
  if (!isUuid(paymentId) || !(await studentInSchool(studentId, schoolId))) return fail("That payment was not found.");
  const db = await getDb();
  const [p] = await db
    .select({ id: payments.id, receiptNo: payments.receiptNo, method: payments.method })
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.schoolId, schoolId), eq(payments.studentId, studentId)));
  if (!p) return fail("That payment was not found.");
  const who = await auditActor(actor);

  if (str(formData, "op") === "gateway") {
    try {
      const r = await syncGatewayRefunds({ schoolId, paymentId: p.id }, who);
      refresh();
      const parts: string[] = [];
      if (r.recorded.length) parts.push(`Recorded ${n(r.recorded.length, "refund", "refunds")} from Razorpay on receipt ${p.receiptNo}: ${r.recorded.map((x) => `${rupees(x.amount)} (voucher ${x.voucherNo})`).join(", ")}.`);
      if (r.already) parts.push(`${n(r.already, "refund was", "refunds were")} already recorded.`);
      if (r.pending) parts.push(`${n(r.pending, "refund is", "refunds are")} still being processed by Razorpay: ${r.pending === 1 ? "it is" : "they are"} recorded once done.`);
      if (r.failed) parts.push(`${n(r.failed, "refund", "refunds")} failed at Razorpay, so no money went back.`);
      if (r.problems.length) parts.push(...r.problems);
      if (!parts.length) parts.push(`Razorpay has no refunds for receipt ${p.receiptNo}. Make the refund in the Razorpay Dashboard first, then press this again.`);
      return r.problems.length && !r.recorded.length ? fail(parts.join(" ")) : done(parts.join(" "));
    } catch (err) {
      if (err instanceof GatewayError) return fail(RAZORPAY_UNREACHABLE);
      if (err instanceof RefundError) return fail(err.message);
      throw err;
    }
  }

  const amount = parseRupees(str(formData, "amount"));
  const method = str(formData, "method") as (typeof REFUND_METHODS)[number];
  const reference = cleanText(formData.get("reference"), 80);
  const refundedOn = parseDate(str(formData, "refundedOn"));
  const note = cleanText(formData.get("note"), 300);
  // The form's one-time id: sending the same form again (a retry after a lost answer) records nothing more.
  const requestId = isUuid(str(formData, "requestId")) ? str(formData, "requestId") : null;
  const fields: Record<string, string> = {};
  if (!amount) fields.amount = "Enter the amount given back in rupees, for example 2000.";
  if (!REFUND_METHODS.includes(method)) fields.method = "Choose how the money was given back.";
  else if (method === "cheque" && !reference) fields.reference = "Enter the cheque number and the bank’s name.";
  else if (method === "bank" && !reference) fields.reference = "Enter the transfer reference (UTR number).";
  if (!refundedOn || refundedOn === "invalid") fields.refundedOn = "Enter the date the money was given back.";
  else if (refundedOn > todayIST()) fields.refundedOn = "The date can’t be in the future.";
  if (!note) fields.note = "Write why the money is being given back.";
  if (Object.keys(fields).length) return failKeeping(formData, "Please check the highlighted fields.", fields);
  try {
    const r = await db.transaction((tx) =>
      recordRefund(tx, { schoolId, paymentId: p.id, amount: amount!, refundedOn: refundedOn as string, method, reference, note: note!, requestId }, who),
    );
    refresh();
    if (r.status !== "recorded") {
      return r.cancelled
        ? fail(`This form was already used for refund ${r.voucherNo}, which has since been cancelled. Reload the page to record a new refund.`)
        : done(`This refund was already recorded (voucher ${r.voucherNo}).`);
    }
    // Waived lines stay waived: nothing becomes due on them.
    const due = r.reopened.filter((l) => !l.waived);
    const dueAgain = due.length
      ? ` ${due.map((l) => `${l.label} (${rupees(l.amount)})`).join(", ")} ${due.length === 1 ? "is" : "are"} due again: waive ${due.length === 1 ? "it" : "them"} if the fee is no longer charged (for example when the student has left).`
      : "";
    return done(`${rupees(amount!)} refunded (${REFUND_METHOD_LABELS[method].en.toLowerCase()}) on receipt ${p.receiptNo}. Refund voucher ${r.voucherNo}.${dueAgain}`);
  } catch (err) {
    if (err instanceof PaymentError) return failKeeping(formData, err.message, { amount: err.message });
    throw err;
  }
}

/** Administrators only: cancel an office refund entered by mistake. It stays on record, marked cancelled, and stops counting. */
export async function cancelRefundAction(studentId: string, refundId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, schoolId } = await officePage(FEE_ROLES);
  if (!OFFICE_ROLES.includes(actor.role)) return fail(ADMIN_ONLY);
  if (!isUuid(refundId) || !(await studentInSchool(studentId, schoolId))) return fail("That refund was not found.");
  const reason = cleanText(formData.get("reason"), 300);
  if (!reason) return fail("Write why the refund is being cancelled, for example “Entered twice by mistake”.", { reason: "Write why the refund is being cancelled." });
  const db = await getDb();
  const [r] = await db
    .select({ id: paymentRefunds.id, voucherNo: paymentRefunds.voucherNo, amount: paymentRefunds.amount })
    .from(paymentRefunds)
    .where(and(eq(paymentRefunds.id, refundId), eq(paymentRefunds.schoolId, schoolId), eq(paymentRefunds.studentId, studentId)));
  if (!r) return fail("That refund was not found.");
  const who = await auditActor(actor);
  try {
    const changed = await db.transaction((tx) => cancelRefund(tx, { schoolId, refundId: r.id, reason }, who));
    refresh();
    return done(changed ? `Refund ${r.voucherNo} (${rupees(r.amount)}) is cancelled. It stays on record, and the fees it took money from count as paid again.` : `Refund ${r.voucherNo} was already cancelled.`);
  } catch (err) {
    if (err instanceof PaymentError) return fail(err.message);
    throw err;
  }
}
