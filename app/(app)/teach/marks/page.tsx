import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight, ClipboardList, Lock, Printer, Send, TriangleAlert, UserX } from "lucide-react";
import { teacherPage, type TeacherContext } from "@/lib/page";
import { canManageSection, canTeach, teacherScope } from "@/lib/auth/dal";
import { formatDateTime } from "@/lib/dates";
import { Alert, ButtonLink, Card, CardTitle, EmptyState, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { ConfirmSubmit } from "@/components/ui/client";
import { ActionForm } from "@/components/forms";
import { FilterBar } from "@/components/pickers";
import { MarksGrid } from "@/components/exams/marks-grid";
import { OutcomeLabel, Progress, ResultStatusBadge } from "@/components/exams/status";
import { formatMarks, formatPercent, minPassTenths } from "@/components/exams/rules";
import { examOverview, isUuid, listExams, marksSheet, resultEvents, schoolPassPercent, sectionSheet, type ExamListRow, type ResultState } from "@/lib/services/exams";
import { saveMarksAction, sendToOfficeAction } from "./actions";

export const metadata: Metadata = { title: "Marks" };

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function MarksPage({ searchParams }: { searchParams: Search }) {
  const ctx = await teacherPage();
  const sp = await searchParams;
  const exams = await listExams(ctx);
  const requested = one(sp.exam);
  const exam = requested ? exams.find((e) => e.id === requested) : ([...exams].reverse().find((e) => e.classesWithPapers > 0) ?? exams[0]);
  if (requested && !exam) notFound();

  const sectionId = one(sp.section);
  const subjectId = one(sp.subject);
  if (exam && sectionId && subjectId) return <GridView ctx={ctx} exam={exam} sectionId={sectionId} subjectId={subjectId} />;
  if (exam && sectionId) return <SummaryView ctx={ctx} exam={exam} sectionId={sectionId} />;
  return <Chooser ctx={ctx} exams={exams} exam={exam ?? null} />;
}

/* ------------------------------------------------------------------ */
/* Choose an exam, then a paper                                        */
/* ------------------------------------------------------------------ */

async function Chooser({ ctx, exams, exam }: { ctx: TeacherContext; exams: ExamListRow[]; exam: ExamListRow | null }) {
  const header = (
    <PageHeader
      eyebrow={`Session ${ctx.sessionId}`}
      title="Marks"
      description="Choose an exam, then one of your classes and subjects. You can save part of a list and finish it later."
    />
  );
  if (!exam) {
    return (
      <>
        {header}
        <EmptyState icon={<ClipboardList className="h-6 w-6" aria-hidden />} title="No exams yet">
          The school office adds exams and their maximum marks. They will appear here.
        </EmptyState>
      </>
    );
  }

  const passPercent = await schoolPassPercent(ctx.schoolId);
  const overview = await examOverview(ctx, exam.id, passPercent);
  const scope = ctx.isAdmin || !ctx.actor.staffId ? null : await teacherScope(ctx.actor.staffId);
  const mine = new Set(ctx.sections.map((s) => s.id));
  const ctSections = new Set(ctx.classTeacherSections.map((s) => s.id));

  const groups = overview
    .filter((o) => mine.has(o.sectionId) && o.papers.length)
    .map((o) => ({
      section: o,
      papers: o.subjects.filter((sub) => !scope || scope.teaches.some((t) => t.sectionId === o.sectionId && t.subjectId === sub.subjectId)),
      classTeacher: ctSections.has(o.sectionId),
    }))
    .filter((g) => g.papers.length || g.classTeacher);

  const href = (q: Record<string, string>) => `/teach/marks?${new URLSearchParams({ exam: exam.id, ...q })}`;

  return (
    <>
      {header}
      <FilterBar submitLabel="Show">
        <div className="grid gap-1.5">
          <label htmlFor="pick-exam" className="text-[0.85rem] font-semibold text-forest-900">
            Exam
          </label>
          <Select id="pick-exam" name="exam" defaultValue={exam.id} className="min-w-52">
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </div>
      </FilterBar>

      {!groups.length ? (
        <EmptyState icon={<ClipboardList className="h-6 w-6" aria-hidden />} title={`Nothing to enter for ${exam.name}`}>
          {exam.classesWithPapers
            ? "None of your subjects has a paper in this exam. If that looks wrong, ask the school office."
            : "The office has not set the maximum marks for this exam yet."}
        </EmptyState>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {groups.map(({ section: o, papers, classTeacher }) => (
            <Card key={o.sectionId} className="!p-5 sm:!p-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-[1.35rem] text-forest-900">
                  {o.label}
                  {o.stream ? <span className="text-[0.95rem] text-muted"> ({o.stream})</span> : null}
                </h2>
                <ResultStatusBadge status={o.state.status} />
              </div>
              {papers.length ? (
                <ul className="grid gap-2">
                  {papers.map((p) => {
                    const doneN = p.entered + p.absent;
                    return (
                      <li key={p.subjectId}>
                        <Link
                          href={href({ section: o.sectionId, subject: p.subjectId })}
                          className="flex min-h-14 items-center gap-3 rounded-2xl bg-cream-100/70 px-4 py-2.5 ring-1 ring-forest-900/10 transition-colors hover:bg-sage-50 hover:ring-forest-700/30"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold text-forest-900">{p.name}</span>
                            <span className="block text-[0.85rem] text-muted">Out of {p.maxMarks}</span>
                          </span>
                          <Progress done={doneN} total={o.students} />
                          {o.state.status === "published" ? <Lock className="h-4 w-4 shrink-0 text-muted" aria-label="Locked" /> : null}
                          <ChevronRight className="h-5 w-5 shrink-0 text-muted" aria-hidden />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[0.92rem] text-muted">You don&apos;t teach a subject with a paper here, but you are the class teacher.</p>
              )}
              {classTeacher ? (
                <div className="mt-4 border-t border-forest-900/10 pt-4">
                  <ButtonLink href={href({ section: o.sectionId })} variant="secondary" size="sm" className="min-h-11">
                    <ClipboardList className="h-4 w-4" aria-hidden />
                    Class summary{o.state.status === "open" ? " & send to office" : ""}
                  </ButtonLink>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function BackLink({ exam, label = "All papers" }: { exam: ExamListRow; label?: string }) {
  return (
    <Link
      href={`/teach/marks?exam=${exam.id}`}
      className="no-print mb-4 inline-flex min-h-11 items-center gap-2 rounded-full pr-3 text-[0.92rem] font-semibold text-forest-800 hover:text-forest-600"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {label} · {exam.name}
    </Link>
  );
}

function LockedNotice({ state }: { state: ResultState }) {
  return (
    <Alert tone="blue" title="Published — marks are locked" className="mb-5">
      Published by {state.publishedBy ?? "the office"} on {formatDateTime(state.publishedAt)}. If something needs correcting, ask the school office to reopen these results.
    </Alert>
  );
}

/* ------------------------------------------------------------------ */
/* The marks grid                                                      */
/* ------------------------------------------------------------------ */

async function GridView({ ctx, exam, sectionId, subjectId }: { ctx: TeacherContext; exam: ExamListRow; sectionId: string; subjectId: string }) {
  // Only this person's sections, and only subjects they teach there (admins: any in their school).
  if (!ctx.sections.some((s) => s.id === sectionId) || !isUuid(subjectId) || !(await canTeach(ctx.actor, sectionId, subjectId))) notFound();
  const sheet = await marksSheet(ctx, exam.id, sectionId, subjectId);
  if (!sheet) notFound();
  const passPercent = await schoolPassPercent(ctx.schoolId);
  const { section, paper, rows, state } = sheet;
  const events = state.status === "submitted" ? (await resultEvents(ctx.schoolId, exam.id)).get(section.id) : undefined;
  const caption = `${paper.name} marks, ${section.label}, ${exam.name}`;
  const version = hash(rows.map((r) => `${r.studentId}=${r.absent ? "AB" : (r.tenths ?? "")}`).join("|"));

  return (
    <>
      <BackLink exam={exam} />
      <PageHeader
        eyebrow={`${exam.name} · ${section.label}`}
        title={paper.name}
        description={
          <>
            Out of <strong className="text-forest-900">{paper.maxMarks}</strong>. Pass mark {passPercent}% — at least{" "}
            <strong className="text-forest-900">{formatMarks(minPassTenths(paper.maxMarks, passPercent))}</strong>. Whole or half marks; leave a box empty if that paper isn&apos;t
            marked yet, and tick Absent (or type AB) for students who missed it.
          </>
        }
        className="pb-6"
      />
      {!rows.length ? (
        <EmptyState title="No students in this class">Students appear here once the office places them in {section.label}.</EmptyState>
      ) : state.status === "published" ? (
        <>
          <LockedNotice state={state} />
          <Table caption={caption}>
            <thead>
              <tr>
                <Th>Roll</Th>
                <Th>Student</Th>
                <Th className="text-right">Marks / {paper.maxMarks}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.studentId}>
                  <Td className="tabular text-muted">{r.rollNo ?? "—"}</Td>
                  <Td>
                    <span className="font-semibold text-forest-900">{r.name}</span>
                    <span className="block text-[0.8rem] text-muted">SR {r.srNo}</span>
                  </Td>
                  <Td className="tabular text-right">{r.absent ? <OutcomeLabel outcome="absent" lang="en" /> : formatMarks(r.tenths)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ) : (
        <>
          {state.status === "submitted" ? (
            <Alert tone="blue" title="Sent to the office" className="mb-5">
              {events?.submitted ? `${events.submitted.by} sent these results on ${formatDateTime(events.submitted.at)}. ` : ""}You can still correct marks until the office
              publishes them.
            </Alert>
          ) : null}
          <MarksGrid
            action={saveMarksAction}
            examId={exam.id}
            sectionId={section.id}
            subjectId={paper.subjectId}
            max={paper.maxMarks}
            caption={caption}
            version={version}
            rows={rows.map((r) => ({
              studentId: r.studentId,
              name: r.name,
              srNo: r.srNo,
              rollNo: r.rollNo,
              saved: r.absent || r.tenths === null ? "" : formatMarks(r.tenths),
              savedAbsent: r.absent,
            }))}
          />
          {sheet.lastSavedAt ? <p className="mt-3 text-[0.85rem] text-muted">Last saved {formatDateTime(sheet.lastSavedAt)}.</p> : null}
        </>
      )}
    </>
  );
}

/** A short, stable fingerprint of the saved marks (tells the grid when to reload them). */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* ------------------------------------------------------------------ */
/* Class teacher: the whole section, and "send to office"              */
/* ------------------------------------------------------------------ */

async function SummaryView({ ctx, exam, sectionId }: { ctx: TeacherContext; exam: ExamListRow; sectionId: string }) {
  if (!ctx.sections.some((s) => s.id === sectionId) || !(await canManageSection(ctx.actor, sectionId, "class_teacher"))) notFound();
  const passPercent = await schoolPassPercent(ctx.schoolId);
  const sheet = await sectionSheet(ctx, exam.id, sectionId, passPercent);
  if (!sheet) notFound();
  const { section, papers, rows, state } = sheet;
  const events = (await resultEvents(ctx.schoolId, exam.id)).get(section.id);

  const incomplete = papers
    .map((p) => ({ ...p, missing: rows.filter((r) => r.result.lines.find((l) => l.subjectId === p.subjectId)?.outcome === "missing").length }))
    .filter((p) => p.missing > 0);
  const missingTotal = incomplete.reduce((a, p) => a + p.missing, 0);

  return (
    <>
      <BackLink exam={exam} />
      <PageHeader
        eyebrow={`${exam.name} · class summary`}
        title={section.label}
        description={`Every subject's marks for your class. Pass mark: ${passPercent}% in each subject.`}
        actions={
          papers.length ? (
            <ButtonLink href={`/office/exams/${exam.id}/report-cards?section=${section.id}`} variant="secondary">
              <Printer className="h-4 w-4" aria-hidden />
              Report cards
            </ButtonLink>
          ) : null
        }
        className="pb-6"
      />

      {!papers.length ? (
        <EmptyState title="No papers for this class">
          The office has not set any maximum marks for {section.label} in {exam.name}.
        </EmptyState>
      ) : (
        <>
          <Card className="mb-6">
            <CardTitle action={<ResultStatusBadge status={state.status} />}>Send to the office</CardTitle>
            {/* The form stays mounted when the status changes, so its message stays on screen. */}
            <ActionForm action={sendToOfficeAction} className="gap-4">
              <input type="hidden" name="exam" value={exam.id} />
              <input type="hidden" name="section" value={section.id} />
              {state.status === "published" ? (
                <p className="flex items-start gap-2 text-forest-900">
                  <Lock className="mt-1 h-4 w-4 shrink-0 text-forest-700" aria-hidden />
                  Published by {state.publishedBy ?? "the office"} on {formatDateTime(state.publishedAt)}. Families can see these results; marks are locked.
                </p>
              ) : (
                <>
                  {state.status === "submitted" ? (
                    <p className="flex items-start gap-2 text-forest-900">
                      <Send className="mt-1 h-4 w-4 shrink-0 text-forest-700" aria-hidden />
                      {events?.submitted ? `Sent by ${events.submitted.by} on ${formatDateTime(events.submitted.at)}. ` : "Sent to the office. "}
                      The office will check and publish them; marks can still be corrected until then.
                    </p>
                  ) : null}
                  {events?.reopened && state.status === "open" ? (
                    <Alert tone="amber" title={`Reopened by ${events.reopened.by} on ${formatDateTime(events.reopened.at)}`}>
                      Reason: {events.reopened.reason ?? "—"}
                    </Alert>
                  ) : null}
                  {incomplete.length ? (
                    <Alert tone="amber" title={`${missingTotal} ${missingTotal === 1 ? "mark is" : "marks are"} still missing`}>
                      <ul className="mt-1 grid gap-0.5">
                        {incomplete.map((p) => (
                          <li key={p.subjectId}>
                            {p.name}: {p.missing} of {rows.length} not entered
                          </li>
                        ))}
                      </ul>
                    </Alert>
                  ) : (
                    <Alert tone="green" title="All marks are entered">
                      Every subject has marks (or &ldquo;absent&rdquo;) for every student.
                    </Alert>
                  )}
                  {state.status === "open" ? (
                    <div>
                      <ConfirmSubmit
                        variant="primary"
                        size="md"
                        confirmLabel={incomplete.length ? "Send anyway" : "Yes, send"}
                        question={incomplete.length ? `Send with ${missingTotal} missing?` : `Send ${section.label} results to the office?`}
                      >
                        <Send className="h-4 w-4" aria-hidden />
                        Send to office
                      </ConfirmSubmit>
                    </div>
                  ) : null}
                </>
              )}
            </ActionForm>
          </Card>

          <Table caption={`${exam.name} marks for ${section.label}, all subjects`} className="[&_table]:min-w-[44rem]">
            <thead>
              <tr>
                <Th>Roll</Th>
                <Th>Student</Th>
                {papers.map((p) => (
                  <Th key={p.subjectId} className="text-right">
                    <span className="block normal-case tracking-normal">{p.name}</span>
                    <span className="block font-semibold normal-case tracking-normal">/ {p.maxMarks}</span>
                  </Th>
                ))}
                <Th className="text-right">Total</Th>
                <Th className="text-right">%</Th>
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="tabular text-muted">{r.rollNo ?? "—"}</Td>
                  <Td className="font-semibold text-forest-900">{r.name}</Td>
                  {r.result.lines.map((l) => (
                    <Td key={l.subjectId} className="tabular whitespace-nowrap text-right">
                      {l.outcome === "absent" ? (
                        <span className="font-semibold text-ochre-600">
                          AB<span className="sr-only"> (absent)</span>
                        </span>
                      ) : l.outcome === "missing" ? (
                        <span className="text-muted">
                          —<span className="sr-only"> (not entered)</span>
                        </span>
                      ) : l.outcome === "below" ? (
                        <span className="font-semibold text-clay-600">
                          {formatMarks(l.tenths)}
                          <span aria-hidden> ▾</span>
                          <span className="sr-only"> (below pass mark)</span>
                        </span>
                      ) : (
                        formatMarks(l.tenths)
                      )}
                    </Td>
                  ))}
                  <Td className="tabular whitespace-nowrap text-right">
                    {r.result.outcome === "absent" ? (
                      <span className="font-semibold text-ochre-600">
                        AB<span className="sr-only"> (absent in every subject)</span>
                      </span>
                    ) : r.result.maxTotal ? (
                      `${formatMarks(r.result.totalTenths)} / ${r.result.maxTotal}`
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="tabular text-right">{formatPercent(r.result.percent)}</Td>
                  <Td className="min-w-44">
                    {r.result.outcome === "passed" ? (
                      <OutcomeLabel outcome="passed" lang="en" />
                    ) : r.result.outcome === "absent" ? (
                      <span className="inline-flex items-start gap-1.5 text-[0.9rem] font-semibold text-ochre-600">
                        <UserX className="mt-[0.2em] h-4 w-4 shrink-0" aria-hidden />
                        Absent in every subject
                      </span>
                    ) : r.result.outcome === "improve" ? (
                      <span className="inline-flex items-start gap-1.5 text-[0.9rem]">
                        <TriangleAlert className="mt-[0.2em] h-4 w-4 shrink-0 text-clay-600" aria-hidden />
                        <span>
                          <span className="font-semibold text-clay-600">Needs improvement:</span>{" "}
                          {r.result.needsImprovement.map((l) => `${l.name}${l.outcome === "absent" ? " (absent)" : ""}`).join(", ")}
                        </span>
                      </span>
                    ) : (
                      <span className="text-[0.9rem] text-muted">Incomplete</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-3 text-[0.85rem] text-muted">AB = absent · — = not entered yet · ▾ = below the pass mark ({passPercent}%)</p>
        </>
      )}
    </>
  );
}
