/**
 * The printed fee receipt. Bilingual labels (English · हिंदी), amount in
 * figures and in words, and a CANCELLED watermark for reversed payments.
 * Refunds made later are listed under the receipt, which itself stays as it
 * was issued. Sized to fit half an A4 sheet; "full" stretches it over a whole page.
 */
import clsx from "clsx";
import type { ReactNode } from "react";
import { SchoolCrest } from "@/components/brand/emblems";
import { classLabel, classLabelHi } from "@/lib/classes";
import { formatDate, todayIST } from "@/lib/dates";
import { amountInWords, amountInWordsHi, METHOD_LABELS, rupees, type ReceiptData } from "@/lib/services/fees";
import { REFUND_METHOD_LABELS } from "@/lib/services/refunds";

function Hi({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span lang="hi" className={clsx("font-normal", className)}>
      {children}
    </span>
  );
}

/** "Receipt no. · रसीद संख्या" */
function Label({ en, hi }: { en: string; hi: string }) {
  return (
    <dt className="text-[0.7rem] font-bold uppercase tracking-[0.08em] text-muted">
      {en} <span aria-hidden>·</span> <Hi className="text-[0.78rem]">{hi}</Hi>
    </dt>
  );
}

function Item({ en, hi, children, className }: { en: string; hi: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("min-w-0", className)}>
      <Label en={en} hi={hi} />
      <dd className="mt-0.5 break-words text-[0.95rem] font-semibold text-forest-900">{children}</dd>
    </div>
  );
}

export function Receipt({ data, size = "half", copyLabel }: { data: ReceiptData; size?: "half" | "full"; copyLabel?: { en: string; hi: string } }) {
  const cancelled = data.status === "reversed";
  const s = data.student;
  const classText = s.className ? classLabel(s.className, s.stream, s.sectionName) : "—";
  const classHi = s.className ? classLabelHi(s.className, s.stream, s.sectionName) : "";
  const method = METHOD_LABELS[data.method];
  const online = data.method === "online";
  const opening = data.method === "opening";
  const total = data.amount;

  return (
    <article
      aria-label={`Fee receipt ${data.receiptNo}${cancelled ? " (cancelled)" : ""}`}
      className={clsx(
        "relative overflow-hidden bg-cream-50 text-ink ring-1 ring-forest-900/20 print:break-inside-avoid print:bg-white",
        "rounded-[1.25rem] print:rounded-md",
        // Half: scaled down in print so one receipt fits half an A4 sheet (two copies fit on one). Full: fills the page.
        size === "half" ? "p-5 sm:p-6 print:p-[5mm] print:[zoom:0.8]" : "p-6 sm:p-9 print:min-h-[232mm] print:p-[8mm] print:[zoom:1.12]",
      )}
    >
      {cancelled ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <div className="-rotate-[24deg] select-none rounded-2xl border-[6px] border-clay-600/35 px-8 py-3 text-center text-clay-600/35 print:border-clay-600/45 print:text-clay-600/45">
            <p className="font-display text-[clamp(2.8rem,9vw,4.8rem)] font-semibold leading-none tracking-[0.12em]">CANCELLED</p>
            <p lang="hi" className="mt-1 text-[clamp(1.6rem,5vw,2.4rem)] font-semibold leading-none">
              रद्द
            </p>
          </div>
        </div>
      ) : null}

      <header className="flex items-start justify-between gap-4 border-b-2 border-forest-800 pb-3">
        <div className="flex min-w-0 items-start gap-3">
          <SchoolCrest school={data.school.id} className="mt-0.5 h-11 w-11 shrink-0 text-forest-700" />
          <div className="min-w-0">
            <p className="font-display text-[1.3rem] leading-tight text-forest-900">{data.school.name}</p>
            <p lang="hi" className="font-hindi text-[1.02rem] leading-snug text-forest-900">
              {data.school.nameHi}
            </p>
            <p className="mt-0.5 text-[0.78rem] leading-snug text-muted">
              {data.school.place}, Rajasthan
              {data.school.phone ? ` · Phone ${data.school.phone}` : ""}
              {data.school.email ? ` · ${data.school.email}` : ""}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-display text-[1.05rem] leading-tight text-forest-900">Fee receipt</p>
          <p lang="hi" className="text-[0.95rem] leading-snug text-forest-900">
            फ़ीस रसीद
          </p>
          {copyLabel ? (
            <p className="mt-1 inline-block rounded-full bg-cream-200 px-2 py-0.5 text-[0.7rem] font-bold uppercase tracking-[0.08em] text-forest-800 print:border print:border-forest-900/30">
              {copyLabel.en} · <Hi>{copyLabel.hi}</Hi>
            </p>
          ) : null}
        </div>
      </header>

      <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2.5 sm:grid-cols-4 print:grid-cols-4">
        <Item en="Receipt no." hi="रसीद संख्या">
          <span className="whitespace-nowrap tabular">{data.receiptNo}</span>
        </Item>
        <Item en="Date" hi="दिनांक">
          <span className="tabular">{formatDate(data.paidOn, "en")}</span>
          <Hi className="block text-[0.8rem] font-normal text-muted">{formatDate(data.paidOn, "hi")}</Hi>
        </Item>
        <Item en="Session" hi="सत्र">
          <span className="tabular">{data.sessionId}</span>
        </Item>
        <Item en="SR No." hi="एस.आर. नं.">
          <span className="tabular">{s.srNo}</span>
        </Item>
        <Item en="Student" hi="विद्यार्थी" className="col-span-2">
          {s.name}
        </Item>
        <Item en="Class" hi="कक्षा">
          {classText}
          {classHi ? <Hi className="block text-[0.8rem] font-normal text-muted">{classHi}</Hi> : null}
        </Item>
        {s.fatherName ? (
          <Item en="Father's name" hi="पिता का नाम">
            {s.fatherName}
          </Item>
        ) : null}
      </dl>

      <table className="mt-3 w-full border-collapse text-[0.92rem]">
        <caption className="sr-only">Fees paid with this receipt</caption>
        <thead>
          <tr className="border-y border-forest-900/25 text-left">
            <th scope="col" className="py-1.5 pr-3 text-[0.7rem] font-bold uppercase tracking-[0.08em] text-muted">
              Particulars · <Hi className="text-[0.78rem]">विवरण</Hi>
            </th>
            <th scope="col" className="py-1.5 text-right text-[0.7rem] font-bold uppercase tracking-[0.08em] text-muted">
              Amount · <Hi className="text-[0.78rem]">राशि</Hi>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.chargeId} className="border-b border-forest-900/10 align-top">
              <td className="py-1.5 pr-3">
                <span className="font-semibold text-forest-900">{l.label}</span>
                <Hi className="block text-[0.8rem] leading-snug text-muted">{l.labelHi}</Hi>
              </td>
              <td className="py-1.5 text-right font-semibold tabular">{rupees(l.amount)}</td>
            </tr>
          ))}
          {data.unallocated > 0 ? (
            <tr className="border-b border-forest-900/10 align-top">
              <td className="py-1.5 pr-3">
                {data.unallocatedRefunded >= data.unallocated ? (
                  <>
                    <span className="font-semibold text-forest-900">Paid beyond the fees due (refunded)</span>
                    <Hi className="block text-[0.8rem] text-muted">देय फ़ीस से अधिक जमा (वापस की गई)</Hi>
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-forest-900">Paid beyond the fees due (to be refunded)</span>
                    <Hi className="block text-[0.8rem] text-muted">देय फ़ीस से अधिक जमा (वापस की जाएगी)</Hi>
                  </>
                )}
              </td>
              <td className="py-1.5 text-right font-semibold tabular">{rupees(data.unallocated)}</td>
            </tr>
          ) : null}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="pt-2 pr-3 text-left font-display text-[1.05rem] font-normal text-forest-900">
              Total · <Hi>कुल</Hi>
            </th>
            <td className="pt-2 text-right font-display text-[1.35rem] text-forest-900 tabular">{rupees(total)}</td>
          </tr>
        </tfoot>
      </table>

      <p className="mt-1.5 text-[0.88rem] text-forest-900">
        <span className="text-[0.7rem] font-bold uppercase tracking-[0.08em] text-muted">
          In words · <Hi className="text-[0.78rem]">शब्दों में</Hi>:
        </span>{" "}
        <strong className="font-semibold">{amountInWords(total)}</strong>
        <Hi className="block font-semibold">{amountInWordsHi(total)}</Hi>
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2.5 border-t border-dashed border-forest-900/25 pt-3">
        <Item en="Paid by" hi="भुगतान का माध्यम">
          {method.en} · <Hi>{method.hi}</Hi>
          {data.reference && !online && !opening ? <span className="block text-[0.82rem] font-normal text-muted">{data.reference}</span> : null}
          {opening ? <span className="block text-[0.82rem] font-normal text-muted">{data.reference ?? "Paid before the portal (paper receipt)"}</span> : null}
        </Item>
        {online ? (
          <Item en="Paid online" hi="ऑनलाइन भुगतान">
            <span className="block text-[0.85rem] font-normal">
              {data.provider === "mock" ? "Test checkout (no money moved)" : "Razorpay"}
              {data.reference && data.provider !== "mock" ? ` · ${data.reference.toUpperCase()}` : ""}
            </span>
            <span className="block break-all text-[0.82rem] font-normal text-muted tabular">Payment ID {data.providerPaymentId}</span>
          </Item>
        ) : opening ? (
          <Item en="Recorded by" hi="दर्ज करने वाले">
            {data.recordedByName ?? "School office"}
          </Item>
        ) : (
          <Item en="Received by" hi="प्राप्तकर्ता">
            {data.recordedByName ?? "School office"}
          </Item>
        )}
      </dl>

      {data.refunds.length ? (
        <section aria-label="Refunds on this receipt" className="mt-3 rounded-xl bg-ochre-50 px-3 py-2 text-[0.85rem] text-forest-900 ring-1 ring-ochre-500/30 print:bg-white">
          <p className="text-[0.7rem] font-bold uppercase tracking-[0.08em] text-muted">
            Refunded · <Hi className="text-[0.78rem]">वापस किया गया</Hi>
          </p>
          <ul className="mt-1 grid gap-0.5">
            {data.refunds.map((r) => (
              <li key={r.id}>
                <strong className="font-semibold tabular">{rupees(r.amount)}</strong> on {formatDate(r.refundedOn, "en")} · {REFUND_METHOD_LABELS[r.method].en} ·{" "}
                <Hi>{REFUND_METHOD_LABELS[r.method].hi}</Hi> · voucher <span className="whitespace-nowrap tabular">{r.voucherNo}</span>
                {r.method !== "online" && r.note ? <span className="text-muted"> — {r.note.replace(/[.!?]+$/, "")}</span> : null}
              </li>
            ))}
          </ul>
          <p className="mt-1 font-semibold">
            Net paid · <Hi>शुद्ध जमा</Hi>: <span className="tabular">{rupees(Math.max(0, total - data.refunded))}</span>
          </p>
        </section>
      ) : null}

      {cancelled ? (
        <p className="relative z-20 mt-3 rounded-xl bg-clay-50 px-3 py-2 text-[0.85rem] text-forest-900 ring-1 ring-clay-500/30 print:bg-white">
          <strong className="font-bold text-clay-600">
            CANCELLED · <Hi>रद्द</Hi>
          </strong>
          {data.reversal ? ` on ${formatDate(todayIST(data.reversal.at), "en")}${data.reversal.byName ? ` by ${data.reversal.byName}` : ""}` : ""}
          {data.reversalNote ? ` — ${data.reversalNote.replace(/[.!?]+$/, "")}` : ""}. This receipt is not valid for any payment.
        </p>
      ) : null}

      <footer className="mt-3 flex items-end justify-between gap-6 text-[0.72rem] leading-snug text-muted">
        <p className="max-w-[26rem]">
          Computer-generated receipt from the AESRI Campus Portal. Fees as per the school&rsquo;s approved fee structure. <Hi>यह कंप्यूटर द्वारा बनी रसीद है।</Hi>
        </p>
        {!online ? (
          <p className="shrink-0 text-center">
            <span className="block h-7 w-40 border-b border-forest-900/40" aria-hidden />
            Signature / seal · <Hi>हस्ताक्षर / मुहर</Hi>
          </p>
        ) : null}
      </footer>
    </article>
  );
}
