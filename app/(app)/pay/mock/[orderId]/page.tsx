import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, FlaskConical } from "lucide-react";
import { familyPage } from "@/lib/page";
import { getLang } from "@/lib/i18n/server";
import { getDb } from "@/lib/db/client";
import { testPaymentsAllowed } from "@/lib/env";
import { rupees } from "@/lib/services/fees";
import { familyOrder } from "@/lib/services/payments";
import { ActionForm } from "@/components/forms";
import { Alert, ButtonLink, Money } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { eyebrowFor } from "@/components/fees/text";
import { Countdown } from "@/components/fees/client";
import { OrderParts, StaleOrderNotice } from "@/components/fees/order-parts";
import { mockFailAction, mockPayAction } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "टेस्ट भुगतान" : "Test payment" };
}

export default async function MockCheckoutPage({ params }: { params: Promise<{ orderId: string }> }) {
  const ctx = await familyPage();
  // The test checkout doesn't exist on a real server (see testPaymentsAllowed).
  if (!testPaymentsAllowed()) notFound();
  const { t, lang } = ctx;
  const { orderId } = await params;
  const db = await getDb();
  const order = await familyOrder(db, orderId, ctx.studentId);
  if (!order || order.provider !== "mock") notFound();
  if (order.status === "paid" && order.paymentId) redirect(`/my/fees/receipts/${order.paymentId}`);
  const schoolName = lang === "hi" ? ctx.school.nameHi : ctx.school.name;

  return (
    <div className="mx-auto max-w-xl">
      <Link href="/my/fees" className="mb-5 inline-flex min-h-11 items-center gap-2 font-semibold text-forest-800 hover:text-forest-900">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t("Back to fees", "फ़ीस पर वापस जाएँ")}
      </Link>

      <div
        role="note"
        className="mb-6 rounded-2xl border-2 border-dashed border-ochre-500 bg-[repeating-linear-gradient(135deg,var(--color-ochre-50)_0_14px,var(--color-cream-50)_14px_28px)] px-5 py-4 text-center"
      >
        <p className="inline-flex items-center gap-2 font-display text-[1.35rem] font-semibold text-ochre-600">
          <FlaskConical className="h-6 w-6" aria-hidden />
          TEST PAYMENT — no money moves
        </p>
        <p lang="hi" className="text-[1.05rem] font-semibold text-ochre-600">
          टेस्ट भुगतान — कोई पैसा नहीं कटेगा
        </p>
        <p className="mt-1 text-[0.88rem] text-forest-900/80">
          {t(
            "The portal's built-in test checkout, used until the school's payment account is ready.",
            "यह पोर्टल का टेस्ट भुगतान पृष्ठ है, जब तक विद्यालय का भुगतान खाता तैयार नहीं होता।",
          )}
        </p>
      </div>

      <section aria-labelledby="checkout-title" className="card p-6 sm:p-7">
        <p className={eyebrowFor(lang)}>{t("Paying to", "भुगतान प्राप्तकर्ता")}</p>
        <h1 id="checkout-title" className="mt-1 text-[1.6rem] text-forest-900">
          {schoolName}
        </h1>
        <p className="mt-1 text-muted">{t(`Fees for ${ctx.student.name}`, `${ctx.student.name} की फ़ीस`)}</p>

        <OrderParts parts={order.parts} lang={lang} />
        <div className="mt-4 flex items-end justify-between gap-4">
          <p className={eyebrowFor(lang)}>{t("Amount", "राशि")}</p>
          <p className="font-display text-[2.2rem] leading-none text-forest-900">
            <Money paise={order.amount} />
          </p>
        </div>

        {order.isOpen && order.stale ? (
          <div className="mt-6">
            <StaleOrderNotice orderId={order.id} lang={lang} />
          </div>
        ) : order.isOpen ? (
          <div className="mt-6 grid gap-3">
            <p className="text-[0.9rem] text-muted">
              {t("Time left to pay:", "भुगतान के लिए बचा समय:")} <Countdown until={order.expiresAt.toISOString()} expiredLabel={t("timed out", "समय समाप्त")} />
            </p>
            <ActionForm action={mockPayAction.bind(null, order.id)} className="gap-3">
              <SubmitButton size="lg" className="w-full" pendingLabel={t("Paying…", "भुगतान हो रहा है…")}>
                {t(`Pay ${rupees(order.amount)} (test)`, `${rupees(order.amount)} का भुगतान करें (टेस्ट)`)}
              </SubmitButton>
            </ActionForm>
            <ActionForm action={mockFailAction.bind(null, order.id)} className="gap-3">
              <SubmitButton variant="secondary" size="lg" className="w-full" pendingLabel={t("Please wait…", "कृपया प्रतीक्षा करें…")}>
                {t("Make this payment fail (test)", "इस भुगतान को असफल करें (टेस्ट)")}
              </SubmitButton>
            </ActionForm>
          </div>
        ) : (
          <div className="mt-6 grid gap-4">
            <Alert
              tone="amber"
              title={
                order.status === "created" || order.status === "expired"
                  ? t("This payment timed out", "इस भुगतान का समय समाप्त हो गया")
                  : t("This payment is closed", "यह भुगतान बंद हो चुका है")
              }
            >
              {t("No money was taken. Go back to Fees to start again.", "कोई पैसा नहीं कटा। फिर से शुरू करने के लिए फ़ीस पृष्ठ पर जाएँ।")}
            </Alert>
            <ButtonLink href="/my/fees" size="lg">
              {t("Back to fees", "फ़ीस पर वापस जाएँ")}
            </ButtonLink>
          </div>
        )}
      </section>
      <p className="mt-4 text-center text-[0.8rem] text-muted tabular">
        {t("Order", "ऑर्डर")} {order.providerOrderId ?? order.id}
      </p>
    </div>
  );
}
