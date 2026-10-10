import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CircleCheck } from "lucide-react";
import { officePage } from "@/lib/page";
import { OFFICE_ROLES } from "@/lib/roles";
import { getDb } from "@/lib/db/client";
import { formatDate, formatDateTime } from "@/lib/dates";
import { langOfText } from "@/lib/i18n";
import { claimChecks, decidedClaims, payingOnlineNow, waitingClaims } from "@/lib/services/cash-claims";
import { Flash } from "@/components/flash";
import { APPROVAL_MESSAGES, ClaimCard } from "@/components/fees/claim-card";
import { ClaimStatus } from "@/components/fees/status";
import { EmptyState, Money, PageHeader, Table, Td, Th } from "@/components/ui";

export const metadata: Metadata = { title: "Cash to approve" };

/**
 * Cash payments families recorded on the portal, for the principal, office
 * admins and AESRI administrators to approve or decline (Fees shows a red
 * dot while any are waiting).
 */
export default async function CashApprovalsPage({ searchParams }: { searchParams: Promise<{ done?: string }> }) {
  const { schoolId, sessionId } = await officePage(OFFICE_ROLES);
  const sp = await searchParams;
  const db = await getDb();
  const [waiting, decided] = await Promise.all([waitingClaims(db, schoolId), decidedClaims(db, schoolId, 30)]);
  const [checks, online] = await Promise.all([claimChecks(db, waiting), payingOnlineNow(db, waiting.map((c) => c.studentId))]);

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/office/fees" className="inline-flex min-h-6 items-center gap-1.5 hover:text-forest-900">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Fees
          </Link>
        }
        title="Cash to approve"
        description="Cash payments families recorded on the portal. Check each against the cash the school received: approve it to issue the receipt, or decline it — the family then gets a text message asking them to contact the school."
      />
      <Flash code={sp.done} messages={APPROVAL_MESSAGES} />

      <section aria-labelledby="waiting-title">
        <h2 id="waiting-title" className="mb-4 font-display text-[1.35rem] text-forest-900">
          Waiting{waiting.length ? ` (${waiting.length})` : ""}
        </h2>
        {waiting.length ? (
          <div className="grid gap-5">
            {waiting.map((c) => (
              <ClaimCard
                key={c.id}
                claim={c}
                check={checks.get(c.id)!}
                currentSessionId={sessionId}
                payingOnline={online.has(c.studentId)}
                canDecide
                from="list"
              />
            ))}
          </div>
        ) : (
          <EmptyState icon={<CircleCheck className="h-6 w-6" aria-hidden />} title="Nothing to approve">
            When a family records a cash payment on the portal, it appears here — and Fees in the menu shows a red dot.
          </EmptyState>
        )}
      </section>

      {decided.length ? (
        <section className="mt-10" aria-labelledby="decided-title">
          <h2 id="decided-title" className="mb-4 font-display text-[1.35rem] text-forest-900">
            Decided in the last 60 days
          </h2>
          <Table caption="Recorded cash payments the school approved or declined in the last 60 days">
            <thead>
              <tr>
                <Th>Decided</Th>
                <Th>Student</Th>
                <Th className="text-right">Amount</Th>
                <Th>Paid on</Th>
                <Th>Decision</Th>
              </tr>
            </thead>
            <tbody>
              {decided.map((c) => (
                <tr key={c.id}>
                  <Td className="whitespace-nowrap">
                    {c.decidedAt ? formatDateTime(c.decidedAt) : "—"}
                    {c.decidedByName ? <span className="block text-[0.85rem] text-muted">{c.decidedByName}</span> : null}
                  </Td>
                  <Td>
                    <Link href={`/office/fees/students/${c.studentId}`} className="font-semibold text-forest-900 underline-offset-2 hover:underline">
                      {c.studentName}
                    </Link>
                    <span className="block text-[0.85rem] text-muted tabular">
                      SR {c.srNo}
                      {c.section ? ` · ${c.section}` : ""}
                    </span>
                  </Td>
                  <Td className="text-right">
                    <Money paise={c.amount} />
                  </Td>
                  <Td className="whitespace-nowrap">{formatDate(c.paidOn)}</Td>
                  <Td>
                    <ClaimStatus status={c.status} />
                    {c.status === "approved" && c.paymentId ? (
                      <Link
                        href={`/office/fees/receipts/${c.paymentId}`}
                        className={`ml-2 font-semibold tabular underline-offset-2 hover:underline ${c.receiptStatus === "reversed" ? "text-muted line-through" : "text-forest-800"}`}
                      >
                        {c.receiptNo}
                      </Link>
                    ) : null}
                    {c.receiptStatus === "reversed" ? <span className="ml-2 text-[0.85rem] text-muted">receipt cancelled later</span> : null}
                    {c.declineReason ? (
                      <span lang={langOfText(c.declineReason)} className="mt-1 block text-[0.88rem] text-forest-900">
                        {c.declineReason}
                      </span>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}
    </>
  );
}
