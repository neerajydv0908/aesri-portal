import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { officePage } from "@/lib/page";
import { FEE_ROLES } from "@/lib/roles";
import { getDb } from "@/lib/db/client";
import { getSchool } from "@/lib/queries/school";
import { formatDate, formatDateTime, todayIST } from "@/lib/dates";
import { sectionLabel } from "@/lib/classes";
import { COLLECTION_PAGE_ROWS, collectionRows, collectionTotals, METHOD_LABELS, rupees } from "@/lib/services/fees";
import { REFUND_METHOD_LABELS } from "@/lib/services/refunds";
import { collectionRange } from "./range";

/** How a refund was given back, in words ("Razorpay refund", "Cash"). */
const refundMethodText = (method: string) => REFUND_METHOD_LABELS[method as keyof typeof REFUND_METHOD_LABELS]?.en ?? method;
import { Alert, Badge, ButtonLink, EmptyState, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { PrintButton } from "@/components/ui/client";
import { DateField, FilterBar } from "@/components/pickers";

export const metadata: Metadata = { title: "Collections" };

const n = (x: number) => x.toLocaleString("en-IN");

/**
 * The receipts table printed on A4 portrait: smaller type, tighter cells and
 * no sideways scrolling, so every column fits the page; rows don't split
 * across pages, the headings repeat on each page and the total prints once, at the end.
 */
const PRINT_TABLE = [
  "print:overflow-visible print:[&>div]:overflow-visible",
  "print:[&_table]:min-w-0 print:[&_table]:text-[8.5pt] print:[&_table]:leading-snug",
  "print:[&_th]:px-1.5 print:[&_th]:py-1 print:[&_th]:text-[7pt] print:[&_th]:tracking-normal print:[&_td]:px-1.5 print:[&_td]:py-1",
  "print:[&_th:first-child]:pl-2 print:[&_td:first-child]:pl-2 print:[&_th:last-child]:pr-2 print:[&_td:last-child]:pr-2",
  "print:[&_tr]:break-inside-avoid print:[&_tfoot]:[display:table-row-group] print:[&_tfoot_th]:text-[9pt]",
].join(" ");

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; opening?: string }> }) {
  const { schoolId } = await officePage(FEE_ROLES);
  const sp = await searchParams;
  const { from, to, includeOpening, note } = collectionRange(sp);
  const db = await getDb();
  // The totals are added up by the database over the whole period; the list may be cut short (the CSV never is).
  const [{ rows, truncated }, totals, school] = await Promise.all([
    collectionRows(db, schoolId, from, to, includeOpening, COLLECTION_PAGE_ROWS),
    collectionTotals(db, schoolId, from, to, includeOpening),
    getSchool(schoolId),
  ]);
  const today = todayIST();
  const { received, refunded, cancelled, cancelledRefunds } = totals;
  const period = from === to ? formatDate(from, "en", { weekday: true }) : `${formatDate(from)} – ${formatDate(to)}`;
  const qs = new URLSearchParams({ from, to, ...(includeOpening ? { opening: "1" } : {}) }).toString();

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/office/fees" className="no-print inline-flex min-h-6 items-center gap-1.5 hover:text-forest-900">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Fees
          </Link>
        }
        title="Collections"
        description={
          <>
            {school ? (
              <span className="print-only font-semibold text-forest-900">
                {school.name}, {school.place}
              </span>
            ) : null}
            <span className="block">
              Receipts dated {period}
              {includeOpening ? ", including opening balances" : ""}, and refunds made in that time.
            </span>
            <span className="print-only text-[0.85rem]">Printed {formatDateTime(new Date())}.</span>
          </>
        }
        actions={
          <>
            <a
              href={`/office/fees/collections/export?${qs}`}
              download
              className="no-print inline-flex min-h-11 items-center gap-2 rounded-full bg-forest-800 px-5 text-[0.95rem] font-semibold text-cream-50 hover:bg-forest-700"
            >
              <Download className="h-4 w-4" aria-hidden />
              Download CSV
            </a>
            <PrintButton label="Print report" />
          </>
        }
      />

      <FilterBar>
        <DateField name="from" label="From" value={from} max={today} />
        <DateField name="to" label="To" value={to} max={today} />
        <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[0.95rem] font-semibold text-forest-900">
          <input type="checkbox" name="opening" value="1" defaultChecked={includeOpening} className="h-6 w-6 cursor-pointer accent-forest-700" />
          Include opening balances
        </label>
      </FilterBar>
      {note ? <p className="no-print -mt-3 mb-5 text-[0.9rem] font-semibold text-ochre-600">{note}</p> : null}

      <section aria-labelledby="totals-title" className="card mb-8 p-5 sm:p-6 print:mb-4 print:break-inside-avoid print:p-3">
        <h2 id="totals-title" className="eyebrow font-sans">
          Totals by method
        </h2>
        <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
          {received.byMethod.map((m) => (
            <div key={m.method}>
              <dt className="text-[0.9rem] font-semibold text-muted">
                {METHOD_LABELS[m.method].en} <span className="font-normal">({n(m.count)})</span>
              </dt>
              <dd className="mt-1 font-display text-[1.5rem] leading-none text-forest-900">
                <Money paise={m.total} />
              </dd>
            </div>
          ))}
          <div className="sm:col-start-auto">
            <dt className="text-[0.9rem] font-bold text-forest-900">
              {refunded.count ? "Received" : "Total"} <span className="font-normal text-muted">({n(received.count)})</span>
            </dt>
            <dd className="mt-1 font-display text-[1.9rem] leading-none text-forest-900">
              <Money paise={received.total} />
            </dd>
          </div>
          {refunded.count ? (
            <>
              <div>
                <dt className="text-[0.9rem] font-semibold text-muted">
                  Refunded <span className="font-normal">({n(refunded.count)})</span>
                </dt>
                <dd className="mt-1 font-display text-[1.5rem] leading-none text-clay-600">
                  −<Money paise={refunded.total} />
                </dd>
              </div>
              <div>
                <dt className="text-[0.9rem] font-bold text-forest-900">Net received</dt>
                <dd className="mt-1 font-display text-[1.9rem] leading-none text-forest-900">
                  <Money paise={totals.net} />
                </dd>
              </div>
            </>
          ) : null}
        </dl>
        {refunded.count ? (
          <p className="mt-4 text-[0.88rem] text-muted">
            Refunds: {refunded.byMethod.map((m) => `${refundMethodText(m.method).toLowerCase()} ${n(m.count)} (−${rupees(m.total)})`).join(", ")}.
          </p>
        ) : null}
        {cancelled ? (
          <p className="mt-4 text-[0.88rem] text-muted">
            {n(cancelled)} cancelled {cancelled === 1 ? "receipt is" : "receipts are"} listed below but not counted.
          </p>
        ) : null}
        {cancelledRefunds ? (
          <p className="mt-2 text-[0.88rem] text-muted">
            {n(cancelledRefunds)} {cancelledRefunds === 1 ? "refund was" : "refunds were"} cancelled as a mistake: listed below but not counted.
          </p>
        ) : null}
        {!includeOpening ? (
          <p className="mt-2 text-[0.88rem] text-muted">Opening balances (paper receipts from before the portal) are not counted as money received in this period.</p>
        ) : null}
      </section>

      {truncated ? (
        <Alert tone="amber" title={`The list shows the first ${n(rows.length)} of ${n(totals.entries)} entries`} className="mb-6">
          The totals above count every entry in the period. Download the CSV for the complete list, or choose a shorter period.
        </Alert>
      ) : null}

      {rows.length ? (
        <Table caption={`Receipts and refunds dated ${period}`} className={PRINT_TABLE}>
          <thead>
            <tr>
              <Th>Receipt</Th>
              <Th>Date</Th>
              <Th>Student</Th>
              <Th>Class</Th>
              <Th>Paid by</Th>
              <Th className="text-right">Amount</Th>
              <Th>Received by</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const refund = r.kind === "refund";
              const cancelledRow = r.status === "reversed";
              return (
                <tr key={`${r.kind}-${r.id}`} className="align-top">
                  <Td>
                    {refund ? (
                      <>
                        <span className="block whitespace-nowrap font-semibold text-forest-900 tabular">{r.voucherNo}</span>
                        <span className="block text-[0.85rem] text-muted print:text-[7.5pt]">
                          Refund of{" "}
                          <Link href={`/office/fees/receipts/${r.paymentId}`} className="whitespace-nowrap font-semibold text-forest-800 underline-offset-2 tabular hover:underline">
                            {r.receiptNo}
                          </Link>
                        </span>
                      </>
                    ) : (
                      <Link
                        href={`/office/fees/receipts/${r.id}`}
                        className="inline-flex min-h-8 items-center whitespace-nowrap font-semibold text-forest-800 underline-offset-2 tabular hover:underline print:min-h-0"
                      >
                        {r.receiptNo}
                      </Link>
                    )}
                    {cancelledRow ? (
                      <span className="block">
                        <Badge tone="red" className="print:text-[7pt]">
                          {refund ? "Refund cancelled" : "Cancelled"}
                        </Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap tabular">{formatDate(r.paidOn)}</Td>
                  <Td>
                    <Link href={`/office/fees/students/${r.studentId}`} className="font-semibold text-forest-900 underline-offset-2 hover:underline">
                      {r.studentName}
                    </Link>
                    <span className="block text-[0.85rem] text-muted tabular print:text-[7.5pt]">SR {r.srNo}</span>
                  </Td>
                  <Td className="whitespace-nowrap">{r.className ? sectionLabel(r.className, r.sectionName ?? "") : "—"}</Td>
                  <Td>
                    {refund ? (
                      <>
                        <Badge tone="amber" className="print:text-[7pt]">
                          Refund
                        </Badge>{" "}
                        {refundMethodText(r.method)}
                        {r.providerId ? <span className="block text-[0.85rem] text-muted tabular print:text-[7.5pt]">{r.providerId}</span> : null}
                        {r.reference ? <span className="block max-w-[16rem] text-[0.85rem] text-muted print:max-w-[9rem] print:text-[7.5pt]">{r.reference}</span> : null}
                        {r.note ? <span className="block max-w-[16rem] text-[0.85rem] text-muted print:max-w-[9rem] print:text-[7.5pt]">{r.note}</span> : null}
                      </>
                    ) : (
                      <>
                        {METHOD_LABELS[r.method].en}
                        {r.method === "online" ? (
                          <span className="block text-[0.85rem] text-muted tabular print:text-[7.5pt]">{r.providerId}</span>
                        ) : r.reference && r.method !== "opening" ? (
                          <span className="block max-w-[16rem] text-[0.85rem] text-muted print:max-w-[9rem] print:text-[7.5pt]">{r.reference}</span>
                        ) : null}
                      </>
                    )}
                  </Td>
                  <Td className={cancelledRow ? "whitespace-nowrap text-right text-muted line-through" : refund ? "whitespace-nowrap text-right font-semibold text-clay-600" : "text-right font-semibold"}>
                    {refund ? "−" : null}
                    <Money paise={r.amount} />
                  </Td>
                  <Td className="text-[0.9rem] print:text-[8.5pt]">
                    {refund ? (r.recordedByName ?? (r.method === "online" ? "Razorpay" : "—")) : r.method === "online" ? "Paid online" : (r.recordedByName ?? "—")}
                  </Td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-cream-200/50">
              <th scope="row" colSpan={5} className="px-4 py-3 pl-6 text-left font-semibold text-forest-900">
                Total received{truncated ? ` (all ${n(received.count)} receipts)` : ""}
              </th>
              <Td className="whitespace-nowrap text-right font-display text-[1.15rem] print:text-[10pt]">
                <Money paise={received.total} />
              </Td>
              <Td />
            </tr>
            {refunded.count ? (
              <>
                <tr className="bg-cream-200/50">
                  <th scope="row" colSpan={5} className="px-4 py-2 pl-6 text-left font-semibold text-forest-900">
                    Refunded{truncated ? ` (all ${n(refunded.count)} refunds)` : ""}
                  </th>
                  <Td className="whitespace-nowrap text-right font-semibold text-clay-600">
                    −<Money paise={refunded.total} />
                  </Td>
                  <Td />
                </tr>
                <tr className="bg-cream-200/50">
                  <th scope="row" colSpan={5} className="px-4 py-3 pl-6 text-left font-semibold text-forest-900">
                    Net received
                  </th>
                  <Td className="whitespace-nowrap text-right font-display text-[1.15rem] print:text-[10pt]">
                    <Money paise={totals.net} />
                  </Td>
                  <Td />
                </tr>
              </>
            ) : null}
          </tfoot>
        </Table>
      ) : (
        <EmptyState title="No receipts or refunds in this period">Choose other dates{!includeOpening ? ", or include opening balances" : ""}.</EmptyState>
      )}

      <p className="no-print mt-6">
        <ButtonLink href="/office/fees" variant="ghost" size="sm">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to fees
        </ButtonLink>
      </p>
    </>
  );
}
