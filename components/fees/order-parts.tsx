/**
 * What an online payment pays, line by line (the pay pages): the admission
 * fee, then tuition — "Term I — Class X: ₹5,000 of ₹9,000" — and the notice
 * for a payment whose fees changed after it was started.
 */
import { formatDate, type Lang } from "@/lib/dates";
import { rupees } from "@/lib/services/fees";
import type { FamilyOrder } from "@/lib/services/payments";
import { cancelOrderAction } from "@/app/(app)/my/fees/actions";
import { ActionForm } from "@/components/forms";
import { Alert, Money } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";

export function OrderParts({ parts, lang }: { parts: FamilyOrder["parts"]; lang: Lang }) {
  const t = (en: string, hi: string) => (lang === "hi" ? hi : en);
  if (!parts.length) return null;
  return (
    <ul className="mt-5 divide-y divide-forest-900/10 border-y border-forest-900/10">
      {parts.map((c) => (
        <li key={c.id} className="flex items-start justify-between gap-4 py-3">
          <span className="min-w-0">
            <span className="block font-semibold text-forest-900">{lang === "hi" ? c.labelHi : c.label}</span>
            <span className="block text-[0.88rem] text-muted">
              {c.kind === "admission"
                ? t("One-time fee", "केवल एक बार")
                : c.amount < c.lineAmount
                  ? t(`Part of this instalment (${rupees(c.lineAmount)})`, `इस किस्त (${rupees(c.lineAmount)}) का हिस्सा`)
                  : `${t("Due date", "देय तिथि")}: ${formatDate(c.dueOn, lang)}`}
            </span>
          </span>
          <Money paise={c.amount} className="shrink-0 font-semibold text-forest-900" />
        </li>
      ))}
    </ul>
  );
}

/**
 * An open order whose fees changed since it was started (the office recorded
 * a payment for them, or a fee was waived): nothing to pay here — cancel it
 * and start again, so the family never pays more than the fees they chose.
 */
export function StaleOrderNotice({ orderId, lang }: { orderId: string; lang: Lang }) {
  const t = (en: string, hi: string) => (lang === "hi" ? hi : en);
  return (
    <div className="grid gap-4">
      <Alert tone="amber" title={t("The fees have changed", "फ़ीस बदल गई है")}>
        {t(
          "The fees due have changed since you started this payment (for example, the school recorded a payment), so this amount is more than is now due. If money was already taken from your account for it, the receipt will appear on the Fees page shortly — please don't pay again until then. Otherwise, cancel this payment and start again.",
          "आपके यह भुगतान शुरू करने के बाद देय फ़ीस बदल गई है (जैसे, विद्यालय ने कोई भुगतान दर्ज किया है), इसलिए यह राशि अब देय राशि से अधिक है। यदि इसके लिए आपके खाते से पैसा पहले ही कट चुका है, तो रसीद जल्द ही फ़ीस पृष्ठ पर दिखेगी — तब तक दोबारा भुगतान न करें। अन्यथा यह भुगतान रद्द करें और फिर से शुरू करें।",
        )}
      </Alert>
      <ActionForm action={cancelOrderAction.bind(null, orderId)} className="gap-2">
        <SubmitButton size="lg" className="w-full" pendingLabel={t("Cancelling…", "रद्द हो रहा है…")}>
          {t("Cancel and start again", "रद्द करें और फिर से शुरू करें")}
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
