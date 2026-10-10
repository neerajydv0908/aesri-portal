/**
 * One cash payment a family recorded on the portal, waiting for the school's
 * approval: what they say they paid, when and to whom, what is due now, and
 * the student's receipts close to that day (so the same cash isn't counted
 * twice) — with warnings when the fees changed since the family recorded it —
 * and, for the principal and office admins, Approve and Decline.
 */
import Link from "next/link";
import { AlertTriangle, Banknote } from "lucide-react";
import { addDays, formatDate, formatDateTime } from "@/lib/dates";
import { METHOD_LABELS, rupees } from "@/lib/services/fees";
import { CASH_CLAIM_LIMITS, type ClaimCheck, type ClaimRow } from "@/lib/services/cash-claims";
import { approveClaimAction, declineClaimAction } from "@/app/(app)/office/fees/approvals/actions";
import { ActionForm } from "@/components/forms";
import { Badge, Money, Textarea } from "@/components/ui";
import { langOfText } from "@/lib/i18n";
import { ConfirmSubmit } from "@/components/ui/client";
import type { ReactNode } from "react";

/** The page's message after Approve or Decline (?done=…). */
export const APPROVAL_MESSAGES = {
  approved: "Approved. The receipt is made, and the family sees it on the portal.",
  declined: "Declined. The family gets a text message asking them to contact the school office, and sees the decision on the portal.",
  declined_unreachable: "Declined. The family can’t be sent a text message (no valid mobile number, or they asked for no messages): please phone them.",
  declined_nosms: "Declined. Text messages for declined payments are switched off in Settings, so please tell the family yourself.",
  declined_notsetup: "Declined. Text messages can’t be sent yet (the SMS service, or this message’s template, isn’t set up), so please tell the family yourself.",
};

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-xl bg-clay-50 px-4 py-3 text-[0.92rem] text-forest-900 ring-1 ring-clay-500/30">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-clay-600" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function ClaimCard({
  claim: c,
  check,
  currentSessionId,
  payingOnline,
  canDecide,
  from,
  showStudent = true,
}: {
  claim: ClaimRow;
  /** What is due now and the receipts close to it (claimChecks). */
  check: ClaimCheck;
  /** The school's current session: a record from another one says so. */
  currentSessionId: string;
  payingOnline: boolean;
  /** Principal, office admin or AESRI administrator (the accountant sees the record but can't decide it). */
  canDecide: boolean;
  /** Where the buttons send you back to afterwards. */
  from: "list" | "student";
  showStudent?: boolean;
}) {
  const tuition = c.amount - c.admissionAmount;
  const due = check.due.admission + check.due.tuition;
  const tooMuch = c.amount > due;
  // The fees changed since the family recorded it (paid or waived at the office): say where the money would go.
  const admissionShort = !tooMuch && c.admissionAmount > check.due.admission;
  const tuitionShort = !tooMuch && !admissionShort && tuition > check.due.tuition;
  const otherSession = c.sessionId !== currentSessionId;
  return (
    <article className="card grid gap-4 p-5 sm:p-6" aria-labelledby={`claim-${c.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {showStudent ? (
            <h3 id={`claim-${c.id}`} className="font-sans text-[1.08rem] font-bold tracking-normal text-forest-900">
              <Link href={`/office/fees/students/${c.studentId}`} className="underline-offset-2 hover:underline">
                {c.studentName}
              </Link>
              <span className="ml-2 text-[0.88rem] font-normal text-muted tabular">
                SR {c.srNo}
                {c.section ? ` · ${c.section}` : ""}
              </span>
            </h3>
          ) : (
            <h3 id={`claim-${c.id}`} className="sr-only">
              Cash payment of {rupees(c.amount)} recorded by the family
            </h3>
          )}
          <p className="mt-1 flex items-center gap-2 font-display text-[1.7rem] leading-tight text-forest-900">
            <Banknote className="h-6 w-6 shrink-0 text-forest-700" aria-hidden />
            <Money paise={c.amount} />
            <span className="font-sans text-[0.95rem] font-semibold text-muted">cash</span>
          </p>
          {c.admissionAmount > 0 ? (
            <p className="text-[0.9rem] text-muted">
              Admission fee {rupees(c.admissionAmount)}
              {tuition > 0 ? ` and tuition ${rupees(tuition)}` : ""}
            </p>
          ) : null}
          {otherSession ? <p className="text-[0.9rem] font-semibold text-clay-600">For the {c.sessionId} session</p> : null}
        </div>
        <Badge tone="amber">Waiting for approval</Badge>
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-[0.92rem] sm:grid-cols-2">
        <div>
          <dt className="text-muted">Paid on (the family says)</dt>
          <dd className="font-semibold text-forest-900">{formatDate(c.paidOn, "en", { weekday: true })}</dd>
        </div>
        <div>
          <dt className="text-muted">Recorded on the portal</dt>
          <dd className="font-semibold text-forest-900">{formatDateTime(c.createdAt)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted">Given to</dt>
          <dd className="text-forest-900">{c.note ? <span lang={langOfText(c.note)}>“{c.note}”</span> : <span className="text-muted">Not said</span>}</dd>
        </div>
        <div>
          <dt className="text-muted">Due now for this student{otherSession ? ` (${c.sessionId})` : ""}</dt>
          <dd className={`font-semibold ${tooMuch ? "text-clay-600" : "text-forest-900"}`}>
            <Money paise={due} />
            {check.due.admission > 0 && check.due.tuition > 0 ? (
              <span className="block text-[0.85rem] font-normal text-muted">
                Admission fee {rupees(check.due.admission)} · tuition {rupees(check.due.tuition)}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Receipts from {formatDate(addDays(c.paidOn, -7))} on</dt>
          <dd className="text-forest-900">
            {check.receipts.length ? (
              <ul className="grid gap-0.5">
                {check.receipts.map((r) => (
                  <li key={r.id} className={r.status === "reversed" ? "text-muted line-through" : undefined}>
                    <Link href={`/office/fees/receipts/${r.id}`} className="font-semibold tabular underline-offset-2 hover:underline">
                      {r.receiptNo}
                    </Link>{" "}
                    · {rupees(r.amount)} {METHOD_LABELS[r.method].en.toLowerCase()} · {formatDate(r.paidOn)}
                    {r.fromFamilyRecord ? <span className="text-muted"> · an earlier record by the family</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted">None</span>
            )}
          </dd>
        </div>
      </dl>

      {tooMuch ? (
        <Warning>
          {due > 0 ? `Only ${rupees(due)} is due now, less than the ${rupees(c.amount)} recorded.` : "Nothing is due now for this student."} The same cash may already be on a
          receipt: if so, decline this record.
        </Warning>
      ) : check.cashReceipts ? (
        <Warning>
          {check.cashReceipts === 1 ? "A receipt above was" : "Receipts above were"} made close to the day the family says they paid. Check this isn&rsquo;t the same cash: if it
          is, decline this record and say so in the reason.
        </Warning>
      ) : null}
      {admissionShort ? (
        <Warning>
          {check.due.admission > 0
            ? `Only ${rupees(check.due.admission)} of the admission fee is still due: it was paid or waived since.`
            : "The admission fee is no longer due: it was paid or waived since."}{" "}
          If you approve, the rest goes to tuition.
        </Warning>
      ) : tuitionShort ? (
        <Warning>Only {rupees(check.due.tuition)} of tuition is still due. If you approve, the rest goes to the admission fee.</Warning>
      ) : null}
      {payingOnline ? (
        <p className="flex items-start gap-2 rounded-xl bg-ochre-50 px-4 py-3 text-[0.92rem] text-forest-900 ring-1 ring-ochre-500/30">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-ochre-600" aria-hidden />
          The family is paying online right now. Wait until that payment has finished, so the same fees aren&rsquo;t paid twice.
        </p>
      ) : null}

      {canDecide ? (
        <div className="grid gap-4 border-t border-forest-900/10 pt-4 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start">
          <ActionForm action={approveClaimAction.bind(null, c.id, from)} className="gap-2">
            <div>
              <ConfirmSubmit variant="primary" size="md" question={`Did the school receive ${rupees(c.amount)}?`} confirmLabel="Yes — approve and issue receipt">
                Approve
              </ConfirmSubmit>
            </div>
          </ActionForm>
          <ActionForm action={declineClaimAction.bind(null, c.id, from)} className="gap-2">
            <div className="grid gap-1.5">
              <label htmlFor={`reason-${c.id}`} className="text-[0.88rem] font-semibold text-forest-900">
                Reason for declining <span className="font-normal text-muted">(the family sees it)</span>
              </label>
              <Textarea id={`reason-${c.id}`} name="reason" rows={2} maxLength={CASH_CLAIM_LIMITS.reason} placeholder="e.g. No cash was received on that day" className="min-h-20" />
            </div>
            <div>
              <ConfirmSubmit question="Decline it? The family gets a text message asking them to contact the school." confirmLabel="Yes, decline">
                Decline
              </ConfirmSubmit>
            </div>
          </ActionForm>
        </div>
      ) : (
        <p className="border-t border-forest-900/10 pt-4 text-[0.92rem] text-muted">
          The principal or an office admin approves or declines it. Don&rsquo;t record the same cash again on this page.
        </p>
      )}
    </article>
  );
}
