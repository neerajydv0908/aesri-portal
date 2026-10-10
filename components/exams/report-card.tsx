/**
 * A printable A4 report card (progress report) for one student and one exam,
 * with bilingual labels (English · हिंदी). Server component; the page adds
 * the Print button. Each card starts on a new page when printed.
 */
import clsx from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { SchoolCrest } from "@/components/brand/emblems";
import { classLabel, classLabelHi } from "@/lib/classes";
import { formatDate, todayIST } from "@/lib/dates";
import { langOfText } from "@/lib/i18n";
import type { ReportCardSet, ReportCardStudent } from "@/lib/services/exams";
import { examNameHi, formatMarks, formatPercent } from "./rules";
import { OutcomeLabel, OverallIcon, overallText } from "./status";

function Bi({ en, hi, className }: { en: ReactNode; hi: ReactNode; className?: string }) {
  return (
    <span className={className}>
      {en}
      <span className="px-1 text-forest-900/40" aria-hidden>
        ·
      </span>
      <span lang="hi">{hi}</span>
    </span>
  );
}

function Detail({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("border-b border-dotted border-forest-900/25 pb-1", className)}>
      <dt className="text-[0.74rem] text-muted">{label}</dt>
      <dd className="font-semibold leading-snug text-forest-900">{children}</dd>
    </div>
  );
}

/** "Class V-B", "LKG-A", "Class XI-A (Arts)" and the Hindi "कक्षा 5-B". */
function classSection(className: string, stream: string | null, section: string) {
  return { en: classLabel(className, stream, section), hi: classLabelHi(className, stream, section) };
}

const cellBorder = "border border-forest-700/35";

/**
 * How much to shrink the card when printed so it stays on one A4 page: an
 * estimate of its printed height (CSS px at A4 width) from the parts that
 * vary — the subject rows and the remarks box — against the page (A4 less
 * the 10 mm margins). Measured with Chromium; checked by printing to PDF.
 */
export function printZoom(subjects: number, remark: string | null, blankRemark: boolean): number {
  const FIXED = 830; // header, details, result and attendance boxes, signatures, footer
  const ROW = subjects > 8 ? 23 : 27; // one subject row (dense rows are tighter)
  const LINE = 19; // one printed line of the remark
  const CHARS = 86; // characters in a printed line of the remark
  const box = remark ? 42 + LINE * remark.split("\n").reduce((a, l) => a + (l.trim() ? Math.ceil(l.trim().length / CHARS) : 0), 0) : blankRemark ? 90 : 0;
  const height = FIXED + ROW * subjects + box;
  const PAGE = 1030;
  return height <= PAGE ? 1 : Math.max(0.6, Math.floor((PAGE / height) * 100) / 100);
}

/**
 * `blankRemark`: with no remark saved, show an empty remarks box (ruled lines
 * when printed, so the class teacher can write by hand). Families' cards
 * leave the box out instead.
 */
export function ReportCard({ set, student, blankRemark = true }: { set: ReportCardSet; student: ReportCardStudent; blankRemark?: boolean }) {
  const draft = set.state.status !== "published";
  const r = student.result;
  const att = student.attendance;
  const sec = set.section;
  const examHi = examNameHi(set.exam.name);
  const attPct = att.days ? Math.round((att.present * 1000) / att.days) : null;
  const cs = classSection(sec.className, sec.stream, sec.name);
  // Many subjects: tighter rows when printed, so the card still fits one A4 page.
  const dense = r.lines.length > 8;
  const zoom = printZoom(r.lines.length, student.remark, blankRemark);
  const rowPad = dense ? "py-1 print:py-0" : "py-1.5 print:py-0.5";

  return (
    <article
      lang="en"
      aria-label={`Report card: ${student.name}`}
      className={clsx(
        "report-card mx-auto w-full min-w-0 max-w-[210mm] break-inside-avoid break-after-page bg-white text-ink shadow-[0_18px_40px_-30px_rgba(19,39,28,0.5)] ring-1 ring-forest-900/10 [print-color-adjust:exact] last:break-after-auto print:max-w-none print:shadow-none print:ring-0",
        // The site-wide "Skip to content" link is fixed-position and would print on every page.
        "print:[body:has(&)>a[href='#main']]:hidden",
      )}
    >
      <div
        className={clsx(
          "relative m-2 overflow-hidden border-[3px] border-double border-forest-700 px-4 py-5 sm:m-3 sm:px-8 sm:py-6 print:m-0 print:px-6 print:py-4",
          // Many subjects or a long remark: print smaller so the card still fits one A4 page.
          zoom < 1 && "print:[zoom:var(--print-zoom)]",
        )}
        style={zoom < 1 ? ({ "--print-zoom": String(zoom) } as CSSProperties) : undefined}
      >
        {draft ? (
          // Decorative watermark (the page already says the results are a draft), drawn with CSS
          // generated text so it isn't read out or treated as body text.
          <p
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-[42%] z-0 -translate-x-1/2 -translate-y-1/2 -rotate-[30deg] select-none whitespace-nowrap text-center font-display text-[4.5rem] leading-none text-ochre-500/20"
          >
            <span data-mark="DRAFT · प्रारूप" className="block before:content-[attr(data-mark)]" />
            <span data-mark="Not published · अभी घोषित नहीं" className="mt-2 block text-[1.1rem] text-ochre-600/60 before:content-[attr(data-mark)]" />
          </p>
        ) : null}

        <header className="flex items-center gap-3 border-b-2 border-forest-700/70 pb-3 sm:gap-5">
          <SchoolCrest school={set.school.id} className="h-12 w-12 shrink-0 text-forest-700 sm:h-14 sm:w-14" />
          <div className="min-w-0 flex-1 text-center">
            <p className="font-display text-[1.35rem] leading-tight tracking-[-0.01em] text-forest-900 sm:text-[1.65rem]">{set.school.name}</p>
            <p lang="hi" className="font-hindi text-[1.15rem] leading-snug text-forest-800 sm:text-[1.3rem]">
              {set.school.nameHi}
            </p>
            <p className="text-[0.76rem] text-muted">{set.school.place}</p>
          </div>
          <span className="h-12 w-12 shrink-0 sm:h-14 sm:w-14" aria-hidden />
        </header>

        <div className="mt-3 text-center">
          <h2 className="font-display text-[1.25rem] text-forest-900 sm:text-[1.4rem]">
            <Bi en="Progress report" hi="प्रगति पत्र" />
          </h2>
          <p className="mt-1 text-[0.92rem] text-forest-900">
            <Bi en={set.exam.name} hi={examHi} className="font-semibold" />
            <span className="px-2 text-forest-900/40" aria-hidden>
              |
            </span>
            <Bi en="Session" hi="सत्र" /> {set.sessionId}
          </p>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5 text-[0.9rem] sm:grid-cols-3">
          <Detail label={<Bi en="Student" hi="विद्यार्थी" />} className="col-span-2 sm:col-span-1">
            {student.name}
          </Detail>
          <Detail label={<Bi en="SR No." hi="एस.आर. क्रमांक" />}>
            <span className="tabular">{student.srNo}</span>
          </Detail>
          <Detail label={<Bi en="Roll No." hi="अनुक्रमांक" />}>
            <span className="tabular">{student.rollNo ?? "—"}</span>
          </Detail>
          <Detail label={<Bi en="Class" hi="कक्षा" />}>
            {cs.en}
            <span className="px-1 font-normal text-forest-900/40" aria-hidden>
              ·
            </span>
            <span lang="hi" className="font-normal">
              {cs.hi}
            </span>
          </Detail>
          <Detail label={<Bi en="Father's name" hi="पिता का नाम" />}>{student.fatherName ?? "—"}</Detail>
          <Detail label={<Bi en="Mother's name" hi="माता का नाम" />}>{student.motherName ?? "—"}</Detail>
        </dl>

        {/*
          On a phone (below `sm`) the table fits the screen: no Maximum column (the marks read "18.5 / 25"),
          the Hindi subject name on its own line, slightly smaller text and tighter cells. From `sm` up, and
          always in print, it is the full A4 table as before. If a very narrow screen still needs a sideways
          scroll, the region can be scrolled with the keyboard.
        */}
        <div
          className="relative mt-4 overflow-x-auto print:overflow-visible"
          tabIndex={0}
          role="region"
          aria-label={`Marks in ${set.exam.name} for ${student.name}`}
        >
          <table
            className={clsx(
              "w-full border-collapse text-[0.84rem] sm:min-w-[33rem] sm:text-[0.88rem] print:min-w-0",
              dense ? "print:text-[0.82rem]" : "print:text-[0.88rem]",
            )}
          >
            <caption className="sr-only">
              Marks in {set.exam.name} for {student.name}
            </caption>
            <thead className="bg-sage-100 text-forest-900">
              <tr className="align-bottom">
                <th scope="col" className={clsx(cellBorder, "px-1.5 py-1.5 text-left font-semibold sm:px-2.5 print:px-2.5")}>
                  Subject{" "}
                  <span lang="hi" className="block font-normal">
                    विषय
                  </span>
                </th>
                <th scope="col" className={clsx(cellBorder, "hidden w-[4.25rem] px-2 py-1.5 text-right font-semibold sm:table-cell print:table-cell")}>
                  Maximum{" "}
                  <span lang="hi" className="block font-normal">
                    पूर्णांक
                  </span>
                </th>
                <th scope="col" className={clsx(cellBorder, "px-1.5 py-1.5 text-right font-semibold sm:w-[4.25rem] sm:px-2 print:w-[4.25rem] print:px-2")}>
                  Marks{" "}
                  <span lang="hi" className="block font-normal">
                    प्राप्तांक
                  </span>
                </th>
                <th scope="col" className={clsx(cellBorder, "px-1.5 py-1.5 text-right font-semibold sm:w-[4.25rem] sm:px-2 print:w-[4.25rem] print:px-2")}>
                  %{" "}
                  <span lang="hi" className="block font-normal">
                    प्रतिशत
                  </span>
                </th>
                <th scope="col" className={clsx(cellBorder, "px-1.5 py-1.5 text-left font-semibold sm:w-[11rem] sm:px-2.5 print:w-[11rem] print:px-2.5")}>
                  Result{" "}
                  <span lang="hi" className="block font-normal">
                    परिणाम
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.subjectId}>
                  <th scope="row" className={clsx(cellBorder, rowPad, "px-1.5 text-left font-semibold text-forest-900 sm:px-2.5 print:px-2.5")}>
                    {l.name}
                    {l.nameHi ? (
                      <>
                        <span className="hidden px-1 font-normal text-forest-900/40 sm:inline print:inline" aria-hidden>
                          ·
                        </span>
                        <span lang="hi" className="block font-normal text-forest-900/80 sm:inline print:inline">
                          {l.nameHi}
                        </span>
                      </>
                    ) : null}
                  </th>
                  <td className={clsx(cellBorder, rowPad, "tabular hidden px-2 text-right sm:table-cell print:table-cell")}>{l.maxMarks}</td>
                  <td className={clsx(cellBorder, rowPad, "tabular px-1.5 text-right font-semibold sm:px-2 print:px-2")}>
                    {l.outcome === "absent" ? "AB" : l.outcome === "missing" ? "—" : formatMarks(l.tenths)}
                    <span className="block whitespace-nowrap font-normal text-muted sm:hidden print:hidden">/ {l.maxMarks}</span>
                  </td>
                  <td className={clsx(cellBorder, rowPad, "tabular px-1.5 text-right sm:px-2 print:px-2")}>{formatPercent(l.percent)}</td>
                  <td className={clsx(cellBorder, rowPad, "px-1.5 text-[0.8rem] sm:px-2.5 print:px-2.5")}>
                    <OutcomeLabel outcome={l.outcome} lang="both" />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-cream-100 font-bold text-forest-900">
                <th scope="row" className={clsx(cellBorder, "px-1.5 py-2 text-left sm:px-2.5 print:px-2.5")}>
                  <Bi en="Total" hi="कुल योग" />
                </th>
                <td className={clsx(cellBorder, "tabular hidden px-2 py-2 text-right sm:table-cell print:table-cell")}>{r.maxTotal || "—"}</td>
                <td className={clsx(cellBorder, "tabular px-1.5 py-2 text-right sm:px-2 print:px-2")}>
                  {r.outcome === "absent" ? "AB" : r.maxTotal ? formatMarks(r.totalTenths) : "—"}
                  {r.maxTotal ? <span className="block whitespace-nowrap font-normal text-muted sm:hidden print:hidden">/ {r.maxTotal}</span> : null}
                </td>
                <td className={clsx(cellBorder, "tabular px-1.5 py-2 text-right sm:px-2 print:px-2")}>{formatPercent(r.percent)}</td>
                <td className={cellBorder} />
              </tr>
            </tfoot>
          </table>
        </div>
        {r.missing.length ? (
          <p className="mt-1 text-[0.74rem] leading-snug text-muted">
            <Bi
              en={`Marks not entered: ${r.missing.map((l) => l.name).join(", ")} — not counted in the total.`}
              hi={`अंक दर्ज नहीं: ${r.missing.map((l) => l.nameHi ?? l.name).join(", ")} — कुल योग में शामिल नहीं।`}
            />
          </p>
        ) : null}

        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="flex items-start gap-3 rounded-lg border-2 border-forest-700/50 bg-sage-50 px-4 py-2.5">
            <OverallIcon outcome={r.outcome} className="mt-1 h-6 w-6 shrink-0" />
            <div className="min-w-0">
              <p className="text-[0.74rem] font-bold text-muted">
                Result · <span lang="hi">परिणाम</span>
              </p>
              <p className="font-display text-[1rem] leading-snug text-forest-900">{overallText(r, "en")}</p>
              <p lang="hi" className="font-hindi text-[0.98rem] leading-snug text-forest-900">
                {overallText(r, "hi")}
              </p>
            </div>
          </div>
          <div className="rounded-lg border border-forest-700/35 px-4 py-2.5">
            <p className="text-[0.74rem] font-bold leading-snug text-muted">
              Attendance, session so far
              <span lang="hi" className="block">
                उपस्थिति (सत्र में अब तक)
              </span>
            </p>
            {att.days ? (
              <>
                <p className="mt-0.5 font-semibold text-forest-900">
                  <span className="tabular">
                    {att.present} / {att.days}
                  </span>{" "}
                  days present <span className="font-normal text-muted">({formatPercent(attPct)})</span>
                </p>
                <p lang="hi" className="text-[0.92rem] text-forest-900">
                  {att.days} में से {att.present} दिन उपस्थित
                </p>
              </>
            ) : (
              <p className="mt-0.5 text-[0.92rem] text-forest-900">
                <Bi en="No register taken yet" hi="अभी कोई उपस्थिति दर्ज नहीं" />
              </p>
            )}
          </div>
        </div>

        {student.remark || blankRemark ? (
          <div className="mt-3 break-inside-avoid rounded-lg border border-forest-700/35 px-4 py-2.5">
            <p className="text-[0.74rem] font-bold leading-snug text-muted">
              Class teacher&rsquo;s remarks · <span lang="hi">कक्षाध्यापक की टिप्पणी</span>
            </p>
            {student.remark ? (
              <div className="mt-0.5 text-[0.9rem] leading-snug text-forest-900 [font-variant-ligatures:none] print:text-[0.84rem]">
                {student.remark.split("\n").map((line, i) =>
                  line.trim() ? (
                    <p key={i} lang={langOfText(line)} className={langOfText(line) === "hi" ? "font-hindi leading-normal print:leading-snug" : undefined}>
                      {line}
                    </p>
                  ) : null,
                )}
              </div>
            ) : (
              <>
                <p className="mt-0.5 text-[0.85rem] text-muted print:hidden">Not written yet.</p>
                <div aria-hidden className="hidden print:block">
                  <div className="h-6 border-b border-dotted border-forest-900/40" />
                  <div className="h-6 border-b border-dotted border-forest-900/40" />
                </div>
              </>
            )}
          </div>
        ) : null}

        <p className="mt-3 text-[0.78rem] text-muted">
          <Bi en={`Pass mark: ${set.passPercent}% in each subject. AB = absent.`} hi={`उत्तीर्णांक: प्रत्येक विषय में ${set.passPercent}%। AB = अनुपस्थित।`} />
        </p>

        <div className="mt-8 grid grid-cols-3 gap-4 text-center text-[0.8rem] leading-snug text-forest-900 sm:gap-8">
          {[
            { en: "Class teacher", hi: "कक्षा अध्यापक", name: set.classTeacherName },
            { en: "Principal", hi: "प्रधानाचार्य", name: null },
            { en: "Parent", hi: "अभिभावक", name: null },
          ].map((s) => (
            <div key={s.en}>
              <div className="h-7 border-b border-forest-900/60" />
              <p className="mt-1.5 font-semibold">{s.en}</p>
              <p lang="hi">{s.hi}</p>
              {s.name ? <p className="mt-0.5 text-[0.72rem] text-muted">{s.name}</p> : null}
            </div>
          ))}
        </div>

        <p className="mt-3 border-t border-forest-900/15 pt-1.5 text-center text-[0.72rem] text-muted">
          {draft ? (
            <Bi en={`Draft printed on ${formatDate(todayIST())}`} hi={`प्रारूप मुद्रण तिथि ${formatDate(todayIST(), "hi")}`} />
          ) : (
            <Bi
              en={`Results published on ${formatDate(set.state.publishedAt ? todayIST(set.state.publishedAt) : null)}`}
              hi={`परिणाम घोषणा तिथि ${formatDate(set.state.publishedAt ? todayIST(set.state.publishedAt) : null, "hi")}`}
            />
          )}
        </p>
      </div>
    </article>
  );
}
