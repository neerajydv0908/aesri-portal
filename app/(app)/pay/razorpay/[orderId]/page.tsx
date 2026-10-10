import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ArrowLeft, Lock } from "lucide-react";
import { familyPage } from "@/lib/page";
import { getLang } from "@/lib/i18n/server";
import { getDb } from "@/lib/db/client";
import { students } from "@/lib/db/schema";
import { rupees } from "@/lib/services/fees";
import { familyOrder } from "@/lib/services/payments";
import { razorpayKeyId } from "@/lib/payments";
import { Alert, ButtonLink, Money } from "@/components/ui";
import { eyebrowFor } from "@/components/fees/text";
import { Countdown } from "@/components/fees/client";
import { OrderParts, StaleOrderNotice } from "@/components/fees/order-parts";
import { RazorpayCheckout } from "./checkout";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "फ़ीस भुगतान" : "Pay fees" };
}

export default async function RazorpayCheckoutPage({ params }: { params: Promise<{ orderId: string }> }) {
  const ctx = await familyPage();
  const { t, lang } = ctx;
  const { orderId } = await params;
  const db = await getDb();
  const order = await familyOrder(db, orderId, ctx.studentId);
  if (!order || order.provider !== "razorpay") notFound();
  if (order.status === "paid" && order.paymentId) redirect(`/my/fees/receipts/${order.paymentId}`);
  const keyId = razorpayKeyId();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const [s] = await db.select({ mobile: students.guardianMobile }).from(students).where(eq(students.id, ctx.studentId));
  const secondsLeft = Math.floor((order.expiresAt.getTime() - Date.now()) / 1000);
  const payable = order.isOpen && !order.stale && !!order.providerOrderId && !!keyId && secondsLeft > 30;

  return (
    <div className="mx-auto max-w-xl">
      <Link href="/my/fees" className="mb-5 inline-flex min-h-11 items-center gap-2 font-semibold text-forest-800 hover:text-forest-900">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t("Back to fees", "फ़ीस पर वापस जाएँ")}
      </Link>

      <section aria-labelledby="pay-title" className="card p-6 sm:p-7">
        <p className={eyebrowFor(lang)}>{t("Pay fees online", "ऑनलाइन फ़ीस भुगतान")}</p>
        <h1 id="pay-title" className="mt-1 text-[1.6rem] text-forest-900">
          {lang === "hi" ? ctx.school.nameHi : ctx.school.name}
        </h1>
        <p className="mt-1 text-muted">{t(`Fees for ${ctx.student.name}`, `${ctx.student.name} की फ़ीस`)}</p>

        <OrderParts parts={order.parts} lang={lang} />
        <div className="mt-4 flex items-end justify-between gap-4">
          <p className={eyebrowFor(lang)}>{t("Amount", "राशि")}</p>
          <p className="font-display text-[2.2rem] leading-none text-forest-900">
            <Money paise={order.amount} />
          </p>
        </div>

        <div className="mt-6">
          {payable ? (
            <>
              <RazorpayCheckout
                nonce={nonce}
                keyId={keyId!}
                orderId={order.id}
                providerOrderId={order.providerOrderId!}
                amount={order.amount}
                name={ctx.school.name}
                description={`Fees · ${ctx.student.name} · SR ${ctx.student.srNo}`}
                contact={s?.mobile ? `+91${s.mobile}` : null}
                lang={lang}
                secondsLeft={secondsLeft}
                text={{
                  pay: t(`Pay ${rupees(order.amount)}`, `${rupees(order.amount)} का भुगतान करें`),
                  loading: t("Loading secure payment…", "सुरक्षित भुगतान खुल रहा है…"),
                  confirming: t("Confirming your payment… please don't close this page.", "आपके भुगतान की पुष्टि हो रही है… कृपया यह पृष्ठ बंद न करें।"),
                  failed: t("The payment did not go through. You can try again.", "भुगतान पूरा नहीं हुआ। आप फिर से प्रयास कर सकते हैं।"),
                  dismissed: t(
                    "The payment window was closed. Nothing was paid. You can open it again.",
                    "भुगतान विंडो बंद हो गई। कोई भुगतान नहीं हुआ। आप इसे फिर से खोल सकते हैं।",
                  ),
                  loadFailed: t(
                    "The payment page could not be loaded. Check your internet connection and try again.",
                    "भुगतान पृष्ठ नहीं खुल सका। इंटरनेट जाँचें और फिर से प्रयास करें।",
                  ),
                  backToFees: t("Go to Fees", "फ़ीस पृष्ठ पर जाएँ"),
                }}
              />
              <p className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[0.85rem] text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="h-4 w-4" aria-hidden />
                  {t("Secure payment by Razorpay", "Razorpay द्वारा सुरक्षित भुगतान")}
                </span>
                <span>
                  {t("Time left", "बचा समय")} <Countdown until={order.expiresAt.toISOString()} expiredLabel={t("timed out", "समय समाप्त")} />
                </span>
              </p>
            </>
          ) : order.isOpen && order.stale ? (
            <StaleOrderNotice orderId={order.id} lang={lang} />
          ) : (
            <div className="grid gap-4">
              <Alert
                tone="amber"
                title={
                  order.status === "created" || order.status === "expired"
                    ? t("This payment timed out", "इस भुगतान का समय समाप्त हो गया")
                    : t("This payment is closed", "यह भुगतान बंद हो चुका है")
                }
              >
                {t(
                  "If money was taken from your account, the receipt will appear on the Fees page shortly. Otherwise, go back and start again.",
                  "यदि आपके खाते से पैसा कटा है, तो रसीद जल्द ही फ़ीस पृष्ठ पर दिखेगी। अन्यथा वापस जाकर फिर से शुरू करें।",
                )}
              </Alert>
              <ButtonLink href="/my/fees" size="lg">
                {t("Back to fees", "फ़ीस पर वापस जाएँ")}
              </ButtonLink>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
