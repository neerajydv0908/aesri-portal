/**
 * Printed sign-in slips: 8 to an A4 sheet (2 × 4) with dashed cut lines.
 * Each slip has the organisation's name in English and Hindi, the person,
 * the login ID, the one-time code, its last day, the portal address, a QR
 * code that opens the activation page and three short bilingual steps.
 *
 * Presentational only (no hooks), so the client result panel can use it.
 */
import clsx from "clsx";
import type { ReactNode } from "react";
import { formatDate } from "@/lib/dates";
import { SLIPS_PER_SHEET, type SlipBatch, type SlipData } from "./slip-types";

export { SLIPS_PER_SHEET };

function Hi({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span lang="hi" className={className}>
      {children}
    </span>
  );
}

function Label({ en, hi }: { en: string; hi: string }) {
  return (
    <span className="text-[0.78em] font-bold uppercase tracking-[0.06em] text-forest-900/70">
      {en} · <Hi>{hi}</Hi>
    </span>
  );
}

/** The portal address with break opportunities only after a "/" (never mid-word on screen). */
function Address({ value }: { value: string }) {
  const pieces = value.split("/");
  const parts = pieces.map((piece, i) => (i < pieces.length - 1 ? `${piece}/` : piece)).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 ? <wbr /> : null}
        </span>
      ))}
    </>
  );
}

function Slip({ slip, org, address }: { slip: SlipData; org: SlipBatch["org"]; address: string }) {
  const forgot =
    org.kind === "aesri"
      ? { en: "if you forget it, ask another AESRI administrator for a new slip.", hi: "भूल जाएँ तो किसी अन्य एईएसआरआई प्रशासक से नई पर्ची लें।" }
      : { en: "if you forget it, ask the school office for a new slip.", hi: "भूल जाएँ तो विद्यालय कार्यालय से नई पर्ची लें।" };
  return (
    <article
      aria-label={`Slip for ${slip.name}, login ID ${slip.loginId}`}
      className={clsx(
        "@container flex min-w-0 flex-col overflow-hidden rounded-xl border border-dashed border-forest-900/55 bg-white p-4 text-[0.9rem] leading-snug text-ink",
        // In print each slip fills a 95 × 69 mm grid cell and overlaps its neighbours by 1px, so shared cut lines print once.
        "print:-mb-px print:-mr-px print:rounded-none print:border-forest-900/60 print:p-[3.2mm] print:text-[7.4pt] print:leading-[1.28]",
      )}
    >
      {/* Always side by side in print (the sheet's layout is fixed). On screen only when the slip is wide enough
          for the whole school name and address; otherwise stacked, with the name wrapping rather than cut off. */}
      <header className="flex flex-col gap-1 border-b border-forest-900/25 pb-[0.35em] @min-[34rem]:flex-row @min-[34rem]:items-start @min-[34rem]:justify-between @min-[34rem]:gap-3 print:flex-row print:items-start print:justify-between print:gap-3">
        <div className="min-w-0">
          <p className="break-words font-display text-[1.22em] leading-tight text-forest-900 print:truncate">{org.name}</p>
          <Hi className="block break-words font-hindi text-[1.08em] leading-tight text-forest-900 print:truncate">{org.nameHi}</Hi>
        </div>
        <p className="min-w-0 leading-tight @min-[34rem]:text-right print:text-right">
          <Label en="Portal" hi="पोर्टल" />
          <strong className="block break-words text-[1.05em] text-forest-900 print:break-all">
            <Address value={address} />
          </strong>
        </p>
      </header>

      <div className="mt-[0.55em] flex gap-[0.9em]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={slip.qr}
          alt={`QR code that opens the activation page for ${slip.loginId}`}
          width={96}
          height={96}
          className="h-24 w-24 shrink-0 print:h-[23mm] print:w-[23mm]"
        />
        <div className="min-w-0 flex-1">
          <p className="break-words text-[1.12em] font-bold text-forest-900 print:truncate">{slip.name}</p>
          {slip.detail ? <p className="break-words text-forest-900/75 print:truncate">{slip.detail}</p> : null}
          <p className="mt-[0.35em] flex flex-wrap items-baseline gap-x-[0.5em]">
            <Label en="Login ID" hi="लॉगिन आईडी" />
            <strong className="text-[1.3em] tabular text-forest-900">{slip.loginId}</strong>
          </p>
          <p className="mt-[0.2em]">
            <Label en="One-time code" hi="एक-बार वाला कोड" />
          </p>
          <p className="font-mono text-[1.95em] font-bold leading-[1.1] tracking-[0.06em] text-black">{slip.code}</p>
          <p className="mt-[0.3em] font-semibold text-forest-900">
            Valid until {formatDate(slip.validUntil)} · <Hi className="font-semibold">{formatDate(slip.validUntil, "hi")} तक मान्य</Hi>
          </p>
        </div>
      </div>

      <ol className="mt-[0.5em] grid gap-[0.15em] text-[0.9em] text-forest-900">
        <li>
          <strong>1.</strong> Open the address or scan the code. <Hi>पता खोलें या कोड स्कैन करें।</Hi>
        </li>
        <li>
          <strong>2.</strong> Enter the login ID and the one-time code. <Hi>लॉगिन आईडी और एक-बार वाला कोड लिखें।</Hi>
        </li>
        <li>
          <strong>3.</strong> Choose your own password — keep it private; {forgot.en} <Hi>अपना पासवर्ड चुनें और गोपनीय रखें; {forgot.hi}</Hi>
        </li>
      </ol>
    </article>
  );
}

/** The slips, grouped into A4 sheets of eight. */
export function SlipSheets({ batch }: { batch: SlipBatch }) {
  const sheets: SlipData[][] = [];
  for (let i = 0; i < batch.slips.length; i += SLIPS_PER_SHEET) sheets.push(batch.slips.slice(i, i + SLIPS_PER_SHEET));
  return (
    <div className="grid gap-6 print:block">
      {sheets.map((sheet, i) => (
        <section key={i} aria-label={sheets.length > 1 ? `Sheet ${i + 1} of ${sheets.length}` : "Slips"} className="print:break-after-page print:last:break-after-auto">
          {sheets.length > 1 ? (
            <p className="no-print mb-2 text-[0.85rem] font-semibold text-muted">
              Sheet {i + 1} of {sheets.length} · slips {i * SLIPS_PER_SHEET + 1}–{i * SLIPS_PER_SHEET + sheet.length}
            </p>
          ) : null}
          {/* In print: 2 columns of 95 mm, rows of 69 mm — 8 slips fill an A4 sheet inside its 10 mm margins. */}
          <div className="grid gap-3 sm:grid-cols-2 print:grid print:w-[190mm] print:grid-cols-2 print:auto-rows-[69mm] print:gap-0">
            {sheet.map((s) => (
              <Slip key={s.loginId} slip={s} org={batch.org} address={batch.address} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
