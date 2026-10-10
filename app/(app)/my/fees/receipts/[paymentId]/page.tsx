import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { familyPage } from "@/lib/page";
import { getLang } from "@/lib/i18n/server";
import { getDb } from "@/lib/db/client";
import { receiptData } from "@/lib/services/fees";
import { Alert } from "@/components/ui";
import { PrintButton } from "@/components/ui/client";
import { Receipt } from "@/components/fees/receipt";

/** The receipt's tab title in the family's language; a receipt that isn't theirs is "not found" from the start (so the tab says so too). */
export async function generateMetadata({ params }: { params: Promise<{ paymentId: string }> }): Promise<Metadata> {
  const ctx = await familyPage();
  const { paymentId } = await params;
  const data = await receiptData(await getDb(), paymentId);
  if (!data || data.studentId !== ctx.studentId || data.schoolId !== ctx.schoolId) notFound();
  return { title: (await getLang()) === "hi" ? "रसीद" : "Receipt" };
}

export default async function FamilyReceiptPage({ params, searchParams }: { params: Promise<{ paymentId: string }>; searchParams: Promise<{ paid?: string }> }) {
  const ctx = await familyPage();
  const { t } = ctx;
  const { paymentId } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const data = await receiptData(db, paymentId);
  // Only this family's own payments; anything else looks exactly like a missing receipt.
  if (!data || data.studentId !== ctx.studentId || data.schoolId !== ctx.schoolId) notFound();

  return (
    <div className="mx-auto max-w-[52rem]">
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link href="/my/fees" className="inline-flex min-h-11 items-center gap-2 font-semibold text-forest-800 hover:text-forest-900">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t("Back to fees", "फ़ीस पर वापस जाएँ")}
        </Link>
        <PrintButton label={t("Print or save receipt", "रसीद प्रिंट या सेव करें")} variant="primary" />
      </div>

      {sp.paid === "1" && data.status === "completed" ? (
        <Alert tone="green" title={t("Payment received. Thank you!", "भुगतान प्राप्त हुआ। धन्यवाद!")} className="no-print mb-5">
          {t(`Your receipt number is ${data.receiptNo}. Keep it for your records.`, `आपकी रसीद संख्या ${data.receiptNo} है। इसे संभालकर रखें।`)}
        </Alert>
      ) : null}
      {data.status === "reversed" ? (
        <Alert tone="red" title={t("This receipt was cancelled", "यह रसीद रद्द कर दी गई है")} className="no-print mb-5">
          {t(
            "The payment was reversed by the school office. Please contact the office if you have a question.",
            "विद्यालय कार्यालय ने यह भुगतान रद्द किया है। कोई प्रश्न हो तो कार्यालय से संपर्क करें।",
          )}
        </Alert>
      ) : null}

      <Receipt data={data} />
    </div>
  );
}
