import type { Metadata } from "next";
import Link from "next/link";
import { Banknote, CalendarClock, ChevronRight, Phone, ReceiptText, ShieldCheck } from "lucide-react";
import { familyPage } from "@/lib/page";
import { getLang } from "@/lib/i18n/server";
import { getDb } from "@/lib/db/client";
import { classLabel, classLabelHi } from "@/lib/classes";
import { formatDate, formatDateTime, todayIST } from "@/lib/dates";
import { annualFeeFor, currentPlan, familyPayable, isAdmissionLine, ledger, METHOD_LABELS, rupees } from "@/lib/services/fees";
import { onlinePaymentsAvailable, openOrderFor, orderExpiresAt } from "@/lib/services/payments";
import { CASH_CLAIM_LIMITS, familyClaims } from "@/lib/services/cash-claims";
import { familyTexts } from "@/lib/translate";
import { ActionForm, FieldError } from "@/components/forms";
import { Flash } from "@/components/flash";
import { Alert, Badge, ButtonLink, Card, CardTitle, EmptyState, Money, PageHeader } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { annualFeeSentence } from "@/components/fees/annual-fee";
import { ClaimStatus, LineStatus } from "@/components/fees/status";
import { eyebrowFor } from "@/components/fees/text";
import { AmountChips, Countdown, PayTotal, RememberedChoice, RememberedInput } from "@/components/fees/client";
import { FamilyText } from "@/components/translate/family-text";
import { TranslationSummary } from "@/components/translate/translated-note";
import { cancelOrderAction, payAction, withdrawCashAction } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "फ़ीस" : "Fees" };
}

export default async function MyFeesPage({ searchParams }: { searchParams: Promise<{ payment?: string; done?: string }> }) {
  const ctx = await familyPage();
  const { t, lang } = ctx;
  const sp = await searchParams;
  const db = await getDb();
  const [{ lines, payments, refunds, totals }, openOrder, online, plan, claims] = await Promise.all([
    ledger(db, ctx.studentId, ctx.sessionId),
    openOrderFor(db, ctx.studentId),
    onlinePaymentsAvailable(db),
    currentPlan(db, ctx.schoolId),
    familyClaims(db, ctx.studentId),
  ]);
  const today = todayIST();
  const label = (l: { label: string; labelHi: string }) => (lang === "hi" ? l.labelHi : l.label);
  const unpaid = lines.filter((l) => l.outstanding > 0);
  const nextDue = unpaid.filter((l) => l.dueOn > today).sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0] ?? null;
  // What can be paid now: the admission fee whole, tuition in any amount from ₹1,000 — less what is in cash records waiting for approval.
  const waiting = claims.filter((c) => c.status === "pending" && c.sessionId === ctx.sessionId);
  const payable = familyPayable(lines, waiting, today);
  const tuition = payable.tuition;
  const tuitionDefault = tuition && tuition.dueNow > 0 ? Math.max(tuition.dueNow, tuition.min) : 0;
  const chips = tuition
    ? [
        ...(tuition.min < tuition.max ? [{ label: t(`Least: ${rupees(tuition.min)}`, `न्यूनतम: ${rupees(tuition.min)}`), paise: tuition.min }] : []),
        ...(tuition.dueNow > tuition.min && tuition.dueNow < tuition.max ? [{ label: t(`Due now: ${rupees(tuition.dueNow)}`, `अभी देय: ${rupees(tuition.dueNow)}`), paise: tuition.dueNow }] : []),
        { label: t(`All for the session: ${rupees(tuition.max)}`, `पूरे सत्र की: ${rupees(tuition.max)}`), paise: tuition.max },
      ]
    : [];
  const waitingTotal = payable.pending.admission + payable.pending.tuition;
  // Less than the smallest payment is left beside the waiting cash: it can be paid once that is decided.
  const heldText = t(
    `The remaining ${rupees(payable.held)} of tuition can be paid once the school has decided on the cash you recorded.`,
    `बची हुई ${rupees(payable.held)} ट्यूशन फ़ीस, आपके दर्ज किए नकद पर विद्यालय का निर्णय होने के बाद जमा की जा सकेगी।`,
  );
  // The school's reasons for declining, in Hindi too.
  const say = await familyTexts(
    lang,
    claims.map((c) => c.declineReason),
  );
  const oldestOverdue = unpaid.filter((l) => l.dueOn < today).sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0] ?? null;
  const p = ctx.placement;
  const classText = p ? (lang === "hi" ? classLabelHi(p.className, p.stream, p.sectionName) : classLabel(p.className, p.stream, p.sectionName)) : null;
  // An RTE seat recorded after some fees were paid: what was paid stays on record (the office handles any refund).
  const paidEarlier = ctx.student.rte ? lines.reduce((a, l) => a + Math.min(l.paid, l.amount), 0) : 0;
  const schoolName = lang === "hi" ? ctx.school.nameHi : ctx.school.name;
  // What the child's class costs in a year (the fee is per student; RTE seats pay nothing, as the alert above the lines says).
  const annualFee = p && plan && !ctx.student.rte ? annualFeeFor(plan, p.className) : null;
  const annualText = annualFee && p ? annualFeeSentence(annualFee, p.className, p.stream, lang) : null;

  const statusAlert =
    sp.payment === "failed" ? (
      <Alert tone="red" title={t("The payment did not go through", "भुगतान पूरा नहीं हुआ")}>
        {t("No money was taken. You can try again below.", "कोई पैसा नहीं कटा। आप नीचे फिर से प्रयास कर सकते हैं।")}
      </Alert>
    ) : sp.payment === "expired" ? (
      <Alert tone="amber" title={t("The payment timed out", "भुगतान का समय समाप्त हो गया")}>
        {t("It was not completed within 30 minutes. Please start again.", "यह 30 मिनट में पूरा नहीं हुआ। कृपया फिर से शुरू करें।")}
      </Alert>
    ) : sp.payment === "cancelled" ? (
      <Alert tone="blue" title={t("The unfinished payment was cancelled", "अधूरा भुगतान रद्द कर दिया गया")}>
        {t("You can start a new payment below.", "आप नीचे नया भुगतान शुरू कर सकते हैं।")}
      </Alert>
    ) : sp.payment === "pending" ? (
      <Alert tone="amber" title={t("Confirming your payment", "आपके भुगतान की पुष्टि हो रही है")}>
        {t("It will appear here within a few minutes. Please don't pay again.", "यह कुछ ही मिनटों में यहाँ दिखेगा। कृपया दोबारा भुगतान न करें।")}
      </Alert>
    ) : null;

  return (
    <>
      <PageHeader
        eyebrow={<span className={lang === "hi" ? "text-[0.95rem]" : undefined}>{t(`Session ${ctx.sessionId}`, `सत्र ${ctx.sessionId}`)}</span>}
        title={t("Fees", "फ़ीस")}
        description={
          <>
            <span className="font-semibold text-forest-900">{ctx.student.name}</span>
            {classText ? ` · ${classText}` : ""} · {schoolName}
          </>
        }
      />

      <Flash
        code={sp.done}
        messages={{
          cash: t(
            "Your cash payment is recorded. If you paid offline, the school will approve it shortly — the receipt will then appear here.",
            "आपका नकद भुगतान दर्ज हो गया है। ऑफ़लाइन भुगतान को विद्यालय जल्द ही स्वीकृत करेगा — उसके बाद रसीद यहीं दिखेगी।",
          ),
          cash_again: t(
            "You had already recorded this cash payment a moment ago, so it was not recorded twice. It is waiting for the school's approval.",
            "यह नकद भुगतान आप अभी-अभी दर्ज कर चुके थे, इसलिए इसे दोबारा दर्ज नहीं किया गया। यह विद्यालय की स्वीकृति की प्रतीक्षा में है।",
          ),
          removed: t("The recorded cash payment was removed.", "दर्ज किया गया नकद भुगतान हटा दिया गया।"),
        }}
      />

      <TranslationSummary say={say} />

      <div className="grid gap-6">
        {statusAlert}

        {ctx.student.rte ? (
          paidEarlier ? (
            <Alert tone="green" title={t("RTE seat — no fees from now on", "RTE सीट — अब से कोई फ़ीस नहीं")}>
              {t(
                `Your child now studies on a seat under the Right to Education (RTE) Act, so no fees are charged from now on. The ${rupees(paidEarlier)} paid earlier this session stays on record, as shown below. For any refund, please ask the school office.`,
                `आपका बच्चा अब शिक्षा का अधिकार (RTE) अधिनियम के अंतर्गत सीट पर पढ़ता है, इसलिए अब से कोई फ़ीस नहीं ली जाएगी। इस सत्र में पहले जमा किए गए ${rupees(paidEarlier)} रिकॉर्ड में दर्ज रहेंगे, जैसा नीचे दिखाया गया है। किसी भी वापसी (रिफ़ंड) के लिए कृपया विद्यालय कार्यालय से पूछें।`,
              )}
            </Alert>
          ) : (
            <Alert tone="green" title={t("RTE seat — no fees", "RTE सीट — कोई फ़ीस नहीं")}>
              {t(
                "Your child studies on a seat under the Right to Education (RTE) Act. No fees are charged.",
                "आपका बच्चा शिक्षा का अधिकार (RTE) अधिनियम के अंतर्गत सीट पर पढ़ता है। कोई फ़ीस नहीं ली जाती।",
              )}
            </Alert>
          )
        ) : null}

        {!lines.length ? (
          <EmptyState icon={<ReceiptText className="h-6 w-6" aria-hidden />} title={t("No fees to show yet", "अभी कोई फ़ीस नहीं दिखाने के लिए")}>
            {t("The school office has not set up this session's fees for your child yet.", "विद्यालय कार्यालय ने इस सत्र की फ़ीस अभी तैयार नहीं की है।")}
          </EmptyState>
        ) : (
          <section aria-labelledby="summary-title" className="card overflow-hidden">
            <h2 id="summary-title" className="sr-only">
              {t("Summary", "सारांश")}
            </h2>
            <div className="grid gap-6 p-6 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] sm:p-7">
              <div>
                {totals.dueNow > 0 ? (
                  <>
                    <p className={eyebrowFor(lang)}>{t("Due now", "अभी देय")}</p>
                    <p className={`mt-2 font-display text-[2.6rem] leading-none tabular ${totals.overdue ? "text-clay-600" : "text-forest-900"}`}>
                      <Money paise={totals.dueNow} />
                    </p>
                    {oldestOverdue ? (
                      <p className="mt-3 flex items-start gap-2 font-semibold text-clay-600">
                        <CalendarClock className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                        {t(
                          `The due date (${formatDate(oldestOverdue.dueOn, "en")}) has passed. Please pay soon.`,
                          `देय तिथि (${formatDate(oldestOverdue.dueOn, "hi")}) बीत चुकी है। कृपया जल्दी जमा करें।`,
                        )}
                      </p>
                    ) : (
                      <p className="mt-3 font-semibold text-ochre-600">{t("Due today.", "आज देय है।")}</p>
                    )}
                  </>
                ) : totals.outstanding > 0 ? (
                  <>
                    <p className={eyebrowFor(lang)}>{t("Nothing due right now", "अभी कुछ देय नहीं")}</p>
                    <p className="mt-2 font-display text-[2rem] leading-tight text-forest-900">{t("You are up to date", "आपकी फ़ीस समय पर जमा है")}</p>
                  </>
                ) : (
                  <>
                    <p className={eyebrowFor(lang)}>{t("This session", "इस सत्र में")}</p>
                    <p className="mt-2 font-display text-[2rem] leading-tight text-forest-700">
                      {ctx.student.rte ? t("No fees to pay", "कोई फ़ीस नहीं") : t("All fees paid", "सभी फ़ीस जमा हो गई")}
                    </p>
                  </>
                )}
              </div>
              <dl className="grid content-start gap-4 border-t border-forest-900/10 pt-5 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
                <div>
                  <dt className={eyebrowFor(lang)}>{t("Next due date", "अगली देय तिथि")}</dt>
                  <dd className="mt-1 text-[1.05rem] font-semibold text-forest-900">
                    {nextDue ? (
                      <>
                        {formatDate(nextDue.dueOn, lang)} · <Money paise={nextDue.outstanding} />
                        <span className="block text-[0.88rem] font-normal text-muted">{label(nextDue)}</span>
                      </>
                    ) : (
                      <span className="font-normal text-muted">{t("None this session", "इस सत्र में कोई नहीं")}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className={eyebrowFor(lang)}>{t("Paid this session", "इस सत्र में जमा")}</dt>
                  <dd className="mt-1 text-[1.05rem] font-semibold text-forest-700">
                    <Money paise={totals.paid} />
                  </dd>
                </div>
                {totals.outstanding > totals.dueNow ? (
                  <div>
                    <dt className={eyebrowFor(lang)}>{t("Left for the session", "सत्र की शेष फ़ीस")}</dt>
                    <dd className="mt-1 text-[1.05rem] font-semibold text-forest-900">
                      <Money paise={totals.outstanding} />
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </section>
        )}

        {openOrder ? (
          <Card className="ring-2 ring-ochre-500/40">
            <CardTitle>{t("You have a payment in progress", "आपका एक भुगतान अधूरा है")}</CardTitle>
            <p className="text-[0.98rem] text-forest-900">
              {t(
                `${rupees(openOrder.amount)}, started ${formatDateTime(openOrder.createdAt, "en")}.`,
                `${rupees(openOrder.amount)}, ${formatDateTime(openOrder.createdAt, "hi")} को शुरू किया।`,
              )}{" "}
              <span className="text-muted">
                {t("Time left:", "बचा समय:")} <Countdown until={orderExpiresAt(openOrder).toISOString()} expiredLabel={t("timed out", "समय समाप्त")} />
              </span>
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <ButtonLink href={`/pay/${openOrder.provider}/${openOrder.id}`} size="lg">
                {t("Continue payment", "भुगतान जारी रखें")}
                <ChevronRight className="h-4 w-4" aria-hidden />
              </ButtonLink>
              <ActionForm action={cancelOrderAction.bind(null, openOrder.id)} className="gap-2">
                <SubmitButton variant="secondary" size="lg" pendingLabel={t("Cancelling…", "रद्द हो रहा है…")}>
                  {t("Cancel it", "इसे रद्द करें")}
                </SubmitButton>
              </ActionForm>
            </div>
          </Card>
        ) : null}

        {claims.length ? (
          <section id="cash-records" aria-labelledby="cash-title" className="card scroll-mt-24 p-5 sm:p-6">
            <h2 id="cash-title" className="font-display text-[1.25rem] text-forest-900">
              {t("Cash payments you recorded", "आपके दर्ज किए नकद भुगतान")}
            </h2>
            <ul className="mt-3 divide-y divide-forest-900/[0.07]">
              {claims.map((c) => {
                const reason = say(c.declineReason);
                return (
                  <li key={c.id} className="grid gap-1.5 py-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-forest-900">
                        <Money paise={c.amount} /> · {t(`paid in cash on ${formatDate(c.paidOn, "en")}`, `${formatDate(c.paidOn, "hi")} को नकद जमा`)}
                        {c.sessionId !== ctx.sessionId ? <span className="font-normal text-muted"> · {t(`session ${c.sessionId}`, `सत्र ${c.sessionId}`)}</span> : null}
                      </p>
                      <ClaimStatus status={c.status} lang={lang} />
                    </div>
                    {c.admissionAmount > 0 ? (
                      <p className="text-[0.88rem] text-muted">
                        {c.amount > c.admissionAmount
                          ? t(
                              `Admission fee ${rupees(c.admissionAmount)} and tuition ${rupees(c.amount - c.admissionAmount)}`,
                              `प्रवेश शुल्क ${rupees(c.admissionAmount)} और ट्यूशन फ़ीस ${rupees(c.amount - c.admissionAmount)}`,
                            )
                          : t("Admission fee", "प्रवेश शुल्क")}
                      </p>
                    ) : null}
                    {c.status === "pending" ? (
                      <>
                        <p className="text-forest-900">
                          {t(
                            "If you paid offline, the school will approve it shortly. It counts as paid, with a receipt here, once approved.",
                            "ऑफ़लाइन भुगतान को विद्यालय जल्द ही स्वीकृत करेगा। स्वीकृत होते ही यह जमा माना जाएगा और रसीद यहीं दिखेगी।",
                          )}
                        </p>
                        <ActionForm action={withdrawCashAction.bind(null, c.id)} className="gap-2">
                          <div>
                            <ConfirmSubmit
                              question={t("Remove this record?", "यह रिकॉर्ड हटाएँ?")}
                              confirmLabel={t("Yes, remove it", "हाँ, हटाएँ")}
                              cancelLabel={t("Keep it", "रहने दें")}
                            >
                              {t("Recorded by mistake? Remove it", "गलती से दर्ज हुआ? हटाएँ")}
                            </ConfirmSubmit>
                          </div>
                        </ActionForm>
                      </>
                    ) : c.status === "approved" && c.paymentId && c.receiptStatus === "reversed" ? (
                      <div className="grid gap-1">
                        <p className="font-semibold text-clay-600">
                          {t(
                            `The school approved it, but later cancelled the receipt ${c.receiptNo ?? ""}, so it is not counted as paid. Please contact the school office.`,
                            `विद्यालय ने इसे स्वीकृत किया था, पर बाद में रसीद ${c.receiptNo ?? ""} रद्द कर दी, इसलिए इसे जमा नहीं माना गया। कृपया विद्यालय कार्यालय से संपर्क करें।`,
                          )}
                        </p>
                        <Link href={`/my/fees/receipts/${c.paymentId}`} className="inline-flex min-h-11 items-center gap-1 self-start font-semibold text-forest-800 underline-offset-4 hover:underline">
                          {t("See the receipt", "रसीद देखें")}
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        </Link>
                      </div>
                    ) : c.status === "approved" && c.paymentId ? (
                      <Link href={`/my/fees/receipts/${c.paymentId}`} className="inline-flex min-h-11 items-center gap-1 self-start font-semibold text-forest-800 underline-offset-4 hover:underline">
                        {t(`Approved by the school — see receipt ${c.receiptNo ?? ""}`, `विद्यालय ने स्वीकृत किया — रसीद ${c.receiptNo ?? ""} देखें`)}
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      </Link>
                    ) : c.status === "declined" ? (
                      <div className="grid gap-1.5 rounded-xl bg-clay-50 px-4 py-3 ring-1 ring-clay-500/30">
                        <p className="font-semibold text-clay-600">
                          {t(
                            "The school declined this payment, so it is not counted as paid. Please contact the school office as soon as possible.",
                            "विद्यालय ने यह भुगतान अस्वीकार कर दिया है, इसलिए इसे जमा नहीं माना गया। कृपया जल्द से जल्द विद्यालय कार्यालय से संपर्क करें।",
                          )}
                        </p>
                        {reason ? (
                          <div className="text-forest-900">
                            <span className="font-semibold">{t("The school's note: ", "विद्यालय की टिप्पणी: ")}</span>
                            <FamilyText value={reason} as="span" />
                          </div>
                        ) : null}
                        {ctx.school.phone ? (
                          <a href={`tel:${ctx.school.phone.replace(/\s/g, "")}`} className="inline-flex min-h-11 items-center gap-2 self-start font-semibold text-forest-800 underline underline-offset-2">
                            <Phone className="h-4 w-4" aria-hidden />
                            <span className="tabular">{ctx.school.phone}</span>
                          </a>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {(payable.admission || tuition) && !openOrder && !ctx.student.rte ? (
          <Card>
            <CardTitle action={online.ok && online.test ? <Badge tone="amber">{t("Test mode", "टेस्ट मोड")}</Badge> : null}>{t("Pay fees", "फ़ीस जमा करें")}</CardTitle>
            <ActionForm action={payAction} className="group">
              {payable.admission ? (
                <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl bg-cream-50 px-4 py-3 ring-1 ring-forest-900/15 transition-shadow has-[:checked]:bg-sage-50 has-[:checked]:ring-2 has-[:checked]:ring-forest-700">
                  <RememberedChoice
                    name="admission"
                    value="1"
                    defaultChecked
                    data-amount={payable.admission.amount}
                    className="h-6 w-6 shrink-0 cursor-pointer accent-forest-700"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-forest-900">{t("Admission fee", "प्रवेश शुल्क")}</span>
                    <span className="block text-[0.88rem] text-muted">
                      {t("A fixed amount, paid only once — when your child joins the school.", "एक तय राशि, जो केवल एक बार — बच्चे के विद्यालय में प्रवेश के समय — जमा होती है।")}
                    </span>
                  </span>
                  <Money paise={payable.admission.amount} className="shrink-0 text-[1.05rem] font-semibold text-forest-900" />
                </label>
              ) : null}

              {tuition ? (
                <div className="grid gap-2">
                  <label htmlFor="tuition" className="text-[0.98rem] font-semibold text-forest-900">
                    {t("Tuition fee: how much do you want to pay? (₹)", "ट्यूशन फ़ीस: आप कितनी राशि जमा करना चाहते हैं? (₹)")}
                  </label>
                  <RememberedInput
                    id="tuition"
                    name="tuition"
                    inputMode="numeric"
                    autoComplete="off"
                    defaultValue={tuitionDefault ? String(tuitionDefault / 100) : ""}
                    placeholder={t(`e.g. ${tuition.min / 100}`, `जैसे ${tuition.min / 100}`)}
                    aria-describedby="tuition-hint tuition-error"
                    className="max-w-xs text-lg font-semibold tabular"
                  />
                  <AmountChips target="tuition" choices={chips} label={t("Ready amounts", "तैयार राशियाँ")} />
                  <p id="tuition-hint" className="text-[0.88rem] text-muted">
                    {tuition.min < tuition.max
                      ? t(
                          `Any amount from ${rupees(tuition.min)} up to ${rupees(tuition.max)} (what is left for this session). It goes to the oldest instalment first.`,
                          `${rupees(tuition.min)} से ${rupees(tuition.max)} तक कोई भी राशि (इस सत्र की बची हुई फ़ीस)। यह पहले सबसे पुरानी किस्त में जमा होगी।`,
                        )
                      : t(`${rupees(tuition.max)} of tuition is left for this session: pay it in one go.`, `इस सत्र की ${rupees(tuition.max)} ट्यूशन फ़ीस बाकी है: इसे एक साथ जमा करें।`)}
                  </p>
                  <FieldError name="tuition" />
                </div>
              ) : null}

              {waitingTotal ? (
                <p className="text-[0.92rem] text-forest-900">
                  {t(
                    `${rupees(waitingTotal)} in cash you recorded is waiting for the school's approval, so it isn't asked for again here.`,
                    `आपके दर्ज किए ${rupees(waitingTotal)} नकद विद्यालय की स्वीकृति की प्रतीक्षा में हैं, इसलिए यहाँ दोबारा नहीं माँगे जा रहे।`,
                  )}
                  {payable.held ? ` ${heldText}` : ""}
                </p>
              ) : null}

              <fieldset className="grid gap-2.5">
                <legend className="mb-2 text-[0.98rem] font-semibold text-forest-900">{t("How are you paying?", "आप कैसे भुगतान कर रहे हैं?")}</legend>
                {online.ok ? (
                  <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl bg-cream-50 px-4 py-3 ring-1 ring-forest-900/15 has-[:checked]:bg-sage-50 has-[:checked]:ring-2 has-[:checked]:ring-forest-700 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ochre-500">
                    <RememberedChoice type="radio" name="how" value="online" defaultChecked id="how-online" className="h-5 w-5 shrink-0 cursor-pointer accent-forest-700" />
                    <ShieldCheck className="h-5 w-5 shrink-0 text-forest-700" aria-hidden />
                    <span className="min-w-0">
                      <span className="block font-semibold text-forest-900">{t("Pay online now", "अभी ऑनलाइन भुगतान करें")}</span>
                      <span className="block text-[0.88rem] text-muted">{t("UPI, card or net banking", "UPI, कार्ड या नेट बैंकिंग")}</span>
                    </span>
                  </label>
                ) : null}
                <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl bg-cream-50 px-4 py-3 ring-1 ring-forest-900/15 has-[:checked]:bg-sage-50 has-[:checked]:ring-2 has-[:checked]:ring-forest-700 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ochre-500">
                  <RememberedChoice type="radio" name="how" value="cash" defaultChecked={!online.ok} id="how-cash" className="h-5 w-5 shrink-0 cursor-pointer accent-forest-700" />
                  <Banknote className="h-5 w-5 shrink-0 text-forest-700" aria-hidden />
                  <span className="min-w-0">
                    <span className="block font-semibold text-forest-900">{t("I have paid in cash at the school", "मैंने विद्यालय में नकद जमा किया है")}</span>
                    <span className="block text-[0.88rem] text-muted">
                      {t("Record it here. The school checks it, then approves it.", "यहाँ दर्ज करें। विद्यालय इसे जाँचकर स्वीकृत करेगा।")}
                    </span>
                  </span>
                </label>
              </fieldset>

              {/* Only for cash (shown when "cash" is chosen; always shown when it is the only way). */}
              <div className={online.ok ? "hidden gap-4 group-has-[#how-cash:checked]:grid sm:grid-cols-2" : "grid gap-4 sm:grid-cols-2"}>
                <div className="grid content-start gap-1.5">
                  <label htmlFor="paidOn" className="text-[0.95rem] font-semibold text-forest-900">
                    {t("The day you paid", "भुगतान की तारीख")}
                  </label>
                  <RememberedInput key={`paid-${today}`} id="paidOn" name="paidOn" type="date" defaultValue={today} max={today} aria-describedby="paidOn-error" />
                  <FieldError name="paidOn" />
                </div>
                <div className="grid content-start gap-1.5">
                  <label htmlFor="note" className="text-[0.95rem] font-semibold text-forest-900">
                    {t("Who did you give it to? (if you like)", "पैसे किसे दिए? (चाहें तो लिखें)")}
                  </label>
                  <RememberedInput id="note" name="note" autoComplete="off" maxLength={CASH_CLAIM_LIMITS.note} placeholder={t("e.g. at the office, to the class teacher", "जैसे: कार्यालय में, कक्षा अध्यापक को")} />
                </div>
              </div>

              <div className="flex flex-wrap items-end justify-between gap-4 border-t border-forest-900/10 pt-4">
                <div>
                  <p className={eyebrowFor(lang)}>{t("Total", "कुल राशि")}</p>
                  <div className="mt-2">
                    <PayTotal
                      initial={(payable.admission?.amount ?? 0) + tuitionDefault}
                      tuitionName="tuition"
                      label={t("Total", "कुल राशि")}
                      emptyLabel={t("Nothing chosen yet", "अभी कुछ नहीं चुना")}
                    />
                  </div>
                </div>
                <SubmitButton size="lg" pendingLabel={t("Please wait…", "कृपया प्रतीक्षा करें…")} className="w-full sm:w-auto">
                  {online.ok ? (
                    <>
                      <span className="inline-flex items-center gap-2 group-has-[#how-cash:checked]:hidden">
                        <ShieldCheck className="h-5 w-5" aria-hidden />
                        {t("Continue to pay online", "ऑनलाइन भुगतान के लिए आगे बढ़ें")}
                      </span>
                      <span className="hidden items-center gap-2 group-has-[#how-cash:checked]:inline-flex">
                        <Banknote className="h-5 w-5" aria-hidden />
                        {t("Record cash payment", "नकद भुगतान दर्ज करें")}
                      </span>
                    </>
                  ) : (
                    <>
                      <Banknote className="h-5 w-5" aria-hidden />
                      {t("Record cash payment", "नकद भुगतान दर्ज करें")}
                    </>
                  )}
                </SubmitButton>
              </div>
              <p className="text-[0.88rem] text-muted">
                {online.ok ? (
                  <span className="group-has-[#how-cash:checked]:hidden">
                    {online.provider === "mock"
                      ? t("This is the portal's test checkout: no money moves.", "यह पोर्टल का टेस्ट भुगतान है: कोई पैसा नहीं कटेगा।")
                      : online.test
                        ? t("This is Razorpay's test checkout: no money moves.", "यह Razorpay का टेस्ट भुगतान है: कोई पैसा नहीं कटेगा।")
                        : t(
                            "You will see the amount again before paying. A receipt appears here as soon as the payment is done.",
                            "भुगतान से पहले आपको राशि फिर से दिखेगी। भुगतान होते ही रसीद यहाँ दिखेगी।",
                          )}
                  </span>
                ) : (
                  <span>{t("Online payment is not available yet.", "ऑनलाइन भुगतान अभी उपलब्ध नहीं है।")} </span>
                )}
                <span className={online.ok ? "hidden group-has-[#how-cash:checked]:inline" : undefined}>
                  {t(
                    "Only record money you have already handed over at the school. It counts as paid once the principal or the office approves it — usually within a day or two.",
                    "केवल वही राशि दर्ज करें जो आप विद्यालय में दे चुके हैं। प्रधानाचार्य या कार्यालय की स्वीकृति के बाद यह जमा मानी जाएगी — आमतौर पर एक-दो दिन में।",
                  )}
                </span>
              </p>
            </ActionForm>
          </Card>
        ) : openOrder ? null : unpaid.length && !ctx.student.rte && waitingTotal ? (
          <Alert tone="blue" title={t("Waiting for the school's approval", "विद्यालय की स्वीकृति की प्रतीक्षा")}>
            {payable.held
              ? `${t("Once the school approves the cash payments you recorded, the receipts appear here.", "विद्यालय के आपके दर्ज किए नकद भुगतान स्वीकृत करते ही रसीदें यहाँ दिखेंगी।")} ${heldText}`
              : t(
                  "The cash payments you recorded cover what is left to pay. Once the school approves them, the receipts appear here.",
                  "आपके दर्ज किए नकद भुगतान बची हुई पूरी फ़ीस के बराबर हैं। विद्यालय के स्वीकृत करते ही रसीदें यहाँ दिखेंगी।",
                )}
          </Alert>
        ) : null}

        {lines.length ? (
          <section aria-labelledby="lines-title">
            <h2 id="lines-title" className="mb-3 font-display text-[1.35rem] text-forest-900">
              {t("Fee details", "फ़ीस का विवरण")}
            </h2>
            {annualText ? <p className="mb-4 max-w-3xl text-[1rem] leading-relaxed text-forest-900">{annualText}</p> : null}
            <ul className="card divide-y divide-forest-900/[0.07]">
              {lines.map((l) => (
                <li key={l.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-6">
                  <div className="min-w-0">
                    <p className="font-semibold text-forest-900">{label(l)}</p>
                    <p className="text-[0.9rem] text-muted">
                      {isAdmissionLine(l)
                        ? t("Charged only once, when your child joined the school — not again in later years.", "केवल एक बार, बच्चे के विद्यालय में प्रवेश के समय — आगे के वर्षों में दोबारा नहीं।")
                        : `${t("Due date", "देय तिथि")}: ${formatDate(l.dueOn, lang)}`}
                    </p>
                    <div className="mt-1.5">
                      <LineStatus line={l} today={today} lang={lang} />
                    </div>
                    {l.waived && l.paid > 0 && l.amount > l.paid ? (
                      <p className="mt-1.5 text-[0.88rem] text-muted">
                        {t(
                          `${rupees(l.amount - l.paid)} waived. The ${rupees(l.paid)} paid earlier stays on record.`,
                          `${rupees(l.amount - l.paid)} माफ़। पहले जमा किए गए ${rupees(l.paid)} रिकॉर्ड में दर्ज रहेंगे।`,
                        )}
                      </p>
                    ) : null}
                  </div>
                  <dl className="grid grid-cols-3 gap-4 text-[0.9rem] sm:text-right">
                    <div>
                      <dt className="text-muted">{t("Fee", "फ़ीस")}</dt>
                      <dd className="font-semibold text-forest-900">
                        <Money paise={l.amount} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">{t("Paid", "जमा")}</dt>
                      <dd className="font-semibold text-forest-700">
                        <Money paise={l.paid} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">{t("Balance", "बकाया")}</dt>
                      <dd className={`font-semibold ${l.outstanding && l.dueOn < today ? "text-clay-600" : "text-forest-900"}`}>
                        <Money paise={l.outstanding} />
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="receipts-title">
          <h2 id="receipts-title" className="mb-3 font-display text-[1.35rem] text-forest-900">
            {t("Payments and receipts", "भुगतान और रसीदें")}
          </h2>
          {payments.length ? (
            <ul className="card divide-y divide-forest-900/[0.07]">
              {[...payments].reverse().map((pay) => {
                const m = METHOD_LABELS[pay.method];
                const cancelled = pay.status === "reversed";
                const own = refunds.filter((r) => r.paymentId === pay.id && r.status === "completed");
                return (
                  <li key={pay.id}>
                    <Link href={`/my/fees/receipts/${pay.id}`} className="flex min-h-16 items-center gap-4 px-5 py-3.5 hover:bg-cream-200/40 sm:px-6">
                      <ReceiptText className="h-6 w-6 shrink-0 text-forest-700" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className={`block font-semibold ${cancelled ? "text-muted line-through" : "text-forest-900"}`}>
                          <Money paise={pay.amount} /> · {lang === "hi" ? m.hi : m.en}
                        </span>
                        <span className="block text-[0.88rem] text-muted">
                          {formatDate(pay.paidOn, lang)} · {t("Receipt", "रसीद")} <span className="whitespace-nowrap tabular">{pay.receiptNo}</span>
                        </span>
                        {cancelled ? (
                          <span className="mt-1 block">
                            <Badge tone="red">{t("Cancelled", "रद्द")}</Badge>
                          </span>
                        ) : null}
                        {own.map((r) => (
                          <span key={r.id} className="mt-1 block text-[0.88rem] font-semibold text-ochre-600">
                            {t(`${rupees(r.amount)} refunded on ${formatDate(r.refundedOn, lang)}`, `${rupees(r.amount)} ${formatDate(r.refundedOn, lang)} को वापस किए गए`)}
                          </span>
                        ))}
                      </span>
                      <span className="hidden shrink-0 text-[0.9rem] font-semibold text-forest-800 sm:inline">{t("View receipt", "रसीद देखें")}</span>
                      <ChevronRight className="h-5 w-5 shrink-0 text-forest-800" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title={t("No payments yet", "अभी कोई भुगतान नहीं")}>
              {t("Receipts for fees you pay will appear here.", "आपके द्वारा जमा की गई फ़ीस की रसीदें यहाँ दिखेंगी।")}
            </EmptyState>
          )}
        </section>

        {ctx.school.phone ? (
          <p className="flex flex-wrap items-center gap-2 text-[0.95rem] text-muted">
            <Phone className="h-4 w-4" aria-hidden />
            {t("Questions about fees? Call the school office:", "फ़ीस के बारे में प्रश्न? विद्यालय कार्यालय को फ़ोन करें:")}{" "}
            <a href={`tel:${ctx.school.phone.replace(/\s/g, "")}`} className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline underline-offset-2 tabular">
              {ctx.school.phone}
            </a>
          </p>
        ) : null}
      </div>
    </>
  );
}
