import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FilePenLine, Printer } from "lucide-react";
import { chooseSection, teacherPage } from "@/lib/page";
import { canManageSection } from "@/lib/auth/dal";
import { todayIST } from "@/lib/dates";
import { Alert, ButtonLink, EmptyState, PageHeader } from "@/components/ui";
import { PrintButton } from "@/components/ui/client";
import { FilterBar, SectionField } from "@/components/pickers";
import { ReportCard } from "@/components/exams/report-card";
import { examPapersByClass, getExam, reportCards } from "@/lib/services/exams";

export const metadata: Metadata = { title: "Report cards" };

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * Printable report cards for a section, one A4 page per student.
 * Admins: any section of their school. Teachers: sections where they are class teacher.
 */
export default async function ReportCardsPage({ params, searchParams }: { params: Promise<{ examId: string }>; searchParams: Search }) {
  const ctx = await teacherPage();
  const { examId } = await params;
  const exam = await getExam(ctx, examId);
  if (!exam) notFound();
  const allowed = ctx.isAdmin ? ctx.sections : ctx.classTeacherSections;
  const requested = one((await searchParams).section);
  const papersByClass = await examPapersByClass(exam.id);
  // Default to the first section whose class sits this exam.
  const section = requested ? allowed.find((s) => s.id === requested) : (allowed.find((s) => papersByClass.has(s.classId)) ?? chooseSection(allowed, null));
  if (requested && !section) notFound();
  if (section && !(await canManageSection(ctx.actor, section.id, "class_teacher"))) notFound();

  const back = ctx.isAdmin
    ? { href: `/office/exams/${exam.id}?section=${section?.id ?? ""}`, label: exam.name }
    : { href: `/teach/marks?exam=${exam.id}${section ? `&section=${section.id}` : ""}`, label: "Class summary" };

  if (!section) {
    return (
      <>
        <PageHeader eyebrow={`${exam.name} · Report cards`} title="Report cards" />
        <EmptyState title="No class to print for">Report cards are printed by class teachers and the school office.</EmptyState>
      </>
    );
  }

  const set = await reportCards(ctx, exam.id, section.id, { today: todayIST() });
  if (!set) notFound();

  return (
    <>
      <div className="no-print">
        <Link href={back.href} className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-full pr-3 text-[0.92rem] font-semibold text-forest-800 hover:text-forest-600">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {back.label}
        </Link>
        <PageHeader
          eyebrow={`${exam.name} · Report cards`}
          title={section.label}
          description={`${set.students.length} ${set.students.length === 1 ? "report card" : "report cards"}, one A4 page each. Use your browser's print dialog (A4, portrait).`}
          actions={
            set.students.length && set.papers.length ? (
              <>
                <ButtonLink href={`/teach/report-remarks?exam=${exam.id}&section=${section.id}`} variant="secondary">
                  <FilePenLine className="h-4 w-4" aria-hidden />
                  {set.state.status === "published" ? "Remarks" : "Write remarks"}
                </ButtonLink>
                <PrintButton label="Print report cards" variant="primary" />
              </>
            ) : null
          }
          className="pb-6"
        />
        {allowed.length > 1 ? (
          <FilterBar submitLabel="Show">
            <SectionField sections={allowed} value={section.id} />
          </FilterBar>
        ) : null}
        {set.papers.length && set.state.status !== "published" ? (
          <Alert tone="amber" title="These results are not published yet" className="mb-6">
            The cards are marked &ldquo;Draft&rdquo;. Families see results only after the office publishes them.
          </Alert>
        ) : null}
      </div>

      {!set.papers.length ? (
        <EmptyState icon={<Printer className="h-6 w-6" aria-hidden />} title="No papers for this class">
          {exam.name} has no maximum marks set for {section.label}, so there is nothing to print.
        </EmptyState>
      ) : !set.students.length ? (
        <EmptyState title="No students in this class">There are no students in {section.label} this session.</EmptyState>
      ) : (
        <div className="grid gap-8 print:block">
          {set.students.map((s) => (
            <ReportCard key={s.id} set={set} student={s} />
          ))}
        </div>
      )}
    </>
  );
}
