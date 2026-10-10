import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { inArray } from "drizzle-orm";
import { FilePenLine, Lock, Printer } from "lucide-react";
import { Alert, ButtonLink, EmptyState, PageHeader, Select } from "@/components/ui";
import { FilterBar, SectionField } from "@/components/pickers";
import { RemarksEditor, type RemarkRow } from "@/components/report-remarks/editor";
import { RemarkText } from "@/components/report-remarks/remark-text";
import { teacherPage } from "@/lib/page";
import { canManageSection } from "@/lib/auth/dal";
import { getDb } from "@/lib/db/client";
import { examPapers } from "@/lib/db/schema";
import { formatDateTime, todayIST } from "@/lib/dates";
import { listExams, resultStates } from "@/lib/services/exams";
import { staffRemarkReader } from "@/lib/services/remarks";
import { REPORT_REMARK_MAX, reportRemarksFor } from "@/lib/services/report-remarks";
import { schoolThresholds, sectionFigures } from "@/lib/queries/student-figures";
import { attendancePercent, homeworkPercent, pct, type StudentFigures } from "@/lib/support/figures";
import { saveReportRemarksAction } from "./actions";

export const metadata: Metadata = { title: "Report-card remarks" };

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** The student's records this session, in words, to help the teacher write. */
function factsLine(f: StudentFigures | undefined, examId: string, examName: string): string {
  if (!f) return "";
  const att = attendancePercent(f.attendance);
  const hw = homeworkPercent(f.homework);
  const exam = f.exams.find((e) => e.examId === examId);
  const parts = [
    `Attendance ${att === null ? "not enough days yet" : pct(att)}`,
    `homework ${hw === null ? "none checked yet" : `done ${pct(hw)}`}`,
    `${examName} ${exam?.percent !== null && exam?.percent !== undefined ? pct(exam.percent / 10) : "no marks yet"}`,
    `${f.remarks.appreciations} ${f.remarks.appreciations === 1 ? "appreciation" : "appreciations"} and ${f.remarks.concerns} ${f.remarks.concerns === 1 ? "concern" : "concerns"} this session`,
  ];
  return parts.join(" · ");
}

/** A short, stable fingerprint of the saved remarks (tells the boxes when to reload). */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * The class teacher's remark for each student's report card, per exam.
 * Class teachers: their own sections. Admins: any section of the school.
 */
export default async function ReportRemarksPage({ searchParams }: { searchParams: Search }) {
  const ctx = await teacherPage();
  const sp = await searchParams;
  const allowed = ctx.isAdmin ? ctx.sections : ctx.classTeacherSections;
  const header = (
    <PageHeader
      eyebrow="Teaching"
      title="Report-card remarks"
      description="The class teacher’s remark on each student’s report card. Families see it on the report card once the results are published."
      className="pb-6"
    />
  );
  if (!allowed.length) {
    return (
      <>
        {header}
        <EmptyState icon={<FilePenLine className="h-5 w-5" aria-hidden />} title="Only class teachers write report-card remarks">
          You aren&rsquo;t the class teacher of a section this session. If that&rsquo;s wrong, please tell the school office.
        </EmptyState>
      </>
    );
  }

  const db = await getDb();
  const exams = await listExams(ctx);
  const paperRows = exams.length
    ? await db
        .selectDistinct({ examId: examPapers.examId, classId: examPapers.classId })
        .from(examPapers)
        .where(
          inArray(
            examPapers.examId,
            exams.map((e) => e.id),
          ),
        )
    : [];
  // Without a choice, the first of the person's sections that has report cards (an exam with papers for its class).
  const requestedSection = one(sp.section);
  const section = requestedSection
    ? allowed.find((s) => s.id === requestedSection)
    : (allowed.find((s) => s.studentCount > 0 && paperRows.some((p) => p.classId === s.classId)) ?? allowed[0]);
  if (!section || !(await canManageSection(ctx.actor, section.id, "class_teacher"))) notFound();
  const withPapers = exams.filter((e) => paperRows.some((p) => p.examId === e.id && p.classId === section.classId));
  const requestedExam = one(sp.exam);
  if (requestedExam && !exams.some((e) => e.id === requestedExam)) notFound();
  const exam = requestedExam ? (withPapers.find((e) => e.id === requestedExam) ?? null) : (withPapers[withPapers.length - 1] ?? null);

  const picker = (
    <FilterBar submitLabel="Show">
      {withPapers.length ? (
        <div className="grid gap-1.5">
          <label htmlFor="pick-exam" className="text-[0.85rem] font-semibold text-forest-900">
            Exam
          </label>
          <Select id="pick-exam" name="exam" defaultValue={exam?.id ?? ""} className="min-w-52">
            {withPapers.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {allowed.length > 1 ? <SectionField sections={allowed} value={section.id} /> : null}
    </FilterBar>
  );

  if (!exam) {
    return (
      <>
        {header}
        {picker}
        <EmptyState icon={<FilePenLine className="h-5 w-5" aria-hidden />} title={`No report cards for ${section.label} yet`}>
          {requestedExam ? "This exam has no papers for this class." : "The office hasn’t set the maximum marks of an exam for this class yet. Remarks can be written once it has."}
        </EmptyState>
      </>
    );
  }

  const thresholds = await schoolThresholds(ctx.schoolId);
  const [{ students, figures }, state] = await Promise.all([
    sectionFigures(ctx, section, { today: todayIST(), reader: staffRemarkReader(ctx), passPercent: thresholds.passPercent }),
    resultStates(exam.id, [section.id]).then((m) => m.get(section.id)!),
  ]);
  const saved = await reportRemarksFor(
    exam.id,
    students.map((s) => s.id),
  );
  const rows: RemarkRow[] = students.map((s) => ({
    studentId: s.id,
    name: s.name,
    rollNo: s.rollNo,
    facts: factsLine(figures.get(s.id), exam.id, exam.name),
    saved: saved.get(s.id)?.remark ?? "",
  }));
  const version = hash(rows.map((r) => `${r.studentId}=${r.saved}`).join("|"));
  const reportCards = `/office/exams/${exam.id}/report-cards?section=${section.id}`;

  return (
    <>
      {header}
      {picker}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[1.45rem] text-forest-900">
          {section.longLabel} · {exam.name}
        </h2>
        <ButtonLink href={reportCards} variant="secondary">
          <Printer className="h-4 w-4" aria-hidden />
          Report cards
        </ButtonLink>
      </div>

      {!students.length ? (
        <EmptyState title="No students in this class">Students appear here once the office places them in {section.label}.</EmptyState>
      ) : state.status === "published" ? (
        <>
          <Alert tone="blue" title="Published — remarks are locked" className="mb-5">
            Published by {state.publishedBy ?? "the office"} on {formatDateTime(state.publishedAt)}. Families can see these remarks on the report card.{" "}
            {ctx.isAdmin ? (
              <>
                To change one, reopen the results on{" "}
                <Link href={`/office/exams/${exam.id}?section=${section.id}`} className="font-semibold text-forest-800 underline underline-offset-2">
                  Exams &amp; results
                </Link>
                .
              </>
            ) : (
              "If one needs changing, ask the school office to reopen these results."
            )}
          </Alert>
          <ol className="grid gap-3">
            {rows.map((r) => (
              <li key={r.studentId} className="card grid gap-1.5 p-4 sm:p-5">
                <p className="flex flex-wrap items-center gap-2 font-semibold text-forest-900">
                  {r.rollNo ? <span className="tabular text-muted">{r.rollNo}.</span> : null}
                  {r.name}
                  <Lock className="h-4 w-4 text-muted" aria-label="Locked" />
                </p>
                {r.saved ? (
                  <RemarkText text={r.saved} className="text-forest-900" />
                ) : (
                  <p className="text-muted">No remark was written.</p>
                )}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <>
          {state.status === "submitted" ? (
            <Alert tone="blue" title="Sent to the office" className="mb-5">
              You can still write and change remarks until the office publishes the results.
            </Alert>
          ) : null}
          <RemarksEditor
            examId={exam.id}
            sectionId={section.id}
            rows={rows}
            version={version}
            max={REPORT_REMARK_MAX}
            saveAction={saveReportRemarksAction}
            caption={`Report-card remarks for ${section.label}, ${exam.name}`}
          />
        </>
      )}
    </>
  );
}
