/**
 * Fees: plans, charges (what is owed), payments (what was paid) and receipts.
 *
 * Amounts are in paise. A payment is split across the charges it pays for
 * (allocations), oldest due date first, so every receipt can say exactly
 * which instalment it covers. Receipt numbers come from a per-school,
 * per-session counter and are never reused; a reversed payment keeps its
 * receipt, marked cancelled. Refunds (lib/services/refunds.ts) take money
 * back from a payment's lines; every "paid" figure here is net of them.
 *
 * Only the approved fee heads exist: the session's instalments (from the
 * fee plan) and the one-time admission fee. Nothing here lets staff invent
 * other fee lines. RTE-seat students get the same lines, waived.
 *
 * Families pay in their own amounts (familyPayable, checkFamilyChoice): the
 * admission fee — charged once, when a child joins — as one fixed sum, and
 * tuition (the instalment lines) in any amount of at least ₹1,000, or what
 * is left when that is less. Tuition money goes to the oldest instalment
 * first; the instalments' dates only say what has fallen due.
 *
 * Every write takes the caller's transaction and adds an audit entry.
 * Writes that touch a student's money first lock the student row, so two
 * people recording at the same moment can't both use the same balance.
 */
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import {
  academicSessions,
  accounts,
  auditLog,
  cashClaims,
  classes,
  counters,
  enrolments,
  feeBands,
  feeInstalments,
  feeOneTime,
  feePlans,
  paymentAllocations,
  paymentOrders,
  paymentRefunds,
  payments,
  refundAllocations,
  schools,
  sections,
  staff,
  studentCharges,
  students,
} from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { queuePayment, queuePaymentCancelled } from "@/lib/sms/outbox";
import { classLabel, classLabelHi } from "@/lib/classes";
import { isValidIsoDate, todayIST } from "@/lib/dates";

export function rupees(paise: number): string {
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "10,000" or "10000.50" → 1000000 paise. Returns null if not a positive amount. */
export function parseRupees(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return null;
  const s = String(input).replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const paise = Math.round(Number(s) * 100);
  return paise > 0 && Number.isSafeInteger(paise) ? paise : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** IDs from URLs and forms must look like UUIDs before they reach a query. */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export type PaymentMethod = "cash" | "cheque" | "bank" | "online" | "opening";
export const OFFICE_METHODS = ["cash", "cheque", "bank"] as const;
export const METHOD_LABELS: Record<PaymentMethod, { en: string; hi: string }> = {
  cash: { en: "Cash", hi: "नकद" },
  cheque: { en: "Cheque", hi: "चेक" },
  bank: { en: "Bank transfer", hi: "बैंक ट्रांसफ़र" },
  online: { en: "Online", hi: "ऑनलाइन" },
  opening: { en: "Opening balance", hi: "पोर्टल से पहले जमा" },
};

/** The note ensureSessionCharges writes on RTE-seat lines. */
export const RTE_WAIVER_NOTE = "RTE seat — no fee charged";
export const isRteWaiver = (note: string | null | undefined) => !!note && note.startsWith("RTE");

/* ------------------------------------------------------------------ */
/* Amount in words (Indian numbering)                                  */
/* ------------------------------------------------------------------ */

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function upTo99(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}

/** 125000 → "One Lakh Twenty Five Thousand" (crore, lakh, thousand, hundred). */
export function numberInWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  if (crore) parts.push(`${numberInWords(crore)} Crore`);
  if (lakh) parts.push(`${upTo99(lakh)} Lakh`);
  if (thousand) parts.push(`${upTo99(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(upTo99(rest));
  return parts.join(" ");
}

/** 1250050 paise → "Rupees Twelve Thousand Five Hundred and Fifty Paise Only". */
export function amountInWords(paise: number): string {
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  if (!r && p) return `${upTo99(p)} Paise Only`;
  return `Rupees ${numberInWords(r)}${p ? ` and ${upTo99(p)} Paise` : ""} Only`;
}

/** Hindi numbers 0–99 each have their own word. */
const HI_0_99 = (
  "शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस " +
  "बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस " +
  "चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ " +
  "साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी " +
  "अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे"
).split(" ");

/** 125000 → "एक लाख पच्चीस हज़ार" (करोड़, लाख, हज़ार, सौ). */
export function numberInWordsHi(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n < 100) return HI_0_99[n];
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  if (crore) parts.push(`${numberInWordsHi(crore)} करोड़`);
  if (lakh) parts.push(`${HI_0_99[lakh]} लाख`);
  if (thousand) parts.push(`${HI_0_99[thousand]} हज़ार`);
  if (hundred) parts.push(`${HI_0_99[hundred]} सौ`);
  if (rest) parts.push(HI_0_99[rest]);
  return parts.join(" ");
}

/** 1250050 paise → "बारह हज़ार पाँच सौ रुपये और पचास पैसे मात्र" (the receipt's amount in words, in Hindi). */
export function amountInWordsHi(paise: number): string {
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  if (!r && p) return `${HI_0_99[p]} पैसे मात्र`;
  return `${numberInWordsHi(r)} रुपये${p ? ` और ${HI_0_99[p]} पैसे` : ""} मात्र`;
}

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

export async function currentPlan(tx: Tx, schoolId: string) {
  const [plan] = await tx
    .select()
    .from(feePlans)
    .where(and(eq(feePlans.schoolId, schoolId), eq(feePlans.isCurrent, true)));
  if (!plan) return null;
  const [bands, instalments, oneTime] = await Promise.all([
    tx.select().from(feeBands).where(eq(feeBands.planId, plan.id)).orderBy(asc(feeBands.sortOrder)),
    tx.select().from(feeInstalments).where(eq(feeInstalments.planId, plan.id)).orderBy(asc(feeInstalments.sortOrder)),
    tx.select().from(feeOneTime).where(eq(feeOneTime.planId, plan.id)),
  ]);
  return { ...plan, bands, instalments, oneTime };
}
export type Plan = NonNullable<Awaited<ReturnType<typeof currentPlan>>>;

/** "2026-27" + "09-15" → "2026-09-15"; January–March fall in the second year. */
export function dueDateFor(sessionId: string, monthDay: string): string {
  const startYear = Number(sessionId.slice(0, 4));
  const month = Number(monthDay.slice(0, 2));
  const year = month >= 4 ? startYear : startYear + 1;
  // A 29 February chosen in a leap year becomes 28 February in other years (2029-02-29 doesn't exist).
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return `${year}-${monthDay === "02-29" && !leap ? "02-28" : monthDay}`;
}

/** Split an annual amount into instalments by percentage; the last takes any rounding remainder. */
export function splitAnnual(annual: number, percents: number[]): number[] {
  const parts = percents.map((p) => Math.floor((annual * p) / 100 / 100) * 100); // whole rupees
  const diff = annual - parts.reduce((a, b) => a + b, 0);
  parts[parts.length - 1] += diff;
  return parts;
}

/* ------------------------------------------------------------------ */
/* Instalment lines: "Term I — Class II"                               */
/* ------------------------------------------------------------------ */

/**
 * The fee is per student, per year, so an instalment line names the
 * student's own class: "Term I — Class II" · "पहली किस्त — कक्षा 2" (never
 * the group of classes that shares the amount, which read like one fee for
 * all of them; lines made before read "Term I — LKG – Class V" until
 * `npm run fees:relabel` rewrites them). Lines are found again by their
 * "<instalment> — " prefix, which both forms share (ensureSessionCharges,
 * changeInstalmentSplit, and repriceInstalments in lib/services/students.ts).
 */
export function instalmentLineLabels(ins: { label: string; labelHi: string }, className: string, stream: string | null): { label: string; labelHi: string } {
  return { label: `${instalmentPrefix(ins)}${classLabel(className, stream)}`, labelHi: `${ins.labelHi} — ${classLabelHi(className, stream)}` };
}

/** "Term I — ": how every line of an instalment starts. */
export const instalmentPrefix = (ins: { label: string }) => `${ins.label} — `;

/** Is this line (by its English label) one of the instalment's lines? */
export const isLineOf = (ins: { label: string }, lineLabel: string) => lineLabel.startsWith(instalmentPrefix(ins));

/** The same test in SQL: a LIKE pattern with the instalment's label taken literally. */
export const lineLikePattern = (ins: { label: string }) => `${instalmentPrefix(ins).replace(/[\\%_]/g, "\\$&")}%`;

/**
 * What one student in a class pays in a year under a plan: the group of
 * classes with that fee (band), the annual amount, and each instalment's
 * share. Null when the plan has no fee for the class.
 */
export function annualFeeFor(plan: Pick<Plan, "bands" | "instalments">, className: string): { band: Plan["bands"][number]; amount: number; instalments: number[] } | null {
  const band = plan.bands.find((b) => b.classNames.includes(className));
  if (!band) return null;
  const percents = plan.instalments.map((i) => i.percent);
  return { band, amount: band.annualAmount, instalments: percents.length ? splitAnnual(band.annualAmount, percents) : [] };
}

/* ------------------------------------------------------------------ */
/* Charges                                                             */
/* ------------------------------------------------------------------ */

/**
 * Create the session's instalment charges for a student (once). RTE
 * students get the same lines marked as waived, so their ledger is complete.
 */
export async function ensureSessionCharges(tx: Tx, studentId: string, sessionId: string, actor: AuditActor | null): Promise<number> {
  const existing = await tx
    .select({ id: studentCharges.id })
    .from(studentCharges)
    .where(and(eq(studentCharges.studentId, studentId), eq(studentCharges.sessionId, sessionId), eq(studentCharges.kind, "instalment")));
  if (existing.length) return 0;

  const [row] = await tx
    .select({ schoolId: students.schoolId, rte: students.rte, className: classes.name, stream: classes.stream, admittedOn: students.admittedOn })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .innerJoin(sections, eq(sections.id, enrolments.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(and(eq(enrolments.studentId, studentId), eq(enrolments.sessionId, sessionId)));
  if (!row) return 0;
  // A child admitted mid-session owes instalments that already fell due from the day of admission, not from April.
  const [session] = await tx.select().from(academicSessions).where(eq(academicSessions.id, sessionId));
  const admitted = row.admittedOn && session && row.admittedOn >= session.startsOn && row.admittedOn <= session.endsOn ? row.admittedOn : null;
  const dueOn = (monthDay: string) => {
    const d = dueDateFor(sessionId, monthDay);
    return admitted && admitted > d ? admitted : d;
  };
  const plan = await currentPlan(tx, row.schoolId);
  if (!plan || !plan.instalments.length) return 0;
  const band = plan.bands.find((b) => b.classNames.includes(row.className));
  if (!band) return 0;

  const amounts = splitAnnual(
    band.annualAmount,
    plan.instalments.map((i) => i.percent),
  );
  const values = plan.instalments.map((ins, idx) => ({
    schoolId: row.schoolId,
    studentId,
    sessionId,
    planId: plan.id,
    kind: "instalment" as const,
    ...instalmentLineLabels(ins, row.className, row.stream),
    amount: amounts[idx],
    dueOn: dueOn(ins.dueMonthDay),
    waived: row.rte,
    waiverNote: row.rte ? RTE_WAIVER_NOTE : null,
    createdBy: actor?.accountId ?? null,
  }));
  await tx.insert(studentCharges).values(values);
  return values.length;
}

/**
 * The one-time admission fee, for a new admission made through the portal.
 * A student is charged it once while at the school — never again in a later
 * session — so nothing happens when they already have the line.
 */
export async function addAdmissionCharge(tx: Tx, studentId: string, sessionId: string, actor: AuditActor): Promise<void> {
  const [s] = await tx.select({ schoolId: students.schoolId, rte: students.rte }).from(students).where(eq(students.id, studentId));
  if (!s || (await hasAdmissionCharge(tx, studentId))) return;
  const plan = await currentPlan(tx, s.schoolId);
  const fee = plan?.oneTime.find((o) => o.key === "admission");
  if (!plan || !fee) return;
  await tx.insert(studentCharges).values({
    schoolId: s.schoolId,
    studentId,
    sessionId,
    planId: plan.id,
    kind: "admission",
    label: `${fee.label}${fee.refundable ? "" : " (non-refundable)"}`,
    labelHi: `${fee.labelHi}${fee.refundable ? "" : " (वापसी योग्य नहीं)"}`,
    amount: fee.amount,
    dueOn: todayIST(),
    waived: s.rte,
    waiverNote: s.rte ? RTE_WAIVER_NOTE : null,
    createdBy: actor.accountId,
  });
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export type LedgerCharge = {
  id: string;
  kind: "instalment" | "admission" | "other";
  label: string;
  labelHi: string;
  amount: number;
  paid: number;
  outstanding: number;
  dueOn: string;
  waived: boolean;
  waiverNote: string | null;
};

/**
 * Refunded so far from each charge (refunds not cancelled). A payment with
 * refunds can't be cancelled and a cancelled one can't be refunded, so every
 * refund belongs to a completed payment.
 */
export async function refundedByCharge(tx: Tx, chargeIds: string[]): Promise<Map<string, number>> {
  if (!chargeIds.length) return new Map();
  const rows = await tx
    .select({ chargeId: refundAllocations.chargeId, refunded: sql<string>`sum(${refundAllocations.amount})`.mapWith(Number) })
    .from(refundAllocations)
    .innerJoin(paymentRefunds, eq(paymentRefunds.id, refundAllocations.refundId))
    .where(and(inArray(refundAllocations.chargeId, chargeIds), eq(paymentRefunds.status, "completed")))
    .groupBy(refundAllocations.chargeId);
  return new Map(rows.map((r) => [r.chargeId, r.refunded]));
}

/** Paid so far on each charge (completed payments only, less refunds). */
export async function paidByCharge(tx: Tx, chargeIds: string[]): Promise<Map<string, number>> {
  if (!chargeIds.length) return new Map();
  const [rows, refunded] = await Promise.all([
    tx
      .select({ chargeId: paymentAllocations.chargeId, paid: sql<string>`sum(${paymentAllocations.amount})`.mapWith(Number) })
      .from(paymentAllocations)
      .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
      .where(and(inArray(paymentAllocations.chargeId, chargeIds), eq(payments.status, "completed")))
      .groupBy(paymentAllocations.chargeId),
    refundedByCharge(tx, chargeIds),
  ]);
  return new Map(rows.map((r) => [r.chargeId, r.paid - (refunded.get(r.chargeId) ?? 0)]));
}

type ChargeRow = typeof studentCharges.$inferSelect;

function toLine(c: ChargeRow, paid: number): LedgerCharge {
  return {
    id: c.id,
    kind: c.kind,
    label: c.label,
    labelHi: c.labelHi,
    amount: c.amount,
    paid,
    outstanding: c.waived ? 0 : Math.max(0, c.amount - paid),
    dueOn: c.dueOn,
    waived: c.waived,
    waiverNote: c.waiverNote,
  };
}

/** A waived line counts only what was paid before the waiver. */
const effectiveCharge = (l: { amount: number; paid: number; waived: boolean }) => (l.waived ? Math.min(l.paid, l.amount) : l.amount);

function lineTotals(lines: LedgerCharge[], today: string) {
  return {
    charged: lines.reduce((a, l) => a + effectiveCharge(l), 0),
    outstanding: lines.reduce((a, l) => a + l.outstanding, 0),
    overdue: lines.filter((l) => l.dueOn < today).reduce((a, l) => a + l.outstanding, 0),
    dueNow: lines.filter((l) => l.dueOn <= today).reduce((a, l) => a + l.outstanding, 0),
    waived: lines.filter((l) => l.waived).reduce((a, l) => a + (l.amount - effectiveCharge(l)), 0),
  };
}

export async function ledger(tx: Tx, studentId: string, sessionId: string) {
  const charges = await tx
    .select()
    .from(studentCharges)
    .where(and(eq(studentCharges.studentId, studentId), eq(studentCharges.sessionId, sessionId)))
    .orderBy(asc(studentCharges.dueOn), asc(studentCharges.createdAt));
  const paidBy = await paidByCharge(
    tx,
    charges.map((c) => c.id),
  );
  const lines = charges.map((c) => toLine(c, paidBy.get(c.id) ?? 0));
  const [pays, refunds] = await Promise.all([
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.studentId, studentId), eq(payments.sessionId, sessionId)))
      .orderBy(asc(payments.paidOn), asc(payments.createdAt), asc(payments.receiptNo)),
    tx
      .select()
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.studentId, studentId), eq(paymentRefunds.sessionId, sessionId)))
      .orderBy(asc(paymentRefunds.refundedOn), asc(paymentRefunds.createdAt)),
  ]);
  // Refunds cancelled as mistakes are listed (marked) but never counted.
  const refunded = refunds.filter((r) => r.status === "completed").reduce((a, r) => a + r.amount, 0);
  const totals = {
    ...lineTotals(lines, todayIST()),
    /** Paid this session, less refunds. */
    paid: pays.filter((p) => p.status === "completed").reduce((a, p) => a + p.amount, 0) - refunded,
    refunded,
  };
  return { lines, payments: pays, refunds, totals };
}
export type Ledger = Awaited<ReturnType<typeof ledger>>;

/** One student's fee lines with these ids, with what is still due on each, in the order asked for (an online order's lines). */
export async function linesById(tx: Tx, chargeIds: string[], studentId: string): Promise<LedgerCharge[]> {
  const ids = [...new Set(chargeIds.filter(isUuid))];
  if (!ids.length) return [];
  const charges = await tx
    .select()
    .from(studentCharges)
    .where(and(inArray(studentCharges.id, ids), eq(studentCharges.studentId, studentId)));
  const paidBy = await paidByCharge(
    tx,
    charges.map((c) => c.id),
  );
  const byId = new Map(charges.map((c) => [c.id, toLine(c, paidBy.get(c.id) ?? 0)]));
  return ids.map((id) => byId.get(id)).filter((l): l is LedgerCharge => !!l);
}

/* ------------------------------------------------------------------ */
/* What a family may pay: the admission fee whole, tuition flexibly    */
/* ------------------------------------------------------------------ */

/** The smallest tuition payment a family can make on the portal: ₹1,000 — or what is left, when that is less. */
export const MIN_TUITION_PAYMENT = 1000_00;

/** The admission fee (charged once, when a child joins the school) is paid whole; every other line is tuition. */
export const isAdmissionLine = (l: { kind: string }) => l.kind === "admission";

/** A cash payment the family recorded that is waiting for the school's approval. */
export type PendingCash = { amount: number; admissionAmount: number };

export type FamilyPayable = {
  /** The admission fee's balance, paid as one fixed sum (null: nothing to pay, or it is in a recorded cash payment waiting for approval). */
  admission: { amount: number; chargeIds: string[] } | null;
  /**
   * Tuition: any amount from `min` to `max` (null: nothing left to pay this session). `dueNow`: the
   * part that has fallen due (the instalments' dates), never more than `max`. `chargeIds`: the
   * instalment lines, oldest first — tuition money pays them in that order.
   */
  tuition: { min: number; max: number; dueNow: number; chargeIds: string[] } | null;
  /** In cash payments the family recorded that are waiting for approval (not paid yet, but not offered again). */
  pending: { admission: number; tuition: number };
  /**
   * Tuition that can't be paid yet: what is left beside the cash payments
   * waiting for approval, when that is less than the smallest payment allowed
   * (it can be paid once they are decided). 0 when there is none.
   */
  held: number;
};

/**
 * What a family can pay now, from the ledger's lines (oldest due first) and
 * the cash payments they recorded that are still waiting for approval, so
 * the same money is never asked for twice. Pure, so the rules can be tested.
 *
 * The smallest tuition payment is ₹1,000, or all the tuition left when that
 * is less — counted before the waiting cash payments: a record that may yet
 * be withdrawn or declined never makes a smaller payment possible.
 */
export function familyPayable(lines: Pick<LedgerCharge, "id" | "kind" | "outstanding" | "dueOn">[], pending: PendingCash[], today: string): FamilyPayable {
  const pendingAdmission = pending.reduce((a, p) => a + Math.max(0, Math.min(p.admissionAmount, p.amount)), 0);
  const pendingTuition = pending.reduce((a, p) => a + Math.max(0, p.amount - Math.max(0, p.admissionAmount)), 0);
  const open = lines.filter((l) => l.outstanding > 0);
  const admission = open.filter(isAdmissionLine);
  const tuition = open.filter((l) => !isAdmissionLine(l));
  const admissionLeft = admission.reduce((a, l) => a + l.outstanding, 0) - pendingAdmission;
  const tuitionOpen = tuition.reduce((a, l) => a + l.outstanding, 0);
  const tuitionLeft = tuitionOpen - pendingTuition;
  const tuitionDue = tuition.filter((l) => l.dueOn <= today).reduce((a, l) => a + l.outstanding, 0) - pendingTuition;
  const min = Math.min(MIN_TUITION_PAYMENT, tuitionOpen);
  const canPay = tuitionLeft > 0 && tuitionLeft >= min;
  return {
    admission: admissionLeft > 0 ? { amount: admissionLeft, chargeIds: admission.map((l) => l.id) } : null,
    tuition: canPay ? { min, max: tuitionLeft, dueNow: Math.max(0, Math.min(tuitionDue, tuitionLeft)), chargeIds: tuition.map((l) => l.id) } : null,
    pending: { admission: pendingAdmission, tuition: pendingTuition },
    held: tuitionLeft > 0 && !canPay ? tuitionLeft : 0,
  };
}

/** What the family chose: the admission fee (yes or no) and a tuition amount in paise (0 = none). */
export type FamilyChoice = { admission: boolean; tuition: number };

export type ChoiceProblem = "nothing" | "admission_gone" | "tuition_gone" | "tuition_small" | "tuition_large";

export type CheckedChoice = {
  amount: number;
  admissionAmount: number;
  tuitionAmount: number;
  /** The lines to pay, in order: the admission fee first (when chosen), then tuition, oldest first. */
  chargeIds: string[];
};

/** Check a family's choice against what they can pay (familyPayable). */
export function checkFamilyChoice(p: FamilyPayable, c: FamilyChoice): { ok: true; value: CheckedChoice } | { ok: false; problem: ChoiceProblem } {
  if (c.admission && !p.admission) return { ok: false, problem: "admission_gone" };
  const tuition = c.tuition;
  if (!Number.isSafeInteger(tuition) || tuition < 0) return { ok: false, problem: "tuition_small" };
  if (tuition > 0) {
    if (!p.tuition) return { ok: false, problem: "tuition_gone" };
    if (tuition < p.tuition.min) return { ok: false, problem: "tuition_small" };
    if (tuition > p.tuition.max) return { ok: false, problem: "tuition_large" };
  }
  const admissionAmount = c.admission && p.admission ? p.admission.amount : 0;
  if (!admissionAmount && !tuition) return { ok: false, problem: "nothing" };
  return {
    ok: true,
    value: {
      amount: admissionAmount + tuition,
      admissionAmount,
      tuitionAmount: tuition,
      chargeIds: [...(admissionAmount ? p.admission!.chargeIds : []), ...(tuition ? p.tuition!.chargeIds : [])],
    },
  };
}

/** The family's recorded cash payments that are still waiting for approval (this session). */
export async function pendingCashFor(tx: Tx, studentId: string, sessionId: string): Promise<PendingCash[]> {
  return tx
    .select({ amount: cashClaims.amount, admissionAmount: cashClaims.admissionAmount })
    .from(cashClaims)
    .where(and(eq(cashClaims.studentId, studentId), eq(cashClaims.sessionId, sessionId), eq(cashClaims.status, "pending")));
}

/** Ledger lines for many students at once (opening balances screen). */
export async function ledgerLinesFor(tx: Tx, studentIds: string[], sessionId: string): Promise<Map<string, LedgerCharge[]>> {
  const out = new Map<string, LedgerCharge[]>();
  if (!studentIds.length) return out;
  const charges = await tx
    .select()
    .from(studentCharges)
    .where(and(inArray(studentCharges.studentId, studentIds), eq(studentCharges.sessionId, sessionId)))
    .orderBy(asc(studentCharges.dueOn), asc(studentCharges.createdAt));
  const paidBy = await paidByCharge(
    tx,
    charges.map((c) => c.id),
  );
  for (const c of charges) {
    const list = out.get(c.studentId) ?? [];
    list.push(toLine(c, paidBy.get(c.id) ?? 0));
    out.set(c.studentId, list);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Payments and receipts                                               */
/* ------------------------------------------------------------------ */

export function sessionShort(sessionId: string): string {
  return `${sessionId.slice(2, 4)}-${sessionId.slice(5, 7)}`; // "2026-27" → "26-27"
}

async function nextCounter(tx: Tx, key: string): Promise<number> {
  const [row] = await tx
    .insert(counters)
    .values({ key, value: 1 })
    .onConflictDoUpdate({ target: counters.key, set: { value: sql`${counters.value} + 1` } })
    .returning({ value: counters.value });
  return row.value;
}

export async function nextReceiptNo(tx: Tx, schoolId: string, sessionId: string, opening = false): Promise<string> {
  const [s] = await tx.select({ code: schools.code }).from(schools).where(eq(schools.id, schoolId));
  const n = await nextCounter(tx, `receipt:${schoolId}:${sessionId}${opening ? ":opening" : ""}`);
  return `${s.code}/${sessionShort(sessionId)}/${opening ? "OB" : ""}${String(n).padStart(5, "0")}`;
}

/** A refund's voucher number, from its own per-school, per-session counter: "ARY/26-27/RF00001". */
export async function nextRefundVoucherNo(tx: Tx, schoolId: string, sessionId: string): Promise<string> {
  const [s] = await tx.select({ code: schools.code }).from(schools).where(eq(schools.id, schoolId));
  const n = await nextCounter(tx, `refund:${schoolId}:${sessionId}`);
  return `${s.code}/${sessionShort(sessionId)}/RF${String(n).padStart(5, "0")}`;
}

export type Allocation = { chargeId: string; amount: number };

/**
 * Split an amount across open fee lines: the lines in `preferred` first, in
 * that order, then the others in the order given (oldest due first). Returns
 * the split and what is left over when the amount is more than is due.
 */
export function allocate(open: { id: string; outstanding: number }[], amount: number, preferred: string[] = []): { allocations: Allocation[]; excess: number } {
  const byId = new Map(open.map((l) => [l.id, l]));
  const first = [...new Set(preferred)].map((id) => byId.get(id)).filter((l): l is { id: string; outstanding: number } => !!l);
  const chosen = new Set(first.map((l) => l.id));
  const allocations: Allocation[] = [];
  let left = amount;
  for (const l of [...first, ...open.filter((x) => !chosen.has(x.id))]) {
    if (left <= 0) break;
    const take = Math.min(left, l.outstanding);
    if (take > 0) allocations.push({ chargeId: l.id, amount: take });
    left -= take;
  }
  return { allocations, excess: Math.max(0, left) };
}

export type PaymentInput = {
  schoolId: string;
  studentId: string;
  sessionId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string | null;
  paidOn: string;
  /** Pay these charges first, in this order (online orders, approved family cash); anything left goes to the oldest dues. */
  chargeIds?: string[];
  /** An exact split across fee lines (opening balances). Must add up to `amount`. */
  allocations?: Allocation[];
  /**
   * Online payments only: money the gateway has already taken is recorded even
   * if it is more than is now due; the extra stays unallocated so the office
   * can refund it.
   */
  allowExcess?: boolean;
  provider?: string | null;
  providerPaymentId?: string | null;
  orderId?: string | null;
};

export class PaymentError extends Error {}

/** Lock the student's row for the rest of the transaction (serialises money changes per student). */
export async function lockStudent(tx: Tx, studentId: string, schoolId: string): Promise<{ id: string; name: string; rte: boolean }> {
  const [s] = await tx
    .select({ id: students.id, name: students.name, rte: students.rte })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)))
    .for("update");
  if (!s) throw new PaymentError("Student not found.");
  return s;
}

/** Lock several students at once, always in the same (id) order, so batches never deadlock each other. */
async function lockStudents(tx: Tx, studentIds: string[], schoolId: string): Promise<Map<string, { id: string; name: string; rte: boolean }>> {
  const ids = [...new Set(studentIds)].sort();
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ id: students.id, name: students.name, rte: students.rte })
    .from(students)
    .where(and(inArray(students.id, ids), eq(students.schoolId, schoolId)))
    .orderBy(asc(students.id))
    .for("update");
  if (rows.length !== ids.length) throw new PaymentError("Student not found.");
  return new Map(rows.map((r) => [r.id, r]));
}

export async function recordPayment(tx: Tx, input: PaymentInput, actor: AuditActor): Promise<{ id: string; receiptNo: string; excess: number }> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new PaymentError("Enter an amount greater than zero.");
  if (!isValidIsoDate(input.paidOn)) throw new PaymentError("Enter the date the money was received.");
  if (input.paidOn > todayIST()) throw new PaymentError("The payment date can't be in the future.");
  if (!(input.method in METHOD_LABELS)) throw new PaymentError("Choose how the fee was paid.");
  await lockStudent(tx, input.studentId, input.schoolId);

  const { lines } = await ledger(tx, input.studentId, input.sessionId);
  const open = lines.filter((l) => l.outstanding > 0);
  const totalOutstanding = open.reduce((a, l) => a + l.outstanding, 0);

  let allocations: Allocation[] = [];
  let excess = 0;
  if (input.allocations) {
    const byId = new Map(open.map((l) => [l.id, l]));
    const seen = new Set<string>();
    let sum = 0;
    for (const a of input.allocations) {
      const l = byId.get(a.chargeId);
      if (!l || seen.has(a.chargeId) || !Number.isSafeInteger(a.amount) || a.amount <= 0 || a.amount > l.outstanding) {
        throw new PaymentError("A fee line in this payment is no longer due, or the amount is more than its balance. Reload the page and try again.");
      }
      seen.add(a.chargeId);
      sum += a.amount;
      allocations.push({ chargeId: a.chargeId, amount: a.amount });
    }
    if (sum !== input.amount) throw new PaymentError("The amounts for the fee lines don't add up to the payment.");
  } else {
    if (input.amount > totalOutstanding && !input.allowExcess) {
      throw new PaymentError(
        totalOutstanding > 0
          ? `The amount is more than the ${rupees(totalOutstanding)} still due for this session.`
          : "Nothing is due for this session, so no payment can be recorded.",
      );
    }
    ({ allocations, excess } = allocate(open, input.amount, input.chargeIds ?? []));
  }

  const opening = input.method === "opening";
  const receiptNo = await nextReceiptNo(tx, input.schoolId, input.sessionId, opening);
  const [p] = await tx
    .insert(payments)
    .values({
      schoolId: input.schoolId,
      studentId: input.studentId,
      sessionId: input.sessionId,
      amount: input.amount,
      method: input.method,
      reference: input.reference?.trim() || null,
      paidOn: input.paidOn,
      receiptNo,
      recordedBy: input.provider ? null : actor.accountId,
      provider: input.provider ?? null,
      providerPaymentId: input.providerPaymentId ?? null,
      orderId: input.orderId ?? null,
    })
    .returning({ id: payments.id });
  if (allocations.length) await tx.insert(paymentAllocations).values(allocations.map((a) => ({ paymentId: p.id, ...a })));
  await audit(tx, actor, opening ? "fees.opening_balance" : input.method === "online" ? "fees.online_payment" : "fees.payment", {
    schoolId: input.schoolId,
    targetType: "payment",
    targetId: p.id,
    details: {
      receiptNo,
      amount: input.amount,
      method: input.method,
      studentId: input.studentId,
      paidOn: input.paidOn,
      ...(input.providerPaymentId ? { providerPaymentId: input.providerPaymentId, orderId: input.orderId } : {}),
      ...(excess ? { unallocated: excess } : {}),
    },
  });
  if (excess) {
    await audit(tx, actor, "fees.online_excess", {
      schoolId: input.schoolId,
      targetType: "payment",
      targetId: p.id,
      details: { receiptNo, excess, note: "Paid online for fees that were already settled. Refund the extra through the payment gateway." },
    });
  }
  // The family gets a text message with the amount and receipt number (never for opening balances).
  await queuePayment(tx, { schoolId: input.schoolId, paymentId: p.id, studentId: input.studentId, amount: input.amount, paidOn: input.paidOn, receiptNo, method: input.method, createdBy: actor.accountId });
  return { id: p.id, receiptNo, excess };
}

/** Cancel a payment (for example a bounced cheque). The receipt stays on record, marked cancelled. */
export async function reversePayment(tx: Tx, paymentId: string, schoolId: string, reason: string, actor: AuditActor): Promise<void> {
  const note = reason.trim();
  if (!note) throw new PaymentError("Write why the payment is being reversed (for example “Cheque bounced”).");
  const [p] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.schoolId, schoolId)));
  if (!p) throw new PaymentError("Payment not found.");
  await lockStudent(tx, p.studentId, schoolId);
  // Read the status again now that the student is locked: two people cancelling the same receipt at once cancel it once.
  const [now] = await tx.select({ status: payments.status }).from(payments).where(eq(payments.id, paymentId)).for("update");
  if (!now || now.status === "reversed") return;
  if (p.method === "online") throw new PaymentError("Online payments can't be cancelled here. Refund them in the Razorpay Dashboard (the receipt stays on record).");
  const [refunded] = await tx
    .select({ id: paymentRefunds.id })
    .from(paymentRefunds)
    .where(and(eq(paymentRefunds.paymentId, paymentId), eq(paymentRefunds.status, "completed")))
    .limit(1);
  if (refunded) throw new PaymentError("Money has already been refunded on this receipt, so it can't be cancelled. Record any further money given back as a refund.");
  await tx.update(payments).set({ status: "reversed", reversalNote: note }).where(eq(payments.id, paymentId));
  await audit(tx, actor, "fees.payment_reversed", {
    schoolId,
    targetType: "payment",
    targetId: paymentId,
    details: { reason: note, receiptNo: p.receiptNo, amount: p.amount, method: p.method, studentId: p.studentId },
  });
  // Withdraws the receipt message if it hasn't gone yet; otherwise tells the family the receipt is cancelled.
  await queuePaymentCancelled(tx, { schoolId, paymentId, studentId: p.studentId, amount: p.amount, receiptNo: p.receiptNo, createdBy: actor.accountId });
}

/* ------------------------------------------------------------------ */
/* Waivers and the admission fee (administrators)                      */
/* ------------------------------------------------------------------ */

async function chargeInSchool(tx: Tx, chargeId: string, schoolId: string, sessionId: string, studentId?: string) {
  if (!isUuid(chargeId)) throw new PaymentError("That fee line was not found.");
  const [c] = await tx
    .select()
    .from(studentCharges)
    .where(and(eq(studentCharges.id, chargeId), eq(studentCharges.schoolId, schoolId), eq(studentCharges.sessionId, sessionId)));
  if (!c || (studentId && c.studentId !== studentId)) throw new PaymentError("That fee line was not found.");
  return c;
}

/** Waive what is still due on a line (the part already paid stays paid). */
export async function waiveCharge(
  tx: Tx,
  input: { schoolId: string; sessionId: string; chargeId: string; studentId?: string; note: string },
  actor: AuditActor,
): Promise<{ waived: number }> {
  const note = input.note.trim();
  if (!note) throw new PaymentError("Write why this fee is being waived.");
  const c = await chargeInSchool(tx, input.chargeId, input.schoolId, input.sessionId, input.studentId);
  await lockStudent(tx, c.studentId, input.schoolId);
  if (c.waived) throw new PaymentError("This fee line is already waived.");
  const paid = (await paidByCharge(tx, [c.id])).get(c.id) ?? 0;
  const balance = c.amount - paid;
  if (balance <= 0) throw new PaymentError("This fee line is already paid in full, so there is nothing to waive.");
  await tx.update(studentCharges).set({ waived: true, waiverNote: note }).where(eq(studentCharges.id, c.id));
  await audit(tx, actor, "fees.charge_waived", {
    schoolId: input.schoolId,
    targetType: "student_charge",
    targetId: c.id,
    details: { studentId: c.studentId, label: c.label, amount: c.amount, waived: balance, note },
  });
  return { waived: balance };
}

/** Undo a waiver made by mistake. RTE-seat lines stay waived (the RTE flag on the student controls them). */
export async function restoreCharge(tx: Tx, input: { schoolId: string; sessionId: string; chargeId: string; studentId?: string }, actor: AuditActor): Promise<void> {
  const c = await chargeInSchool(tx, input.chargeId, input.schoolId, input.sessionId, input.studentId);
  const s = await lockStudent(tx, c.studentId, input.schoolId);
  if (!c.waived) throw new PaymentError("This fee line is not waived.");
  if (s.rte || isRteWaiver(c.waiverNote)) throw new PaymentError("RTE-seat students are not charged fees. If the RTE status is wrong, correct it in the student's record.");
  await tx.update(studentCharges).set({ waived: false, waiverNote: null }).where(eq(studentCharges.id, c.id));
  await audit(tx, actor, "fees.charge_restored", {
    schoolId: input.schoolId,
    targetType: "student_charge",
    targetId: c.id,
    details: { studentId: c.studentId, label: c.label, previousNote: c.waiverNote },
  });
}

/** Was the student admitted during this session (so the one-time admission fee applies)? */
export async function admittedInSession(tx: Tx, studentId: string, sessionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ admittedOn: students.admittedOn, startsOn: academicSessions.startsOn, endsOn: academicSessions.endsOn })
    .from(students)
    .innerJoin(academicSessions, eq(academicSessions.id, sessionId))
    .where(eq(students.id, studentId));
  return !!row?.admittedOn && row.admittedOn >= row.startsOn && row.admittedOn <= row.endsOn;
}

export async function hasAdmissionCharge(tx: Tx, studentId: string): Promise<boolean> {
  const [c] = await tx
    .select({ id: studentCharges.id })
    .from(studentCharges)
    .where(and(eq(studentCharges.studentId, studentId), eq(studentCharges.kind, "admission")))
    .limit(1);
  return !!c;
}

/** Add the approved one-time admission fee for a student admitted this session (once). */
export async function addAdmissionFee(tx: Tx, input: { schoolId: string; sessionId: string; studentId: string }, actor: AuditActor): Promise<void> {
  await lockStudent(tx, input.studentId, input.schoolId);
  if (await hasAdmissionCharge(tx, input.studentId)) throw new PaymentError("This student already has an admission fee line.");
  if (!(await admittedInSession(tx, input.studentId, input.sessionId))) {
    throw new PaymentError("The admission fee is only for students admitted in this session. Check the admission date in the student's record.");
  }
  const [enrolled] = await tx
    .select({ id: enrolments.id })
    .from(enrolments)
    .where(and(eq(enrolments.studentId, input.studentId), eq(enrolments.sessionId, input.sessionId)));
  if (!enrolled) throw new PaymentError("Place the student in a class for this session first.");
  await addAdmissionCharge(tx, input.studentId, input.sessionId, actor);
  const [created] = await tx
    .select()
    .from(studentCharges)
    .where(and(eq(studentCharges.studentId, input.studentId), eq(studentCharges.kind, "admission")));
  if (!created) throw new PaymentError("The school's fee plan has no admission fee.");
  await audit(tx, actor, "fees.admission_fee_added", {
    schoolId: input.schoolId,
    targetType: "student_charge",
    targetId: created.id,
    details: { studentId: input.studentId, amount: created.amount, waived: created.waived },
  });
}

/* ------------------------------------------------------------------ */
/* Opening balances (fees paid on paper before the portal)             */
/* ------------------------------------------------------------------ */

export type OpeningEntry = {
  chargeId: string;
  /** "full": the line was paid in full on paper; a number: the total paid on paper so far (paise). */
  paid: "full" | number;
};

export class OpeningError extends PaymentError {
  constructor(
    message: string,
    public chargeId: string,
  ) {
    super(message);
  }
}

/**
 * Record what families already paid on paper, as "opening" payments with
 * OB receipt numbers — one receipt per student per save. Idempotent: each
 * line is brought up to the stated total, so saving the same screen twice
 * records nothing new, and a line that is already paid is never paid again.
 */
export async function recordOpeningBalances(
  tx: Tx,
  input: { schoolId: string; sessionId: string; paidOn: string; reference?: string | null; entries: OpeningEntry[]; section?: { id: string; label: string } },
  actor: AuditActor,
): Promise<{ receipts: { studentId: string; paymentId: string; receiptNo: string; amount: number }[]; total: number; alreadyPaid: number; waived: number }> {
  const ids = [...new Set(input.entries.map((e) => e.chargeId))];
  if (!ids.length) throw new PaymentError("Tick at least one line, or enter an amount paid.");
  if (!ids.every(isUuid)) throw new PaymentError("Some fee lines were not found. Reload the page and try again.");
  const charges = await tx
    .select({ id: studentCharges.id, studentId: studentCharges.studentId })
    .from(studentCharges)
    .where(and(inArray(studentCharges.id, ids), eq(studentCharges.schoolId, input.schoolId), eq(studentCharges.sessionId, input.sessionId)));
  if (charges.length !== ids.length) throw new PaymentError("Some fee lines were not found. Reload the page and try again.");
  const studentOf = new Map(charges.map((c) => [c.id, c.studentId]));

  const byStudent = new Map<string, OpeningEntry[]>();
  for (const e of input.entries) {
    const sid = studentOf.get(e.chargeId)!;
    const list = byStudent.get(sid) ?? [];
    if (!list.some((x) => x.chargeId === e.chargeId)) list.push(e);
    byStudent.set(sid, list);
  }

  const receipts: { studentId: string; paymentId: string; receiptNo: string; amount: number }[] = [];
  let alreadyPaid = 0;
  let waived = 0;
  const locked = await lockStudents(tx, [...byStudent.keys()], input.schoolId);
  for (const [studentId, entries] of byStudent) {
    const s = locked.get(studentId)!;
    const { lines } = await ledger(tx, studentId, input.sessionId);
    const allocations: Allocation[] = [];
    for (const e of entries) {
      const l = lines.find((x) => x.id === e.chargeId)!;
      if (l.waived) {
        waived++;
        continue;
      }
      if (e.paid !== "full" && (!Number.isSafeInteger(e.paid) || e.paid <= 0)) {
        throw new OpeningError(`Check the amount for ${s.name} — ${l.label}.`, l.id);
      }
      if (e.paid !== "full" && e.paid > l.amount) {
        throw new OpeningError(`${s.name}: ${rupees(e.paid)} is more than the ${rupees(l.amount)} fee for ${l.label}.`, l.id);
      }
      const target = e.paid === "full" ? l.amount : e.paid;
      const delta = Math.min(target - l.paid, l.outstanding);
      if (delta <= 0) {
        alreadyPaid++;
        continue;
      }
      allocations.push({ chargeId: l.id, amount: delta });
    }
    if (!allocations.length) continue;
    const amount = allocations.reduce((a, x) => a + x.amount, 0);
    const r = await recordPayment(
      tx,
      {
        schoolId: input.schoolId,
        studentId,
        sessionId: input.sessionId,
        amount,
        method: "opening",
        reference: input.reference?.trim() || "Paid before the portal (paper receipt)",
        paidOn: input.paidOn,
        allocations,
      },
      actor,
    );
    receipts.push({ studentId, paymentId: r.id, receiptNo: r.receiptNo, amount });
  }
  const total = receipts.reduce((a, r) => a + r.amount, 0);
  await audit(tx, actor, "fees.opening_batch", {
    schoolId: input.schoolId,
    targetType: "session",
    targetId: input.sessionId,
    details: {
      receipts: receipts.length,
      total,
      alreadyPaid,
      waived,
      paidOn: input.paidOn,
      ...(input.section ? { sectionId: input.section.id, section: input.section.label } : {}),
    },
  });
  return { receipts, total, alreadyPaid, waived };
}

/** The activity-log entry saying nobody in a section paid fees on paper before the portal. */
export const OPENING_NONE_ACTION = "fees.opening_none";

/**
 * Record that nobody in a class (section) paid this session's fees on paper
 * before the portal, so it has no opening balances to enter. Nothing about
 * money changes: the Opening balances page and the office's "Getting
 * started" steps count the class as done (lib/queries/home.ts).
 */
export async function markNoOpeningBalances(tx: Tx, input: { schoolId: string; sessionId: string; sectionId: string; sectionLabel: string }, actor: AuditActor): Promise<void> {
  const [sec] = isUuid(input.sectionId)
    ? await tx
        .select({ id: sections.id })
        .from(sections)
        .innerJoin(classes, eq(classes.id, sections.classId))
        .where(and(eq(sections.id, input.sectionId), eq(sections.sessionId, input.sessionId), eq(classes.schoolId, input.schoolId)))
    : [];
  if (!sec) throw new PaymentError("That class was not found. Reload the page and try again.");
  await audit(tx, actor, OPENING_NONE_ACTION, {
    schoolId: input.schoolId,
    targetType: "section",
    targetId: sec.id,
    details: { sessionId: input.sessionId, section: input.sectionLabel },
  });
}

/* ------------------------------------------------------------------ */
/* Instalment split (administrators, before any payment)               */
/* ------------------------------------------------------------------ */

export async function paymentsInSession(tx: Tx, schoolId: string, sessionId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<string>`count(*)`.mapWith(Number) })
    .from(payments)
    .where(and(eq(payments.schoolId, schoolId), eq(payments.sessionId, sessionId)));
  return row?.n ?? 0;
}

/**
 * Change the instalment percentages and due dates of the current plan and
 * regenerate every student's instalment lines. Allowed only while no payment
 * (of any kind, even a cancelled one) exists for the session: after that the
 * receipts would no longer match the lines they paid. Amounts can't change here.
 */
export async function changeInstalmentSplit(
  tx: Tx,
  input: { schoolId: string; sessionId: string; instalments: { id: string; percent: number; dueOn: string }[] },
  actor: AuditActor,
): Promise<{ students: number }> {
  const plan = await currentPlan(tx, input.schoolId);
  if (!plan) throw new PaymentError("This school has no fee plan.");
  const [session] = await tx.select().from(academicSessions).where(eq(academicSessions.id, input.sessionId));
  if (!session) throw new PaymentError("Session not found.");
  if (input.instalments.length !== plan.instalments.length || !plan.instalments.every((i) => input.instalments.some((x) => x.id === i.id))) {
    throw new PaymentError("The fee plan has changed since this page was opened. Reload the page and try again.");
  }
  const ordered = plan.instalments.map((ins) => ({ ins, next: input.instalments.find((x) => x.id === ins.id)! }));
  for (const { ins, next } of ordered) {
    if (!Number.isInteger(next.percent) || next.percent < 1 || next.percent > 100) throw new PaymentError(`${ins.label}: enter a whole-number percentage from 1 to 100.`);
    if (!isValidIsoDate(next.dueOn) || next.dueOn < session.startsOn || next.dueOn > session.endsOn) {
      throw new PaymentError(`${ins.label}: choose a due date within the ${input.sessionId} session.`);
    }
  }
  const total = ordered.reduce((a, o) => a + o.next.percent, 0);
  if (total !== 100) throw new PaymentError(`The instalments add up to ${total}%. They must add up to exactly 100%.`);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].next.dueOn <= ordered[i - 1].next.dueOn) throw new PaymentError(`${ordered[i].ins.label} must fall due after ${ordered[i - 1].ins.label}.`);
  }

  // Hold off new payments until this finishes, so "no payment yet" stays true while the lines are replaced.
  await tx.execute(sql`lock table ${payments} in share row exclusive mode`);
  const paid = await paymentsInSession(tx, input.schoolId, input.sessionId);
  if (paid) throw new PaymentError(`The split is locked: ${paid} payment${paid === 1 ? " has" : "s have"} already been recorded for ${input.sessionId}.`);
  // Online payments that are still open would point at lines about to be replaced.
  const cutoff = new Date(Date.now() - 30 * 60_000);
  const [openOrder] = await tx
    .select({ id: paymentOrders.id })
    .from(paymentOrders)
    .where(and(eq(paymentOrders.schoolId, input.schoolId), eq(paymentOrders.status, "created"), gte(paymentOrders.createdAt, cutoff)))
    .limit(1);
  if (openOrder) throw new PaymentError("A family is paying online right now. Please try again in half an hour.");
  await tx
    .update(paymentOrders)
    .set({ status: "expired", failureReason: "Fee plan changed" })
    .where(and(eq(paymentOrders.schoolId, input.schoolId), eq(paymentOrders.status, "created")));

  const before = plan.instalments.map((i) => ({ label: i.label, percent: i.percent, due: i.dueMonthDay }));
  for (const { ins, next } of ordered) {
    await tx
      .update(feeInstalments)
      .set({ percent: next.percent, dueMonthDay: next.dueOn.slice(5) })
      .where(and(eq(feeInstalments.id, ins.id), eq(feeInstalments.planId, plan.id)));
  }

  // Keep waivers an administrator made by hand (RTE lines are recreated from the student's RTE flag).
  const old = await tx
    .select({ studentId: studentCharges.studentId, label: studentCharges.label, waived: studentCharges.waived, waiverNote: studentCharges.waiverNote })
    .from(studentCharges)
    .where(and(eq(studentCharges.schoolId, input.schoolId), eq(studentCharges.sessionId, input.sessionId), eq(studentCharges.kind, "instalment")));
  const manual = old
    .filter((c) => c.waived && !isRteWaiver(c.waiverNote))
    .map((c) => ({ ...c, ins: plan.instalments.find((i) => isLineOf(i, c.label)) }))
    .filter((c) => c.ins);
  await tx.delete(studentCharges).where(and(eq(studentCharges.schoolId, input.schoolId), eq(studentCharges.sessionId, input.sessionId), eq(studentCharges.kind, "instalment")));

  const enrolled = await tx
    .select({ studentId: enrolments.studentId })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(and(eq(students.schoolId, input.schoolId), eq(enrolments.sessionId, input.sessionId)));
  for (const e of enrolled) await ensureSessionCharges(tx, e.studentId, input.sessionId, actor);
  for (const m of manual) {
    await tx
      .update(studentCharges)
      .set({ waived: true, waiverNote: m.waiverNote })
      .where(
        and(
          eq(studentCharges.studentId, m.studentId),
          eq(studentCharges.sessionId, input.sessionId),
          eq(studentCharges.kind, "instalment"),
          sql`${studentCharges.label} like ${lineLikePattern(m.ins!)}`,
        ),
      );
  }

  await audit(tx, actor, "fees.plan_split_changed", {
    schoolId: input.schoolId,
    targetType: "fee_plan",
    targetId: plan.id,
    details: { before, after: ordered.map((o) => ({ label: o.ins.label, percent: o.next.percent, due: o.next.dueOn.slice(5) })), students: enrolled.length },
  });
  return { students: enrolled.length };
}

/* ------------------------------------------------------------------ */
/* Reads for pages and dashboards                                      */
/* ------------------------------------------------------------------ */

/** Every fee line of a school's session with what has been paid on it (less refunds). */
async function schoolChargeLines(tx: Tx, schoolId: string, sessionId: string) {
  const paidSq = tx
    .select({ chargeId: paymentAllocations.chargeId, paid: sql<string>`sum(${paymentAllocations.amount})`.as("paid") })
    .from(paymentAllocations)
    .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
    .where(and(eq(payments.status, "completed"), eq(payments.schoolId, schoolId), eq(payments.sessionId, sessionId)))
    .groupBy(paymentAllocations.chargeId)
    .as("paid_sq");
  const refundSq = tx
    .select({ chargeId: refundAllocations.chargeId, refunded: sql<string>`sum(${refundAllocations.amount})`.as("refunded") })
    .from(refundAllocations)
    .innerJoin(paymentRefunds, eq(paymentRefunds.id, refundAllocations.refundId))
    .where(and(eq(paymentRefunds.schoolId, schoolId), eq(paymentRefunds.sessionId, sessionId), eq(paymentRefunds.status, "completed")))
    .groupBy(refundAllocations.chargeId)
    .as("refund_sq");
  return tx
    .select({
      id: studentCharges.id,
      studentId: studentCharges.studentId,
      amount: studentCharges.amount,
      dueOn: studentCharges.dueOn,
      waived: studentCharges.waived,
      paid: sql<string>`coalesce(${paidSq.paid}, 0) - coalesce(${refundSq.refunded}, 0)`.mapWith(Number),
    })
    .from(studentCharges)
    .leftJoin(paidSq, eq(paidSq.chargeId, studentCharges.id))
    .leftJoin(refundSq, eq(refundSq.chargeId, studentCharges.id))
    .where(and(eq(studentCharges.schoolId, schoolId), eq(studentCharges.sessionId, sessionId)));
}

/**
 * A school's session in figures. `collected` is net of refunds (money
 * received less money given back); `collectedToday` is the money received
 * today (not opening balances), and `refundedToday` what was given back today;
 * `refunded` is everything given back this session.
 */
export type FeeTotals = { charged: number; collected: number; outstanding: number; overdue: number; collectedToday: number; refunded: number; refundedToday: number };

export async function feeTotals(tx: Tx, schoolId: string, sessionId: string): Promise<FeeTotals> {
  const today = todayIST();
  const lines = await schoolChargeLines(tx, schoolId, sessionId);
  let charged = 0;
  let outstanding = 0;
  let overdue = 0;
  for (const l of lines) {
    const out = l.waived ? 0 : Math.max(0, l.amount - l.paid);
    charged += effectiveCharge(l);
    outstanding += out;
    if (l.dueOn < today) overdue += out;
  }
  const [[c], [r]] = await Promise.all([
    tx
      .select({
        collected: sql<string>`coalesce(sum(${payments.amount}), 0)`.mapWith(Number),
        today: sql<string>`coalesce(sum(case when ${payments.paidOn} = ${today} and ${payments.method} <> 'opening' then ${payments.amount} else 0 end), 0)`.mapWith(Number),
      })
      .from(payments)
      .where(and(eq(payments.schoolId, schoolId), eq(payments.sessionId, sessionId), eq(payments.status, "completed"))),
    tx
      .select({
        refunded: sql<string>`coalesce(sum(${paymentRefunds.amount}), 0)`.mapWith(Number),
        today: sql<string>`coalesce(sum(case when ${paymentRefunds.refundedOn} = ${today} then ${paymentRefunds.amount} else 0 end), 0)`.mapWith(Number),
      })
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.schoolId, schoolId), eq(paymentRefunds.sessionId, sessionId), eq(paymentRefunds.status, "completed"))),
  ]);
  const refunded = r?.refunded ?? 0;
  return { charged, collected: (c?.collected ?? 0) - refunded, outstanding, overdue, collectedToday: c?.today ?? 0, refunded, refundedToday: r?.today ?? 0 };
}

/**
 * For office dashboards: the session's fee position for a school.
 * `collected` includes opening balances, less refunds; `collectedToday`
 * counts only money received today (not opening balances brought forward),
 * and `refundedToday` what was given back today.
 */
export async function schoolFeeTotals(schoolId: string, sessionId: string): Promise<FeeTotals> {
  return feeTotals(await getDb(), schoolId, sessionId);
}

export type FamilyFeeSummary = {
  /** Still to pay on lines due today or earlier. */
  dueNow: number;
  /** Still to pay on lines whose due date has passed. */
  overdue: number;
  /** The next line falling due after today that is not yet paid (null when none). */
  nextDue: { label: string; labelHi: string; dueOn: string; amount: number } | null;
  paidThisSession: number;
  /** In cash payments the family recorded that are waiting for the school's approval. */
  waitingCash: number;
};

/** For the family dashboard: what is due now, what is next, and what has been paid. */
export async function familyFeeSummary(studentId: string, sessionId: string): Promise<FamilyFeeSummary> {
  const db = await getDb();
  const [{ lines, totals }, waiting] = await Promise.all([ledger(db, studentId, sessionId), pendingCashFor(db, studentId, sessionId)]);
  const today = todayIST();
  const next = lines.filter((l) => l.outstanding > 0 && l.dueOn > today).sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0];
  return {
    dueNow: totals.dueNow,
    overdue: totals.overdue,
    nextDue: next ? { label: next.label, labelHi: next.labelHi, dueOn: next.dueOn, amount: next.outstanding } : null,
    paidThisSession: totals.paid,
    waitingCash: waiting.reduce((a, w) => a + w.amount, 0),
  };
}

export type StudentFeeRow = {
  studentId: string;
  name: string;
  srNo: string;
  status: "active" | "left" | "transferred" | "passed_out";
  rte: boolean;
  sectionId: string;
  sectionName: string;
  className: string;
  stream: string | null;
  classSort: number;
  rollNo: number | null;
  lines: number;
  charged: number;
  paid: number;
  outstanding: number;
  overdue: number;
  dueNow: number;
};

/** One row per student enrolled in the session, with their fee position. */
export async function schoolFeeRows(tx: Tx, schoolId: string, sessionId: string): Promise<StudentFeeRow[]> {
  const today = todayIST();
  const [enrolled, lines, paidRows, refundRows] = await Promise.all([
    tx
      .select({
        studentId: students.id,
        name: students.name,
        srNo: students.srNo,
        status: students.status,
        rte: students.rte,
        sectionId: sections.id,
        sectionName: sections.name,
        className: classes.name,
        stream: classes.stream,
        classSort: classes.sortOrder,
        rollNo: enrolments.rollNo,
      })
      .from(enrolments)
      .innerJoin(students, eq(students.id, enrolments.studentId))
      .innerJoin(sections, eq(sections.id, enrolments.sectionId))
      .innerJoin(classes, eq(classes.id, sections.classId))
      .where(and(eq(students.schoolId, schoolId), eq(enrolments.sessionId, sessionId))),
    schoolChargeLines(tx, schoolId, sessionId),
    tx
      .select({ studentId: payments.studentId, paid: sql<string>`sum(${payments.amount})`.mapWith(Number) })
      .from(payments)
      .where(and(eq(payments.schoolId, schoolId), eq(payments.sessionId, sessionId), eq(payments.status, "completed")))
      .groupBy(payments.studentId),
    tx
      .select({ studentId: paymentRefunds.studentId, refunded: sql<string>`sum(${paymentRefunds.amount})`.mapWith(Number) })
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.schoolId, schoolId), eq(paymentRefunds.sessionId, sessionId), eq(paymentRefunds.status, "completed")))
      .groupBy(paymentRefunds.studentId),
  ]);
  const refundedBy = new Map(refundRows.map((r) => [r.studentId, r.refunded]));
  const paidBy = new Map(paidRows.map((r) => [r.studentId, r.paid - (refundedBy.get(r.studentId) ?? 0)]));
  const acc = new Map<string, { lines: number; charged: number; outstanding: number; overdue: number; dueNow: number }>();
  for (const l of lines) {
    const a = acc.get(l.studentId) ?? { lines: 0, charged: 0, outstanding: 0, overdue: 0, dueNow: 0 };
    const out = l.waived ? 0 : Math.max(0, l.amount - l.paid);
    a.lines++;
    a.charged += effectiveCharge(l);
    a.outstanding += out;
    if (l.dueOn < today) a.overdue += out;
    if (l.dueOn <= today) a.dueNow += out;
    acc.set(l.studentId, a);
  }
  return enrolled
    .map((e) => {
      const a = acc.get(e.studentId) ?? { lines: 0, charged: 0, outstanding: 0, overdue: 0, dueNow: 0 };
      return { ...e, ...a, paid: paidBy.get(e.studentId) ?? 0 };
    })
    .sort((x, y) => x.classSort - y.classSort || x.sectionName.localeCompare(y.sectionName) || (x.rollNo ?? 9999) - (y.rollNo ?? 9999) || x.name.localeCompare(y.name));
}

/** Display names of the accounts that recorded payments. */
export async function accountNames(tx: Tx, accountIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(accountIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ id: accounts.id, displayName: accounts.displayName, loginId: accounts.loginId, staffName: staff.name })
    .from(accounts)
    .leftJoin(staff, eq(staff.id, accounts.staffId))
    .where(inArray(accounts.id, ids));
  return new Map(rows.map((r) => [r.id, r.staffName ?? r.displayName ?? r.loginId]));
}

export type ReceiptData = {
  id: string;
  schoolId: string;
  studentId: string;
  sessionId: string;
  receiptNo: string;
  paidOn: string;
  amount: number;
  method: PaymentMethod;
  reference: string | null;
  status: "completed" | "reversed";
  reversalNote: string | null;
  provider: string | null;
  providerPaymentId: string | null;
  createdAt: Date;
  school: { id: string; code: string; name: string; nameHi: string; place: string; phone: string | null; email: string | null };
  student: { name: string; srNo: string; fatherName: string | null; className: string | null; sectionName: string | null; stream: string | null; rte: boolean };
  lines: { chargeId: string; label: string; labelHi: string; amount: number; dueOn: string }[];
  /** Paid online beyond what was due (to be refunded, or refunded: see `unallocatedRefunded`). */
  unallocated: number;
  /** How much of `unallocated` has been refunded. */
  unallocatedRefunded: number;
  /** Money given back on this receipt, oldest first (refunds cancelled as mistakes left out). */
  refunds: { id: string; voucherNo: string; amount: number; refundedOn: string; method: "online" | "cash" | "cheque" | "bank"; reference: string | null; note: string; providerRefundId: string | null; recordedByName: string | null }[];
  /** All of `refunds` together. */
  refunded: number;
  recordedByName: string | null;
  reversal: { at: Date; byName: string | null } | null;
};

/** Everything a printed receipt shows. The caller checks who may see it. */
export async function receiptData(tx: Tx, paymentId: string): Promise<ReceiptData | null> {
  if (!isUuid(paymentId)) return null;
  const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId));
  if (!p) return null;
  const [[school], [student], lines, [rev], refunds] = await Promise.all([
    tx.select().from(schools).where(eq(schools.id, p.schoolId)),
    tx
      .select({
        name: students.name,
        srNo: students.srNo,
        fatherName: students.fatherName,
        rte: students.rte,
        className: classes.name,
        sectionName: sections.name,
        stream: classes.stream,
      })
      .from(students)
      .leftJoin(enrolments, and(eq(enrolments.studentId, students.id), eq(enrolments.sessionId, p.sessionId)))
      .leftJoin(sections, eq(sections.id, enrolments.sectionId))
      .leftJoin(classes, eq(classes.id, sections.classId))
      .where(eq(students.id, p.studentId)),
    tx
      .select({ chargeId: studentCharges.id, label: studentCharges.label, labelHi: studentCharges.labelHi, amount: paymentAllocations.amount, dueOn: studentCharges.dueOn })
      .from(paymentAllocations)
      .innerJoin(studentCharges, eq(studentCharges.id, paymentAllocations.chargeId))
      .where(eq(paymentAllocations.paymentId, p.id))
      .orderBy(asc(studentCharges.dueOn), asc(studentCharges.createdAt)),
    p.status === "reversed"
      ? tx
          .select({ at: auditLog.at, actorId: auditLog.actorId })
          .from(auditLog)
          .where(and(eq(auditLog.action, "fees.payment_reversed"), eq(auditLog.targetId, p.id)))
          .orderBy(desc(auditLog.at))
          .limit(1)
      : Promise.resolve([] as { at: Date | null; actorId: string | null }[]),
    tx
      .select()
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.paymentId, p.id), eq(paymentRefunds.status, "completed")))
      .orderBy(asc(paymentRefunds.refundedOn), asc(paymentRefunds.createdAt)),
  ]);
  if (!school || !student) return null;
  const names = await accountNames(tx, [p.recordedBy, rev?.actorId, ...refunds.map((r) => r.recordedBy)]);
  const fromLines = refunds.length
    ? await tx
        .select({ amount: sql<string>`coalesce(sum(${refundAllocations.amount}), 0)`.mapWith(Number) })
        .from(refundAllocations)
        .where(inArray(
          refundAllocations.refundId,
          refunds.map((r) => r.id),
        ))
    : [{ amount: 0 }];
  const refunded = refunds.reduce((a, r) => a + r.amount, 0);
  return {
    id: p.id,
    schoolId: p.schoolId,
    studentId: p.studentId,
    sessionId: p.sessionId,
    receiptNo: p.receiptNo,
    paidOn: p.paidOn,
    amount: p.amount,
    method: p.method,
    reference: p.reference,
    status: p.status,
    reversalNote: p.reversalNote,
    provider: p.provider,
    providerPaymentId: p.providerPaymentId,
    createdAt: p.createdAt,
    school: { id: school.id, code: school.code, name: school.name, nameHi: school.nameHi, place: school.place, phone: school.phone, email: school.email },
    student,
    lines,
    unallocated: p.amount - lines.reduce((a, l) => a + l.amount, 0),
    unallocatedRefunded: refunded - (fromLines[0]?.amount ?? 0),
    refunds: refunds.map((r) => ({
      id: r.id,
      voucherNo: r.voucherNo,
      amount: r.amount,
      refundedOn: r.refundedOn,
      method: r.method,
      reference: r.reference,
      note: r.note,
      providerRefundId: r.providerRefundId,
      recordedByName: r.recordedBy ? (names.get(r.recordedBy) ?? null) : null,
    })),
    refunded,
    recordedByName: p.recordedBy ? (names.get(p.recordedBy) ?? null) : null,
    reversal: p.status === "reversed" ? { at: rev?.at ?? p.createdAt, byName: rev?.actorId ? (names.get(rev.actorId) ?? null) : null } : null,
  };
}

export type CollectionRow = {
  /** A receipt (money received), or a refund (money given back). */
  kind: "receipt" | "refund";
  /** The payment's id, or the refund's. */
  id: string;
  /** The receipt's payment (for refunds: the payment refunded). */
  paymentId: string;
  /** The receipt's number (for refunds: the receipt refunded). */
  receiptNo: string;
  /** Refunds only: the refund's voucher number. */
  voucherNo: string | null;
  /** The receipt's date, or the refund's. */
  paidOn: string;
  /** Always positive: refunds are money paid out. */
  amount: number;
  /** How the money came in, or (refunds) how it was given back ("online": through Razorpay). */
  method: PaymentMethod;
  reference: string | null;
  /** "reversed": a cancelled receipt, or a refund cancelled as a mistake (listed, never counted). */
  status: "completed" | "reversed";
  /** Why a receipt was cancelled, why money was refunded, or why a refund was cancelled. */
  note: string | null;
  /** Razorpay's payment id (receipts) or refund id (refunds). */
  providerId: string | null;
  studentId: string;
  studentName: string;
  srNo: string;
  className: string | null;
  sectionName: string | null;
  recordedByName: string | null;
  createdAt: Date;
};

/** The collections list shows at most this many entries; the totals and the CSV always cover the whole period. */
export const COLLECTION_PAGE_ROWS = 5000;

/**
 * Receipts dated between two days (inclusive), cancelled ones included, and
 * refunds made in those days, in date order. With `limit`, at most that many
 * entries (`truncated` says whether more exist); without it, all of them —
 * the date range is at most a year (collections/range.ts).
 */
export async function collectionRows(
  tx: Tx,
  schoolId: string,
  from: string,
  to: string,
  includeOpening: boolean,
  limit?: number,
): Promise<{ rows: CollectionRow[]; truncated: boolean }> {
  const receiptsQuery = tx
    .select({
      id: payments.id,
      receiptNo: payments.receiptNo,
      paidOn: payments.paidOn,
      amount: payments.amount,
      method: payments.method,
      reference: payments.reference,
      status: payments.status,
      note: payments.reversalNote,
      providerId: payments.providerPaymentId,
      recordedBy: payments.recordedBy,
      studentId: students.id,
      studentName: students.name,
      srNo: students.srNo,
      className: classes.name,
      sectionName: sections.name,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .innerJoin(students, eq(students.id, payments.studentId))
    .leftJoin(enrolments, and(eq(enrolments.studentId, payments.studentId), eq(enrolments.sessionId, payments.sessionId)))
    .leftJoin(sections, eq(sections.id, enrolments.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId))
    .where(and(eq(payments.schoolId, schoolId), gte(payments.paidOn, from), lte(payments.paidOn, to), includeOpening ? undefined : ne(payments.method, "opening")))
    .orderBy(asc(payments.paidOn), asc(payments.createdAt), asc(payments.receiptNo));
  const refundsQuery = tx
    .select({
      id: paymentRefunds.id,
      paymentId: paymentRefunds.paymentId,
      receiptNo: payments.receiptNo,
      voucherNo: paymentRefunds.voucherNo,
      paidOn: paymentRefunds.refundedOn,
      amount: paymentRefunds.amount,
      method: paymentRefunds.method,
      reference: paymentRefunds.reference,
      note: paymentRefunds.note,
      status: paymentRefunds.status,
      cancellationNote: paymentRefunds.cancellationNote,
      providerId: paymentRefunds.providerRefundId,
      recordedBy: paymentRefunds.recordedBy,
      studentId: students.id,
      studentName: students.name,
      srNo: students.srNo,
      className: classes.name,
      sectionName: sections.name,
      createdAt: paymentRefunds.createdAt,
    })
    .from(paymentRefunds)
    .innerJoin(payments, eq(payments.id, paymentRefunds.paymentId))
    .innerJoin(students, eq(students.id, paymentRefunds.studentId))
    .leftJoin(enrolments, and(eq(enrolments.studentId, paymentRefunds.studentId), eq(enrolments.sessionId, paymentRefunds.sessionId)))
    .leftJoin(sections, eq(sections.id, enrolments.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId))
    .where(and(eq(paymentRefunds.schoolId, schoolId), gte(paymentRefunds.refundedOn, from), lte(paymentRefunds.refundedOn, to)))
    .orderBy(asc(paymentRefunds.refundedOn), asc(paymentRefunds.createdAt), asc(paymentRefunds.voucherNo));
  // One more than asked of each list says whether the merged list goes on.
  const [receipts, refunds] = await Promise.all(limit ? [receiptsQuery.limit(limit + 1), refundsQuery.limit(limit + 1)] : [receiptsQuery, refundsQuery]);
  const merged = [
    ...receipts.map((r) => ({ ...r, kind: "receipt" as const, paymentId: r.id, voucherNo: null })),
    ...refunds.map(({ cancellationNote, ...r }) => ({
      ...r,
      kind: "refund" as const,
      note: r.status === "reversed" ? `Refund cancelled: ${cancellationNote ?? ""} (was: ${r.note})` : r.note,
    })),
  ].sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.createdAt.getTime() - b.createdAt.getTime());
  const truncated = limit !== undefined && merged.length > limit;
  const rows = truncated ? merged.slice(0, limit) : merged;
  const names = await accountNames(
    tx,
    rows.map((r) => r.recordedBy),
  );
  return {
    rows: rows.map(({ recordedBy, ...r }) => ({ ...r, recordedByName: recordedBy ? (names.get(recordedBy) ?? null) : null })),
    truncated,
  };
}

export type CollectionTotals = {
  /** Completed receipts, by how the money came in (in METHOD_LABELS order). */
  received: { byMethod: { method: PaymentMethod; count: number; total: number }[]; count: number; total: number };
  /** Refunds made in the period, by how the money was given back. */
  refunded: { byMethod: { method: PaymentMethod; count: number; total: number }[]; count: number; total: number };
  /** Received less refunded. */
  net: number;
  /** Cancelled receipts dated in the period (listed, never counted). */
  cancelled: number;
  /** Refunds cancelled as mistakes, dated in the period (listed, never counted). */
  cancelledRefunds: number;
  /** Every entry the full list has: receipts and refunds, cancelled ones too. */
  entries: number;
};

/** The collections report's totals, added up by the database over the whole period (however long the list is). */
export async function collectionTotals(tx: Tx, schoolId: string, from: string, to: string, includeOpening: boolean): Promise<CollectionTotals> {
  const [receiptRows, refundRows] = await Promise.all([
    tx
      .select({
        method: payments.method,
        status: payments.status,
        n: sql<string>`count(*)`.mapWith(Number),
        total: sql<string>`coalesce(sum(${payments.amount}), 0)`.mapWith(Number),
      })
      .from(payments)
      .where(and(eq(payments.schoolId, schoolId), gte(payments.paidOn, from), lte(payments.paidOn, to), includeOpening ? undefined : ne(payments.method, "opening")))
      .groupBy(payments.method, payments.status),
    tx
      .select({
        method: paymentRefunds.method,
        status: paymentRefunds.status,
        n: sql<string>`count(*)`.mapWith(Number),
        total: sql<string>`coalesce(sum(${paymentRefunds.amount}), 0)`.mapWith(Number),
      })
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.schoolId, schoolId), gte(paymentRefunds.refundedOn, from), lte(paymentRefunds.refundedOn, to)))
      .groupBy(paymentRefunds.method, paymentRefunds.status),
  ]);
  const order = Object.keys(METHOD_LABELS) as PaymentMethod[];
  const tally = (rows: { method: PaymentMethod; n: number; total: number }[]) => {
    const byMethod = order
      .map((method) => {
        const of = rows.filter((r) => r.method === method);
        return { method, count: of.reduce((a, r) => a + r.n, 0), total: of.reduce((a, r) => a + r.total, 0) };
      })
      .filter((m) => m.count > 0);
    return { byMethod, count: byMethod.reduce((a, m) => a + m.count, 0), total: byMethod.reduce((a, m) => a + m.total, 0) };
  };
  const received = tally(receiptRows.filter((r) => r.status === "completed"));
  const refunded = tally(refundRows.filter((r) => r.status === "completed"));
  const cancelled = receiptRows.filter((r) => r.status === "reversed").reduce((a, r) => a + r.n, 0);
  const cancelledRefunds = refundRows.filter((r) => r.status === "reversed").reduce((a, r) => a + r.n, 0);
  return { received, refunded, net: received.total - refunded.total, cancelled, cancelledRefunds, entries: received.count + cancelled + refunded.count + cancelledRefunds };
}

/** Online payments started but not finished, newest first (for the office's warning). */
export async function openOnlineOrders(tx: Tx, studentId: string) {
  const cutoff = new Date(Date.now() - 30 * 60_000);
  return tx
    .select({ id: paymentOrders.id, amount: paymentOrders.amount, createdAt: paymentOrders.createdAt, chargeIds: paymentOrders.chargeIds })
    .from(paymentOrders)
    .where(and(eq(paymentOrders.studentId, studentId), eq(paymentOrders.status, "created"), gte(paymentOrders.createdAt, cutoff)))
    .orderBy(desc(paymentOrders.createdAt));
}

/** The session row (dates) for a session id. */
export async function sessionDates(tx: Tx, sessionId: string) {
  const [s] = await tx.select().from(academicSessions).where(eq(academicSessions.id, sessionId));
  return s ?? null;
}
