import type { Metadata } from "next";
import { FileText, GraduationCap } from "lucide-react";
import { getActor } from "@/lib/auth/dal";
import { getLang } from "@/lib/i18n/server";
import { familyPage, type FamilyContext } from "@/lib/page";
import { formatDate, todayIST } from "@/lib/dates";
import { ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { OutcomeLabel, OverallIcon, overallText } from "@/components/exams/status";
import { examNameHi, formatMarks, formatPercent } from "@/components/exams/rules";
import { publishedResultsFor, schoolPassPercent, type PublishedResult } from "@/lib/services/exams";
import { familyTexts, type FamilyTextLookup } from "@/lib/translate";

/** An exam's name in Hindi: the usual names from the portal's own list, others translated. */
const examInHindi = (name: string, say: FamilyTextLookup) => {
  const known = examNameHi(name);
  return known !== name.trim() ? known : (say(name)?.text ?? name);
};

export async function generateMetadata(): Promise<Metadata> {
  const actor = await getActor();
  return { title: actor?.role === "student" && (await getLang()) === "hi" ? "परिणाम" : "Results" };
}

/** The family's own child: results of exams the school has published for the child's class. */
export default async function MyResultsPage() {
  const ctx = await familyPage();
  const { t } = ctx;
  const header = (
    <PageHeader
      eyebrow={ctx.student.name}
      title={t("Results", "परिणाम")}
      description={t("Marks from the exams the school has published.", "विद्यालय द्वारा घोषित परीक्षाओं के अंक।")}
    />
  );
  if (!ctx.placement) {
    return (
      <>
        {header}
        <EmptyState icon={<GraduationCap className="h-6 w-6" aria-hidden />} title={t("Not placed in a class yet", "अभी किसी कक्षा में नाम दर्ज नहीं")}>
          {t("Results will appear here once the school office places your child in a class.", "विद्यालय कार्यालय द्वारा कक्षा में नाम दर्ज होने के बाद परिणाम यहाँ दिखेंगे।")}
        </EmptyState>
      </>
    );
  }
  const [list, passPercent] = await Promise.all([publishedResultsFor(ctx, ctx.studentId), schoolPassPercent(ctx.schoolId)]);
  if (!list.length) {
    return (
      <>
        {header}
        <EmptyState icon={<GraduationCap className="h-6 w-6" aria-hidden />} title={t("No results yet", "अभी कोई परिणाम नहीं")}>
          {t("Results appear here after the school publishes them.", "विद्यालय द्वारा परिणाम घोषित होने के बाद यहाँ दिखेंगे।")}
        </EmptyState>
      </>
    );
  }
  // Exam and subject names the portal has no Hindi for.
  const say = await familyTexts(
    ctx.lang,
    list.flatMap((x) => [examNameHi(x.exam.name) === x.exam.name.trim() ? x.exam.name : null, ...x.result.lines.map((l) => (l.nameHi ? null : l.name))]),
  );
  return (
    <>
      {header}
      <p className="-mt-3 mb-6 text-[0.95rem] text-muted">{t(`Pass mark: ${passPercent}% in each subject.`, `उत्तीर्णांक: प्रत्येक विषय में ${passPercent}%।`)}</p>
      <div className="grid gap-6">
        {list.map((x) => (
          <ExamResult key={x.exam.id} ctx={ctx} item={x} say={say} />
        ))}
      </div>
    </>
  );
}

function ExamResult({ ctx, item, say }: { ctx: FamilyContext; item: PublishedResult; say: FamilyTextLookup }) {
  const { t, lang } = ctx;
  const r = item.result;
  const examName = lang === "hi" ? examInHindi(item.exam.name, say) : item.exam.name;
  const subjectName = (l: { name: string; nameHi: string | null }) => (lang === "hi" ? (l.nameHi ?? say(l.name)?.text ?? l.name) : l.name);
  const headId = `exam-${item.exam.id}`;
  const cell = "border-b border-forest-900/[0.07] px-2 py-3 sm:px-4";
  const head = "border-b border-forest-900/10 bg-cream-200/50 px-2 py-2.5 text-[0.8rem] font-bold text-muted sm:px-4";
  return (
    <Card as="article" className="!p-4 sm:!p-7">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headId} className="font-display text-[1.5rem] leading-tight text-forest-900">
            {examName}
          </h2>
          <p className="mt-1 text-[0.9rem] text-muted">
            {t("Published on", "घोषणा तिथि:")} {formatDate(item.publishedAt ? todayIST(item.publishedAt) : null, lang)}
          </p>
        </div>
        <ButtonLink href={`/my/results/${item.exam.id}/report-card`} variant="secondary" className="min-h-11">
          <FileText className="h-4 w-4" aria-hidden />
          {t("Report card", "प्रगति पत्र")}
        </ButtonLink>
      </div>

      {/* Fits a phone screen; if a very narrow screen still needs a sideways scroll, the region can be scrolled with the keyboard. */}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t(`${item.exam.name}: marks in each subject`, `${examName}: विषयवार अंक`)}>
        <table className="w-full border-collapse text-left text-[0.95rem]" aria-describedby={headId}>
          <caption className="sr-only">{t(`${item.exam.name}: marks in each subject`, `${examName}: विषयवार अंक`)}</caption>
          <thead>
            <tr>
              <th scope="col" className={head}>
                {t("Subject", "विषय")}
              </th>
              <th scope="col" className={`${head} hidden text-right sm:table-cell`}>
                {t("Maximum", "पूर्णांक")}
              </th>
              <th scope="col" className={`${head} text-right`}>
                {t("Marks", "प्राप्तांक")}
              </th>
              <th scope="col" className={`${head} text-right`}>
                <span aria-hidden>%</span>
                <span className="sr-only">{t("Percentage", "प्रतिशत")}</span>
              </th>
              <th scope="col" className={head}>
                {t("Result", "परिणाम")}
              </th>
            </tr>
          </thead>
          <tbody>
            {r.lines.map((l) => (
              <tr key={l.subjectId}>
                <th scope="row" className={`${cell} font-semibold text-forest-900`}>
                  {subjectName(l)}
                </th>
                <td className={`${cell} tabular hidden text-right sm:table-cell`}>{l.maxMarks}</td>
                <td className={`${cell} tabular text-right sm:whitespace-nowrap`}>
                  {l.outcome === "absent" ? (
                    <span className="font-semibold text-ochre-600">{t("Absent", "अनुपस्थित")}</span>
                  ) : l.outcome === "missing" ? (
                    "—"
                  ) : (
                    <>
                      <span className="font-semibold">{formatMarks(l.tenths)}</span>
                      <span className="block whitespace-nowrap text-muted sm:hidden">/ {l.maxMarks}</span>
                    </>
                  )}
                </td>
                <td className={`${cell} tabular text-right`}>{formatPercent(l.percent)}</td>
                <td className={`${cell} text-[0.9rem]`}>
                  <OutcomeLabel outcome={l.outcome} lang={lang} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="mt-5 grid gap-4 rounded-2xl bg-cream-100/80 p-4 ring-1 ring-forest-900/[0.07] sm:grid-cols-[auto_auto_minmax(0,1fr)] sm:gap-8 sm:p-5">
        <div>
          <dt className="text-[0.85rem] text-muted">{t("Total", "कुल योग")}</dt>
          <dd className="tabular mt-0.5 font-display text-[1.45rem] leading-tight text-forest-900">
            {r.outcome === "absent" ? (
              <span className="text-ochre-600">{t("Absent", "अनुपस्थित")}</span>
            ) : r.maxTotal ? (
              <>
                {formatMarks(r.totalTenths)} <span className="text-[1rem] text-muted">/ {r.maxTotal}</span>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[0.85rem] text-muted">{t("Overall percentage", "कुल प्रतिशत")}</dt>
          <dd className="tabular mt-0.5 font-display text-[1.45rem] leading-tight text-forest-900">{formatPercent(r.percent)}</dd>
        </div>
        <div>
          <dt className="text-[0.85rem] text-muted">{t("Result", "परिणाम")}</dt>
          <dd className="mt-1 flex items-start gap-2 font-semibold text-forest-900">
            <OverallIcon outcome={r.outcome} className="mt-0.5 h-5 w-5 shrink-0" />
            <span>{overallText(r, lang)}</span>
          </dd>
        </div>
      </dl>
      {r.missing.length ? (
        <p className="mt-3 text-[0.88rem] text-muted">
          {t(
            `Marks not entered for ${r.missing.map((l) => l.name).join(", ")}; not counted in the total.`,
            `${r.missing.map((l) => subjectName(l)).join(", ")} के अंक दर्ज नहीं हैं; ये कुल योग में शामिल नहीं हैं।`,
          )}
        </p>
      ) : null}
    </Card>
  );
}
