import type { Metadata } from "next";
import crypto from "node:crypto";
import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { ArrowLeft, Printer, RefreshCw, Undo2 } from "lucide-react";
import { officePage } from "@/lib/page";
import { FEE_ROLES, OFFICE_ROLES } from "@/lib/roles";
import { getDb } from "@/lib/db/client";
import { classes, enrolments, sections, students } from "@/lib/db/schema";
import { classLabel, sectionLabel } from "@/lib/classes";
import { formatDate, formatDateTime, todayIST } from "@/lib/dates";
import {
  accountNames,
  admittedInSession,
  annualFeeFor,
  hasAdmissionCharge,
  currentPlan,
  isRteWaiver,
  isUuid,
  ledger,
  METHOD_LABELS,
  OFFICE_METHODS,
  openOnlineOrders,
  rupees,
} from "@/lib/services/fees";
import { studentOrders } from "@/lib/services/payments";
import { refundableOf, REFUND_METHOD_LABELS, REFUND_METHODS } from "@/lib/services/refunds";
import { razorpayGateway } from "@/lib/payments";
import { claimChecks, waitingClaims } from "@/lib/services/cash-claims";
import { Flash } from "@/components/flash";
import { APPROVAL_MESSAGES, ClaimCard } from "@/components/fees/claim-card";
import { ActionForm, FieldError } from "@/components/forms";
import { Alert, Badge, ButtonLink, Card, CardTitle, EmptyState, Money, PageHeader, Stat, Table, Td, Textarea, Th } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { annualFeeSentence } from "@/components/fees/annual-fee";
import { LineStatus } from "@/components/fees/status";
import { ClosingDetails, ReceiptLinkFromResult, RefundQuestion, RememberedChoice, RememberedInput } from "@/components/fees/client";
import { addAdmissionFeeAction, cancelRefundAction, checkRazorpayAction, lineAction, recordPaymentAction, refundAction, reversePaymentAction } from "./actions";

export const metadata: Metadata = { title: "Student fees" };

const ORDER_STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  created: { label: "Open", tone: "amber" },
  paid: { label: "Paid", tone: "green" },
  failed: { label: "Not completed", tone: "grey" },
  expired: { label: "Timed out", tone: "grey" },
};

export default async function StudentFeesPage({ params, searchParams }: { params: Promise<{ studentId: string }>; searchParams: Promise<{ done?: string }> }) {
  const { actor, schoolId, sessionId } = await officePage(FEE_ROLES);
  const { studentId } = await params;
  const sp = await searchParams;
  if (!isUuid(studentId)) notFound();
  const db = await getDb();
  const [student] = await db
    .select({
      id: students.id,
      name: students.name,
      srNo: students.srNo,
      rte: students.rte,
      status: students.status,
      fatherName: students.fatherName,
      guardianMobile: students.guardianMobile,
      admittedOn: students.admittedOn,
      sectionName: sections.name,
      className: classes.name,
      stream: classes.stream,
      rollNo: enrolments.rollNo,
    })
    .from(students)
    .leftJoin(enrolments, and(eq(enrolments.studentId, students.id), eq(enrolments.sessionId, sessionId)))
    .leftJoin(sections, eq(sections.id, enrolments.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId))
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)));
  if (!student) notFound();

  const isAdmin = OFFICE_ROLES.includes(actor.role);
  const today = todayIST();
  const [{ lines, payments, refunds, totals }, orders, openOrders, admissionCharged, admitted, plan, claims] = await Promise.all([
    ledger(db, studentId, sessionId),
    studentOrders(db, studentId),
    openOnlineOrders(db, studentId),
    hasAdmissionCharge(db, studentId),
    admittedInSession(db, studentId, sessionId),
    currentPlan(db, schoolId),
    waitingClaims(db, schoolId, { studentId }),
  ]);
  const checks = await claimChecks(db, claims);
  const names = await accountNames(db, [...payments.map((p) => p.recordedBy), ...refunds.map((r) => r.recordedBy)]);
  const refundsOf = (paymentId: string) => refunds.filter((r) => r.paymentId === paymentId);
  // Refunds cancelled as mistakes are listed, but never count.
  const refundedOn = (paymentId: string) => refundsOf(paymentId).filter((r) => r.status === "completed").reduce((a, r) => a + r.amount, 0);
  // Razorpay orders not paid: the office can ask Razorpay about them at once. (The form stays
  // mounted once they are all paid, so the message saying what was found survives the refresh.)
  const razorpayOrders = razorpayGateway.isConfigured() && orders.some((o) => o.provider === "razorpay");
  const checkable = razorpayOrders && orders.some((o) => o.provider === "razorpay" && o.status !== "paid");
  const admissionFee = plan?.oneTime.find((o) => o.key === "admission");
  // Shown to administrators for this session's new admissions; stays mounted after adding, so the confirmation is visible.
  const showAdmission = isAdmin && admitted && !!student.className && !!admissionFee;
  const suggested = totals.dueNow || totals.outstanding;
  const placed = student.className ? sectionLabel(student.className, student.sectionName ?? "") : null;
  const receiptCount = payments.filter((p) => p.status === "completed").length;
  // What was waived on each line (the part not paid before the waiver), so the table adds up to "Charged".
  const waivedOf = (l: (typeof lines)[number]) => (l.waived ? l.amount - Math.min(l.paid, l.amount) : 0);
  const feesTotal = lines.reduce((a, l) => a + l.amount, 0);
  const anyWaived = lines.some((l) => waivedOf(l) > 0);
  // RTE seat recorded after some fees were paid: they stay on record.
  const paidBeforeRte = student.rte ? lines.reduce((a, l) => a + Math.min(l.paid, l.amount), 0) : 0;
  const reversible = payments.some((p) => p.status === "completed" && p.method !== "online" && p.method !== "opening");
  // The class's fee is per student, per year (RTE seats pay nothing: the alert above says so).
  const annualFee = plan && student.className && !student.rte ? annualFeeFor(plan, student.className) : null;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/office/fees" className="inline-flex min-h-6 items-center gap-1.5 hover:text-forest-900">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Fees
          </Link>
        }
        title={student.name}
        description={
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="tabular">SR No. {student.srNo}</span>
            <span aria-hidden>·</span>
            <span>{placed ? classLabel(student.className!, student.stream, student.sectionName) : "Not placed in a class this session"}</span>
            {student.rollNo ? (
              <>
                <span aria-hidden>·</span>
                <span className="tabular">Roll {student.rollNo}</span>
              </>
            ) : null}
            {student.fatherName ? (
              <>
                <span aria-hidden>·</span>
                <span>Father: {student.fatherName}</span>
              </>
            ) : null}
            {student.guardianMobile ? (
              <>
                <span aria-hidden>·</span>
                <a href={`tel:+91${student.guardianMobile}`} className="tabular underline-offset-2 hover:underline">
                  {student.guardianMobile}
                </a>
              </>
            ) : null}
            {student.rte ? <Badge tone="blue">RTE seat</Badge> : null}
            {student.status !== "active" ? <Badge tone="grey">{student.status.replace("_", " ")}</Badge> : null}
          </p>
        }
      />

      <Flash code={sp.done} messages={APPROVAL_MESSAGES} />

      {claims.length ? (
        <section aria-labelledby="claims-title" className="mb-8">
          <h2 id="claims-title" className="mb-3 font-display text-[1.35rem] text-forest-900">
            Cash the family recorded — waiting for approval
          </h2>
          <div className="grid gap-4">
            {claims.map((c) => (
              <ClaimCard
                key={c.id}
                claim={c}
                check={checks.get(c.id)!}
                currentSessionId={sessionId}
                payingOnline={openOrders.length > 0}
                canDecide={isAdmin}
                from="student"
                showStudent={false}
              />
            ))}
          </div>
        </section>
      ) : null}

      {openOrders.length ? (
        <Alert tone="amber" title="The family is paying online right now" className="mb-6">
          An online payment of {rupees(openOrders[0].amount)} was started at {formatDateTime(openOrders[0].createdAt)}. It stays open for 30 minutes. To avoid the family paying
          twice, don&rsquo;t take cash for the same fees until it has finished.
        </Alert>
      ) : null}

      {student.rte ? (
        <Alert tone="blue" title="RTE seat: no fees from now on" className="mb-6">
          {paidBeforeRte
            ? `${rupees(paidBeforeRte)} was paid this session before the RTE seat was recorded. It stays on record and in the totals; anything still due was waived. If the family asks for a refund, the school decides it and pays it outside the portal.`
            : "Every fee line this session is waived for the RTE seat."}
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Stat
          label="Charged"
          value={<Money paise={totals.charged} />}
          hint={totals.waived ? `${rupees(feesTotal)} in fees, less ${rupees(totals.waived)} waived` : `Session ${sessionId}`}
        />
        <Stat
          label="Paid"
          value={<Money paise={totals.paid} />}
          tone="green"
          hint={`${receiptCount === 1 ? "1 receipt" : `${receiptCount} receipts`}${totals.refunded ? `, less ${rupees(totals.refunded)} refunded` : ""}`}
        />
        <Stat label="Due now" value={<Money paise={totals.dueNow} />} tone={totals.dueNow ? "amber" : "default"} hint={`${rupees(totals.outstanding)} left for the session`} />
        <Stat label="Overdue" value={<Money paise={totals.overdue} />} tone={totals.overdue ? "red" : "default"} hint={totals.overdue ? "Past the due date" : "Nothing overdue"} />
      </div>

      <div className="mt-8 grid items-start gap-8 2xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 2xl:order-2">
          {lines.length ? (
            <Card className="@container">
              <CardTitle>{totals.outstanding > 0 ? "Record a payment" : "Nothing to collect"}</CardTitle>
              {/* The form stays mounted after the last fee is paid, so its receipt link survives the refresh. */}
              <ActionForm action={recordPaymentAction.bind(null, studentId)} resetOnSuccess>
                {totals.outstanding > 0 ? (
                  <>
                    <div className="grid gap-5 @xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <div className="grid content-start gap-1.5">
                        <label htmlFor="amount" className="text-[0.92rem] font-semibold text-forest-900">
                          Amount received (₹)<span className="text-clay-600"> *</span>
                        </label>
                        <RememberedInput
                          key={`amount-${suggested}`}
                          id="amount"
                          name="amount"
                          inputMode="decimal"
                          autoComplete="off"
                          defaultValue={suggested ? String(suggested / 100) : ""}
                          aria-describedby="amount-hint amount-error"
                          className="text-lg font-semibold tabular"
                        />
                        <p id="amount-hint" className="text-[0.85rem] text-muted">
                          {totals.dueNow ? `${rupees(totals.dueNow)} is due now` : "Nothing is due yet"}; {rupees(totals.outstanding)} is left for the session. It is applied to the
                          oldest fees first.
                        </p>
                        <FieldError name="amount" />
                      </div>

                      <div className="grid content-start gap-1.5">
                        <label htmlFor="paidOn" className="text-[0.92rem] font-semibold text-forest-900">
                          Date received<span className="text-clay-600"> *</span>
                        </label>
                        <RememberedInput key={`date-${today}`} id="paidOn" name="paidOn" type="date" defaultValue={today} max={today} aria-describedby="paidOn-error" />
                        <FieldError name="paidOn" />
                      </div>
                    </div>

                    <fieldset className="grid gap-1.5" aria-describedby="method-error">
                      <legend className="mb-1.5 text-[0.92rem] font-semibold text-forest-900">
                        Paid by<span className="text-clay-600"> *</span>
                      </legend>
                      <div className="grid grid-cols-1 gap-2 @sm:grid-cols-3">
                        {OFFICE_METHODS.map((m) => (
                          <label
                            key={m}
                            className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-cream-50 px-2 text-center text-[0.9rem] font-semibold text-forest-900 ring-1 ring-forest-900/15 has-[:checked]:bg-sage-100 has-[:checked]:ring-2 has-[:checked]:ring-forest-700 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ochre-500"
                          >
                            <RememberedChoice type="radio" name="method" value={m} defaultChecked={m === "cash"} className="h-4 w-4 shrink-0 accent-forest-700" />
                            {METHOD_LABELS[m].en}
                          </label>
                        ))}
                      </div>
                      <FieldError name="method" />
                    </fieldset>

                    <div className="grid gap-1.5">
                      <label htmlFor="reference" className="text-[0.92rem] font-semibold text-forest-900">
                        Cheque or transfer details
                      </label>
                      <RememberedInput
                        id="reference"
                        name="reference"
                        autoComplete="off"
                        maxLength={80}
                        aria-describedby="reference-hint reference-error"
                        placeholder="e.g. Cheque 004512, SBI Bikaner"
                      />
                      <p id="reference-hint" className="text-[0.85rem] text-muted">
                        Needed for a cheque (number and bank) or a bank transfer (UTR). Leave empty for cash.
                      </p>
                      <FieldError name="reference" />
                    </div>

                    <SubmitButton pendingLabel="Recording…" className="w-full @xl:w-auto @xl:justify-self-start">
                      Record payment
                    </SubmitButton>
                  </>
                ) : (
                  <p className="text-muted">
                    {student.rte
                      ? paidBeforeRte
                        ? "RTE seat: no fees are charged from now on. What was paid earlier this session stays on record."
                        : "RTE seat: no fees are charged."
                      : "Every fee for this session is paid."}
                  </p>
                )}
                <ReceiptLinkFromResult base="/office/fees/receipts" />
              </ActionForm>
            </Card>
          ) : (
            <Card>
              <CardTitle>Nothing to collect</CardTitle>
              <p className="text-muted">This student has no fee lines for this session yet.</p>
            </Card>
          )}

          {showAdmission ? (
            <Card>
              <CardTitle>Admission fee</CardTitle>
              <ActionForm action={addAdmissionFeeAction.bind(null, studentId)}>
                {admissionCharged ? (
                  <p className="text-[0.95rem] text-muted">The one-time admission fee is on this student&rsquo;s fee lines.</p>
                ) : (
                  <>
                    <p className="text-[0.95rem] text-muted">
                      Admitted on {formatDate(student.admittedOn)} — a new admission this session. The approved one-time admission fee is {rupees(admissionFee!.amount)}
                      {admissionFee!.refundable ? "" : " (non-refundable)"}
                      {student.rte ? "; it is recorded as waived for an RTE seat" : ""}.
                    </p>
                    <div>
                      <ConfirmSubmit variant="primary" size="md" question={`Add ${rupees(admissionFee!.amount)}?`} confirmLabel="Yes, add it">
                        Add admission fee
                      </ConfirmSubmit>
                    </div>
                  </>
                )}
              </ActionForm>
            </Card>
          ) : null}
        </div>

        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-8 2xl:order-1">
          <section aria-labelledby="lines-title">
            <h2 id="lines-title" className="mb-3 font-display text-[1.35rem] text-forest-900">
              Fee lines
            </h2>
            {annualFee ? (
              <p className="-mt-1 mb-3 max-w-3xl text-[0.95rem] text-forest-900/85">
                {annualFeeSentence(annualFee, student.className!, student.stream, "en", { perStudent: true })}
              </p>
            ) : null}
            {lines.length ? (
              <Table caption={`Fee lines for ${student.name}, session ${sessionId}`}>
                <thead>
                  <tr>
                    <Th>Fee</Th>
                    <Th>Due date</Th>
                    <Th className="text-right">Amount</Th>
                    {anyWaived ? <Th className="text-right">Waived</Th> : null}
                    <Th className="text-right">Paid</Th>
                    <Th className="text-right">Balance</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const rte = l.waived && isRteWaiver(l.waiverNote);
                    return (
                      <tr key={l.id} className="align-top">
                        <Td>
                          <span className="font-semibold text-forest-900">{l.label}</span>
                          {l.waived && !rte ? <span className="block text-[0.85rem] text-muted">Waived: {l.waiverNote}</span> : null}
                          {rte && l.paid > 0 ? (
                            <span className="block text-[0.85rem] text-muted">{rupees(Math.min(l.paid, l.amount))} was paid before the RTE seat was recorded; the rest is waived.</span>
                          ) : null}
                          {isAdmin ? (
                            // One form per line stays mounted while the line changes (waived ⇄ due), so its message stays visible.
                            <ActionForm action={lineAction.bind(null, studentId, l.id)} className="mt-1.5 max-w-sm gap-3">
                              {!l.waived && l.outstanding > 0 ? (
                                <details>
                                  <summary className="inline-flex min-h-8 cursor-pointer list-none items-center rounded-full px-2.5 text-[0.85rem] font-semibold text-forest-800 ring-1 ring-forest-900/15 hover:bg-forest-900/[0.05] [&::-webkit-details-marker]:hidden">
                                    Waive…
                                  </summary>
                                  <div className="mt-3 grid gap-3">
                                    <input type="hidden" name="op" value="waive" />
                                    <div className="grid gap-1.5">
                                      <label htmlFor={`note-${l.id}`} className="text-[0.88rem] font-semibold text-forest-900">
                                        Why is {rupees(l.outstanding)} being waived?<span className="text-clay-600"> *</span>
                                      </label>
                                      <Textarea
                                        id={`note-${l.id}`}
                                        name="note"
                                        required
                                        maxLength={300}
                                        className="min-h-20"
                                        placeholder="e.g. Fee concession approved by the managing committee"
                                      />
                                    </div>
                                    <div>
                                      <ConfirmSubmit question={`Waive ${rupees(l.outstanding)}?`} confirmLabel="Yes, waive">
                                        Waive balance
                                      </ConfirmSubmit>
                                    </div>
                                  </div>
                                </details>
                              ) : null}
                              {l.waived && !rte && !student.rte ? (
                                <div>
                                  <input type="hidden" name="op" value="restore" />
                                  <ConfirmSubmit question="Charge this fee again?" confirmLabel="Yes, undo">
                                    <Undo2 className="h-3.5 w-3.5" aria-hidden />
                                    Undo waiver
                                  </ConfirmSubmit>
                                </div>
                              ) : null}
                            </ActionForm>
                          ) : null}
                        </Td>
                        <Td className="whitespace-nowrap tabular">{formatDate(l.dueOn)}</Td>
                        <Td className="text-right">
                          <Money paise={l.amount} />
                        </Td>
                        {anyWaived ? (
                          <Td className="text-right">{waivedOf(l) ? <Money paise={waivedOf(l)} /> : <span className="text-muted">—</span>}</Td>
                        ) : null}
                        <Td className="text-right">
                          <Money paise={l.paid} />
                        </Td>
                        <Td className="text-right font-semibold">
                          <Money paise={l.outstanding} />
                        </Td>
                        <Td>
                          <LineStatus line={l} today={today} />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-cream-200/50">
                    <th scope="row" className="px-4 py-3 pl-6 text-left font-semibold text-forest-900">
                      Total
                    </th>
                    <Td />
                    <Td className="text-right font-semibold">
                      <Money paise={feesTotal} />
                    </Td>
                    {anyWaived ? (
                      <Td className="text-right font-semibold">
                        <Money paise={totals.waived} />
                      </Td>
                    ) : null}
                    <Td className="text-right font-semibold">
                      <Money paise={lines.reduce((a, l) => a + l.paid, 0)} />
                    </Td>
                    <Td className="text-right font-semibold">
                      <Money paise={totals.outstanding} />
                    </Td>
                    <Td />
                  </tr>
                </tfoot>
              </Table>
            ) : (
              <EmptyState title="No fee lines">
                {student.className ? "The fee plan has no fee for this class." : "Place the student in a class for this session; the fee lines are created from the fee plan."}
              </EmptyState>
            )}
          </section>

          <section aria-labelledby="payments-title">
            <h2 id="payments-title" className="mb-3 font-display text-[1.35rem] text-forest-900">
              Payments and receipts
            </h2>
            {!isAdmin && reversible ? (
              <p className="-mt-1 mb-3 text-[0.9rem] text-muted">
                To cancel a receipt (for example when a cheque bounces) or record a refund, please ask the principal or office admin: only they can.
              </p>
            ) : null}
            {payments.length ? (
              <Table caption={`Payments by ${student.name} this session`}>
                <thead>
                  <tr>
                    <Th>Receipt</Th>
                    <Th>Date</Th>
                    <Th>Paid by</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Recorded by</Th>
                  </tr>
                </thead>
                <tbody>
                  {[...payments].reverse().map((p) => {
                    const cancelled = p.status === "reversed";
                    const own = refundsOf(p.id);
                    const activeRefunds = own.filter((r) => r.status === "completed");
                    const refundable = refundableOf(p, refundedOn(p.id));
                    return (
                      <Fragment key={p.id}>
                        <tr className="align-top">
                          <Td className={isAdmin ? "min-w-64" : undefined}>
                            <Link
                              href={`/office/fees/receipts/${p.id}`}
                              className="inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap font-semibold text-forest-800 underline-offset-2 hover:underline"
                            >
                              <Printer className="h-4 w-4" aria-hidden />
                              <span className="tabular">{p.receiptNo}</span>
                            </Link>
                            {cancelled ? (
                              <span className="mt-1 block">
                                <Badge tone="red">Cancelled</Badge>
                                <span className="mt-1 block text-[0.85rem] text-muted">{p.reversalNote}</span>
                              </span>
                            ) : activeRefunds.length && !refundable ? (
                              <span className="mt-1 block">
                                <Badge tone="amber">Refunded in full</Badge>
                              </span>
                            ) : null}
                            {isAdmin && p.method !== "online" && !activeRefunds.length ? (
                              <ActionForm action={reversePaymentAction.bind(null, studentId, p.id)} className="mt-1.5 max-w-sm gap-3">
                                {!cancelled ? (
                                  <details>
                                    <summary className="inline-flex min-h-8 cursor-pointer list-none items-center rounded-full px-2.5 text-[0.85rem] font-semibold text-clay-600 ring-1 ring-clay-500/30 hover:bg-clay-50 [&::-webkit-details-marker]:hidden">
                                      Reverse…
                                    </summary>
                                    <div className="mt-3 grid gap-3">
                                      <div className="grid gap-1.5">
                                        <label htmlFor={`reason-${p.id}`} className="text-[0.88rem] font-semibold text-forest-900">
                                          Reason<span className="text-clay-600"> *</span>
                                        </label>
                                        <Textarea
                                          id={`reason-${p.id}`}
                                          name="reason"
                                          required
                                          maxLength={300}
                                          className="min-h-20"
                                          placeholder="e.g. Cheque returned unpaid by the bank"
                                        />
                                        <p className="text-[0.82rem] text-muted">
                                          For a bounced cheque or a payment entered by mistake. The receipt stays on record, marked cancelled, and {rupees(p.amount)} becomes due again. If the
                                          money was given back to the family, record a refund instead.
                                        </p>
                                      </div>
                                      <div>
                                        <ConfirmSubmit question={`Cancel receipt ${p.receiptNo}?`} confirmLabel="Yes, reverse">
                                          Reverse payment
                                        </ConfirmSubmit>
                                      </div>
                                    </div>
                                  </details>
                                ) : null}
                              </ActionForm>
                            ) : null}
                            {/* Stays mounted once everything is refunded, so the message saying so survives the refresh. */}
                            {isAdmin && (refundable > 0 || own.length > 0) ? <RefundForm studentId={studentId} payment={p} refundable={refundable} today={today} /> : null}
                          </Td>
                          <Td className="whitespace-nowrap tabular">{formatDate(p.paidOn)}</Td>
                          <Td>
                            {METHOD_LABELS[p.method].en}
                            {p.reference && p.method !== "online" ? <span className="block max-w-[14rem] text-[0.85rem] text-muted">{p.reference}</span> : null}
                            {p.method === "online" ? <span className="block text-[0.85rem] text-muted tabular">{p.providerPaymentId}</span> : null}
                          </Td>
                          <Td className={cancelled ? "text-right text-muted line-through" : "text-right font-semibold"}>
                            <Money paise={p.amount} />
                          </Td>
                          <Td className="text-[0.9rem]">{p.method === "online" ? "Paid online" : ((p.recordedBy && names.get(p.recordedBy)) ?? "—")}</Td>
                        </tr>
                        {[...own].reverse().map((r) => {
                          const refundCancelled = r.status !== "completed";
                          return (
                            <tr key={r.id} className="align-top bg-ochre-50/40">
                              <Td className="pl-10">
                                <span className="block whitespace-nowrap font-semibold text-forest-900 tabular">{r.voucherNo}</span>
                                <span className="block text-[0.85rem] text-muted">Refund on receipt {p.receiptNo}</span>
                                {refundCancelled ? (
                                  <span className="mt-1 block">
                                    <Badge tone="red">Refund cancelled</Badge>
                                    <span className="mt-1 block text-[0.85rem] text-muted">{r.cancellationNote}</span>
                                  </span>
                                ) : null}
                                {isAdmin && r.method !== "online" ? (
                                  // Stays mounted once cancelled, so its message stays visible.
                                  <ActionForm action={cancelRefundAction.bind(null, studentId, r.id)} className="mt-1.5 max-w-sm gap-3">
                                    {!refundCancelled ? (
                                      <details>
                                        <summary className="inline-flex min-h-8 cursor-pointer list-none items-center rounded-full px-2.5 text-[0.85rem] font-semibold text-clay-600 ring-1 ring-clay-500/30 hover:bg-clay-50 [&::-webkit-details-marker]:hidden">
                                          Cancel refund…
                                        </summary>
                                        <div className="mt-3 grid gap-3">
                                          <div className="grid gap-1.5">
                                            <label htmlFor={`cancel-refund-${r.id}`} className="text-[0.88rem] font-semibold text-forest-900">
                                              Why is it being cancelled?<span className="text-clay-600"> *</span>
                                            </label>
                                            <Textarea id={`cancel-refund-${r.id}`} name="reason" required maxLength={300} className="min-h-20" placeholder="e.g. Entered twice by mistake" />
                                            <p className="text-[0.82rem] text-muted">
                                              Only for a refund entered by mistake: it stays on record, marked cancelled, and the {rupees(r.amount)} counts as paid again.
                                            </p>
                                            <FieldError name="reason" />
                                          </div>
                                          <div>
                                            <ConfirmSubmit question={`Cancel refund ${r.voucherNo} (${rupees(r.amount)})?`} confirmLabel="Yes, cancel refund">
                                              Cancel refund
                                            </ConfirmSubmit>
                                          </div>
                                        </div>
                                      </details>
                                    ) : null}
                                  </ActionForm>
                                ) : null}
                              </Td>
                              <Td className="whitespace-nowrap tabular">{formatDate(r.refundedOn)}</Td>
                              <Td>
                                <Badge tone="amber">Refund</Badge> {REFUND_METHOD_LABELS[r.method].en}
                                {r.providerRefundId ? <span className="block text-[0.85rem] text-muted tabular">{r.providerRefundId}</span> : null}
                                {r.reference ? <span className="block max-w-[14rem] text-[0.85rem] text-muted">{r.reference}</span> : null}
                                <span className="block max-w-[16rem] text-[0.85rem] text-muted">{r.note}</span>
                              </Td>
                              <Td className={refundCancelled ? "whitespace-nowrap text-right text-muted line-through" : "whitespace-nowrap text-right font-semibold text-clay-600"}>
                                −<Money paise={r.amount} />
                              </Td>
                              <Td className="text-[0.9rem]">{(r.recordedBy && names.get(r.recordedBy)) ?? (r.method === "online" ? "Razorpay" : "—")}</Td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No payments yet">
                Payments recorded here, opening balances and online payments by the family all appear in this list with their receipts.
              </EmptyState>
            )}
          </section>

          {orders.length ? (
            <section aria-labelledby="orders-title">
              <h2 id="orders-title" className="mb-3 font-display text-[1.35rem] text-forest-900">
                Online payment attempts
              </h2>
              {razorpayOrders ? (
                <ActionForm action={checkRazorpayAction.bind(null, studentId)} className="mb-4 max-w-3xl gap-3">
                  {checkable ? (
                    <>
                      <p className="text-[0.92rem] text-muted">
                        The portal asks Razorpay about unfinished payments by itself every 10 minutes. If the family says they paid but no receipt appears, check now.
                      </p>
                      <div>
                        <SubmitButton variant="secondary" size="sm" pendingLabel="Asking Razorpay…">
                          <RefreshCw className="h-4 w-4" aria-hidden />
                          Check with Razorpay
                        </SubmitButton>
                      </div>
                    </>
                  ) : (
                    <p className="text-[0.92rem] text-muted">Every Razorpay payment listed here has its receipt.</p>
                  )}
                </ActionForm>
              ) : null}
              <Table caption="Online payments started by the family">
                <thead>
                  <tr>
                    <Th>Started</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Result</Th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => {
                    const s = ORDER_STATUS[o.status] ?? ORDER_STATUS.failed;
                    return (
                      <tr key={o.id}>
                        <Td className="whitespace-nowrap">{formatDateTime(o.createdAt)}</Td>
                        <Td className="text-right">
                          <Money paise={o.amount} />
                        </Td>
                        <Td>
                          <Badge tone={s.tone}>{s.label}</Badge>
                          {o.provider === "mock" ? <span className="ml-2 text-[0.82rem] text-muted">test checkout</span> : null}
                          {o.failureReason && o.status !== "paid" ? <span className="mt-1 block text-[0.85rem] text-muted">{o.failureReason}</span> : null}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </section>
          ) : null}

          <p className="text-[0.85rem] text-muted">
            <ButtonLink href="/office/fees" variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              All students
            </ButtonLink>
          </p>
        </div>
      </div>
    </>
  );
}

type PaymentRow = Awaited<ReturnType<typeof ledger>>["payments"][number];

/**
 * "Refund…" under a payment (principal and office admins). Online payments
 * are refunded in the Razorpay Dashboard, then recorded from Razorpay;
 * counter payments are recorded here with how the money went back and why.
 */
function RefundForm({ studentId, payment: p, refundable, today }: { studentId: string; payment: PaymentRow; refundable: number; today: string }) {
  const id = (name: string) => `refund-${name}-${p.id}`;
  if (refundable <= 0) {
    return (
      <ActionForm action={refundAction.bind(null, studentId, p.id)} className="mt-1.5 max-w-sm gap-3">
        <span className="sr-only">Everything paid on this receipt has been refunded.</span>
      </ActionForm>
    );
  }
  const summary = (
    <summary className="inline-flex min-h-8 cursor-pointer list-none items-center rounded-full px-2.5 text-[0.85rem] font-semibold text-forest-800 ring-1 ring-forest-900/15 hover:bg-forest-900/[0.05] [&::-webkit-details-marker]:hidden">
      Refund…
    </summary>
  );
  if (p.method === "online") {
    return (
      <ActionForm action={refundAction.bind(null, studentId, p.id)} className="mt-1.5 max-w-sm gap-3">
        <ClosingDetails>
          {summary}
          <div className="mt-3 grid gap-3">
            <input type="hidden" name="op" value="gateway" />
            <p className="text-[0.85rem] text-muted">
              Make the refund in the Razorpay Dashboard (up to {rupees(refundable)}). The portal records it by itself when Razorpay says it is done; or press this to record it now.
            </p>
            <div>
              <SubmitButton variant="secondary" size="sm" pendingLabel="Asking Razorpay…">
                Record refunds made in Razorpay
              </SubmitButton>
            </div>
          </div>
        </ClosingDetails>
      </ActionForm>
    );
  }
  return (
    <ActionForm action={refundAction.bind(null, studentId, p.id)} className="mt-1.5 max-w-sm gap-3">
      <ClosingDetails>
        {summary}
        <div className="mt-3 grid gap-3">
          <input type="hidden" name="op" value="office" />
          {/* A new one-time id with every page: the same form sent twice (a retry) records one refund. */}
          <input type="hidden" name="requestId" value={crypto.randomUUID()} />
          <div className="grid gap-1.5">
            <label htmlFor={id("amount")} className="text-[0.88rem] font-semibold text-forest-900">
              Amount given back (₹)<span className="text-clay-600"> *</span>
            </label>
            <RememberedInput id={id("amount")} name="amount" inputMode="decimal" autoComplete="off" defaultValue={String(refundable / 100)} aria-describedby={`${id("amount")}-hint`} />
            <p id={`${id("amount")}-hint`} className="text-[0.82rem] text-muted">
              Up to {rupees(refundable)}. It comes off the latest fees on this receipt first, and those fees become due again.
            </p>
            <FieldError name="amount" />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={id("date")} className="text-[0.88rem] font-semibold text-forest-900">
              Date given back<span className="text-clay-600"> *</span>
            </label>
            <RememberedInput id={id("date")} name="refundedOn" type="date" defaultValue={today} min={p.paidOn} max={today} />
            <FieldError name="refundedOn" />
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-[0.88rem] font-semibold text-forest-900">
              Given back by<span className="text-clay-600"> *</span>
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {REFUND_METHODS.map((m) => (
                <label key={m} className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-[0.9rem] text-forest-900">
                  <RememberedChoice type="radio" name="method" value={m} defaultChecked={m === "cash"} className="h-4 w-4 accent-forest-700" />
                  {REFUND_METHOD_LABELS[m].en}
                </label>
              ))}
            </div>
            <FieldError name="method" />
          </fieldset>
          <div className="grid gap-1.5">
            <label htmlFor={id("reference")} className="text-[0.88rem] font-semibold text-forest-900">
              Cheque or transfer details
            </label>
            <RememberedInput id={id("reference")} name="reference" autoComplete="off" maxLength={80} placeholder="e.g. Cheque 004513, SBI Bikaner" />
            <FieldError name="reference" />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={id("note")} className="text-[0.88rem] font-semibold text-forest-900">
              Reason<span className="text-clay-600"> *</span>
            </label>
            <RememberedInput
              id={id("note")}
              name="note"
              autoComplete="off"
              maxLength={300}
              placeholder="e.g. Student left in October; refund approved by the principal"
              aria-describedby={`${id("note")}-hint`}
            />
            <p id={`${id("note")}-hint`} className="text-[0.82rem] text-muted">
              Printed on the receipt, which the family sees too.
            </p>
            <FieldError name="note" />
          </div>
          <div>
            <ConfirmSubmit variant="primary" question={<RefundQuestion receiptNo={p.receiptNo} />} confirmLabel="Yes, record refund">
              Record refund
            </ConfirmSubmit>
          </div>
        </div>
      </ClosingDetails>
    </ActionForm>
  );
}
