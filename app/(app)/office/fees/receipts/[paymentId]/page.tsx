import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { ArrowLeft } from "lucide-react";
import { officePage } from "@/lib/page";
import { FEE_ROLES, OFFICE_ROLES } from "@/lib/roles";
import { getDb } from "@/lib/db/client";
import { receiptData, rupees } from "@/lib/services/fees";
import { Alert } from "@/components/ui";
import { PrintButton } from "@/components/ui/client";
import { Receipt } from "@/components/fees/receipt";

export const metadata: Metadata = { title: "Receipt" };

const LAYOUTS = [
  { key: "half", label: "Half A4" },
  { key: "copies", label: "A4 · two copies" },
  { key: "full", label: "Full A4" },
] as const;
type Layout = (typeof LAYOUTS)[number]["key"];

export default async function OfficeReceiptPage({ params, searchParams }: { params: Promise<{ paymentId: string }>; searchParams: Promise<{ layout?: string }> }) {
  const { actor, schoolId } = await officePage(FEE_ROLES);
  const { paymentId } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const data = await receiptData(db, paymentId);
  if (!data || data.schoolId !== schoolId) notFound();
  const layout: Layout = LAYOUTS.some((l) => l.key === sp.layout) ? (sp.layout as Layout) : "half";

  return (
    <div className="mx-auto max-w-[52rem]">
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link href={`/office/fees/students/${data.studentId}`} className="inline-flex min-h-11 items-center gap-2 font-semibold text-forest-800 hover:text-forest-900">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {data.student.name}&rsquo;s fees
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="Paper size" className="flex gap-1 rounded-full bg-cream-200/70 p-1">
            {LAYOUTS.map((l) => (
              <Link
                key={l.key}
                href={`?layout=${l.key}`}
                aria-current={l.key === layout ? "page" : undefined}
                className={clsx(
                  "inline-flex min-h-9 items-center whitespace-nowrap rounded-full px-3.5 text-[0.85rem] font-semibold",
                  l.key === layout ? "bg-cream-50 text-forest-900 shadow-sm" : "text-muted hover:text-forest-900",
                )}
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <PrintButton label="Print receipt" variant="primary" />
        </div>
      </div>

      {data.status === "reversed" ? (
        <Alert tone="red" title="This receipt was cancelled" className="no-print mb-5">
          {data.reversalNote ? `${data.reversalNote.replace(/[.!?]+$/, "")}.` : "The payment was reversed."} It stays on record and prints with a CANCELLED mark.
        </Alert>
      ) : null}
      {data.status === "completed" && data.method !== "online" && !OFFICE_ROLES.includes(actor.role) ? (
        <p className="no-print mb-5 text-[0.9rem] text-muted">
          Only the principal or office admin can cancel a receipt (for example when a cheque bounces). Please ask them.
        </p>
      ) : null}
      {data.unallocated > data.unallocatedRefunded ? (
        <Alert tone="amber" title="Paid more than was due" className="no-print mb-5">
          This online payment was {rupees(data.unallocated - data.unallocatedRefunded)} more than the fees still due when it arrived. Refund the extra in the Razorpay
          Dashboard; the portal then records the refund on this receipt (or use “Refund…” under the payment on the student&rsquo;s fee page).
        </Alert>
      ) : null}

      {layout === "copies" ? (
        <div className="grid gap-6 print:gap-0">
          <Receipt data={data} copyLabel={{ en: "Family copy", hi: "अभिभावक प्रति" }} />
          <p aria-hidden className="border-t-2 border-dashed border-forest-900/30 pt-1 text-center text-[0.72rem] text-muted print:my-[3mm]">
            ✂ cut here
          </p>
          <Receipt data={data} copyLabel={{ en: "Office copy", hi: "कार्यालय प्रति" }} />
        </div>
      ) : (
        <Receipt data={data} size={layout === "full" ? "full" : "half"} />
      )}
    </div>
  );
}
