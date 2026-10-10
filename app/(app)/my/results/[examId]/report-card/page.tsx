import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getActor } from "@/lib/auth/dal";
import { getLang } from "@/lib/i18n/server";
import { familyPage } from "@/lib/page";
import { todayIST } from "@/lib/dates";
import { PageHeader } from "@/components/ui";
import { PrintButton } from "@/components/ui/client";
import { ReportCard } from "@/components/exams/report-card";
import { examNameHi } from "@/components/exams/rules";
import { isUuid, publishedResultsFor, reportCards } from "@/lib/services/exams";
import { familyTexts } from "@/lib/translate";
import { FamilyText } from "@/components/translate/family-text";
import { TranslationSummary } from "@/components/translate/translated-note";

export async function generateMetadata(): Promise<Metadata> {
  const actor = await getActor();
  return { title: actor?.role === "student" && (await getLang()) === "hi" ? "प्रगति पत्र" : "Report card" };
}

/** The family's own child's report card, only for an exam published for the child's class. */
export default async function MyReportCardPage({ params }: { params: Promise<{ examId: string }> }) {
  const ctx = await familyPage();
  const { t } = ctx;
  const { examId } = await params;
  if (!isUuid(examId) || !ctx.placement) notFound();
  // Published for this child's section, this school and session — or it doesn't exist as far as families know.
  const [published] = await publishedResultsFor(ctx, ctx.studentId, examId);
  if (!published) notFound();
  const set = await reportCards(ctx, examId, ctx.placement.sectionId, { studentId: ctx.studentId, today: todayIST() });
  if (!set || set.state.status !== "published" || set.students.length !== 1) notFound();
  const knownHi = examNameHi(set.exam.name);
  const unknownExam = knownHi === set.exam.name.trim();
  // The class teacher's remark (and an exam name the portal has no Hindi for), in Hindi for families who chose it.
  const say = await familyTexts(ctx.lang, [set.students[0].remark, unknownExam ? set.exam.name : null]);
  const examName = ctx.lang === "hi" ? (unknownExam ? (say(set.exam.name)?.text ?? set.exam.name) : knownHi) : set.exam.name;
  const remarkHi = ctx.lang === "hi" ? say(set.students[0].remark) : null;

  return (
    <>
      <div className="no-print">
        <Link href="/my/results" className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-full pr-3 text-[0.92rem] font-semibold text-forest-800 hover:text-forest-600">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t("All results", "सभी परिणाम")}
        </Link>
        <PageHeader
          eyebrow={examName}
          title={t("Report card", "प्रगति पत्र")}
          description={t("Print it on A4 paper, or save it as a PDF from the print window.", "इसे A4 कागज़ पर प्रिंट करें, या प्रिंट विंडो से PDF के रूप में सहेजें।")}
          actions={<PrintButton label={t("Print", "प्रिंट करें")} variant="primary" />}
          className="pb-6"
        />
        <TranslationSummary say={say} />
      </div>
      <ReportCard set={set} student={set.students[0]} blankRemark={false} />
      {remarkHi?.original ? (
        // On screen only: the printed card keeps the class teacher's own words.
        <section aria-labelledby="remark-hi" className="no-print card mx-auto mt-6 max-w-[52rem] p-5 sm:p-6">
          <h2 id="remark-hi" lang="hi" className="font-display text-[1.2rem] text-forest-900">
            कक्षाध्यापक की टिप्पणी — हिंदी में
          </h2>
          <FamilyText value={remarkHi} as="p" className="mt-2 text-[1.02rem] text-forest-900" />
        </section>
      ) : remarkHi?.untranslated ? (
        <p lang="hi" className="no-print mx-auto mt-6 max-w-[52rem] text-[0.92rem] text-muted">
          (कक्षाध्यापक की टिप्पणी अंग्रेज़ी में लिखी गई है — इसका हिंदी अनुवाद अभी उपलब्ध नहीं है।)
        </p>
      ) : null}
    </>
  );
}
