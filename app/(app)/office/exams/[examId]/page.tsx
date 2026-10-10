import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronDown, ClipboardList, Lock, PencilLine, Printer, RotateCcw, Send, TriangleAlert } from "lucide-react";
import { officePage } from "@/lib/page";
import { schoolSmsSettings } from "@/lib/queries/sms";
import { smsMode } from "@/lib/sms/config";
import { eventOn } from "@/lib/sms/settings";
import { formatDateTime } from "@/lib/dates";
import { Alert, ButtonLink, Card, CardTitle, Checkbox, EmptyState, PageHeader, Stat, TabLinks, Textarea } from "@/components/ui";
import { ConfirmSubmit } from "@/components/ui/client";
import { ActionForm } from "@/components/forms";
import { PapersForm } from "@/components/exams/papers-form";
import { Progress, ResultStatusBadge } from "@/components/exams/status";
import { formatPercent } from "@/components/exams/rules";
import {
  classesWithSubjects,
  examOverview,
  examPapersByClass,
  getExam,
  resultEvents,
  schoolPassPercent,
  type ExamRow,
  type ResultEvent,
  type SectionOverview,
} from "@/lib/services/exams";
import { savePapersAction, sectionResultsAction } from "./actions";

export const metadata: Metadata = { title: "Exam" };

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function ExamPage({ params, searchParams }: { params: Promise<{ examId: string }>; searchParams: Search }) {
  const ctx = await officePage();
  const { examId } = await params;
  const exam = await getExam(ctx, examId);
  if (!exam) notFound();
  const sp = await searchParams;
  const papersByClass = await examPapersByClass(exam.id);
  const tab = one(sp.tab) === "papers" || (!papersByClass.size && one(sp.tab) !== "results") ? "papers" : "results";
  const base = `/office/exams/${exam.id}`;

  return (
    <>
      <Link href="/office/exams" className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-full pr-3 text-[0.92rem] font-semibold text-forest-800 hover:text-forest-600">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All exams
      </Link>
      <PageHeader
        eyebrow={`Exams & results · Session ${ctx.sessionId}`}
        title={exam.name}
        description={
          papersByClass.size
            ? `Exam ${exam.sortOrder} of the year · papers set for ${papersByClass.size} ${papersByClass.size === 1 ? "class" : "classes"}.`
            : `Exam ${exam.sortOrder} of the year. Start by setting the maximum marks for each class.`
        }
        className="pb-6"
      />
      {one(sp.added) ? (
        <Alert tone="green" className="mb-6">
          Added &ldquo;{exam.name}&rdquo;. Now set its maximum marks for each class below.
        </Alert>
      ) : null}
      <TabLinks
        current={tab}
        tabs={[
          { key: "results", href: `${base}?tab=results`, label: "Marks & results" },
          { key: "papers", href: `${base}?tab=papers`, label: "Papers (maximum marks)" },
        ]}
      />
      {tab === "papers" ? <PapersTab exam={exam} schoolId={ctx.schoolId} papersByClass={papersByClass} /> : <ResultsTab exam={exam} ctx={ctx} openSection={one(sp.section)} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Papers                                                              */
/* ------------------------------------------------------------------ */

async function PapersTab({ exam, schoolId, papersByClass }: { exam: ExamRow; schoolId: string; papersByClass: Awaited<ReturnType<typeof examPapersByClass>> }) {
  const classes = await classesWithSubjects(schoolId);
  const withSubjects = classes.filter((c) => c.subjects.length || papersByClass.has(c.id));
  const without = classes.filter((c) => !c.subjects.length && !papersByClass.has(c.id));
  return (
    <div className="grid gap-5">
      <p className="max-w-3xl text-muted">
        For each class, set the marks each subject&apos;s paper is out of. Teachers can enter marks only for subjects with a maximum here. Papers of a class are locked while any of
        its results are published.
      </p>
      <div className="grid items-start gap-5 lg:grid-cols-2">
        {withSubjects.map((c) => {
          const papers = papersByClass.get(c.id) ?? [];
          const subjects = [
            ...c.subjects.map((s) => ({ subjectId: s.subjectId, name: s.name, max: papers.find((p) => p.subjectId === s.subjectId)?.maxMarks ?? null, taught: true })),
            ...papers.filter((p) => !c.subjects.some((s) => s.subjectId === p.subjectId)).map((p) => ({ subjectId: p.subjectId, name: p.name, max: p.maxMarks, taught: false })),
          ];
          return (
            <Card key={c.id} className="!p-5 sm:!p-6">
              <CardTitle
                action={
                  papers.length ? (
                    <span className="text-[0.88rem] text-muted">
                      {papers.length} of {subjects.length} examined
                    </span>
                  ) : (
                    <span className="text-[0.88rem] font-semibold text-ochre-600">Not set</span>
                  )
                }
              >
                {c.label}
              </CardTitle>
              <PapersForm action={savePapersAction} examId={exam.id} classId={c.id} classLabel={c.label} subjects={subjects} />
            </Card>
          );
        })}
      </div>
      {without.length ? (
        <p className="text-[0.92rem] text-muted">
          No subjects are set for {without.map((c) => c.label).join(", ")}, so they have no papers. Add subjects under Classes &amp; subjects if these classes sit this exam.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Marks & results                                                     */
/* ------------------------------------------------------------------ */

async function ResultsTab({ exam, ctx, openSection }: { exam: ExamRow; ctx: { schoolId: string; sessionId: string }; openSection: string }) {
  const passPercent = await schoolPassPercent(ctx.schoolId);
  const [overview, events, sms] = await Promise.all([examOverview(ctx, exam.id, passPercent), resultEvents(ctx.schoolId, exam.id), schoolSmsSettings(ctx.schoolId)]);
  const texts = eventOn(sms, "results") && smsMode() !== "off";
  const examined = overview.filter((o) => o.papers.length);
  const notExamined = overview.filter((o) => !o.papers.length);
  if (!examined.length) {
    return (
      <EmptyState
        icon={<ClipboardList className="h-6 w-6" aria-hidden />}
        title="No papers yet"
        action={
          <ButtonLink href={`/office/exams/${exam.id}?tab=papers`} variant="primary">
            Set maximum marks
          </ButtonLink>
        }
      >
        Set the maximum marks for each class first. Then teachers can enter marks.
      </EmptyState>
    );
  }
  const published = examined.filter((o) => o.state.status === "published").length;
  const submitted = examined.filter((o) => o.state.status === "submitted").length;
  const expected = examined.reduce((a, o) => a + o.expected, 0);
  const doneN = examined.reduce((a, o) => a + o.done, 0);

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Stat label="Published" value={`${published} of ${examined.length}`} hint="sections" tone={published === examined.length ? "green" : "default"} />
        <Stat label="Waiting to publish" value={submitted} hint="sent to office by class teachers" tone={submitted ? "amber" : "default"} />
        <Stat label="Marks entered" value={formatPercent(expected ? Math.round((doneN * 1000) / expected) : null)} hint={`${doneN} of ${expected} entries`} />
        <Stat label="Pass mark" value={`${passPercent}%`} hint="in each subject" />
      </div>

      <section aria-labelledby="sections-heading" className="grid gap-3">
        <h2 id="sections-heading" className="font-display text-[1.35rem] text-forest-900">
          Sections
        </h2>
        <p className="-mt-1 text-[0.92rem] text-muted">Open a section to see each subject&apos;s marks entry, its results so far, and to publish or reopen.</p>
        {examined.map((o) => (
          <SectionPanel key={o.sectionId} exam={exam} o={o} events={events.get(o.sectionId)} open={o.sectionId === openSection} texts={texts} />
        ))}
      </section>
      {notExamined.length ? <p className="text-[0.92rem] text-muted">No papers for {notExamined.map((o) => o.label).join(", ")} in this exam.</p> : null}
    </div>
  );
}

function SectionPanel({
  exam,
  o,
  events,
  open,
  texts,
}: {
  exam: ExamRow;
  o: SectionOverview;
  events?: { submitted?: ResultEvent; reopened?: ResultEvent };
  open: boolean;
  /** Families get a text message when results are published. */
  texts: boolean;
}) {
  const complete = o.missing === 0;
  const incomplete = o.subjects.filter((s) => s.missing > 0);
  const marksHref = (subjectId?: string) => `/teach/marks?${new URLSearchParams({ exam: exam.id, section: o.sectionId, ...(subjectId ? { subject: subjectId } : {}) })}`;
  return (
    <details open={open} className="card group overflow-hidden" id={`section-${o.sectionId}`}>
      <summary className="flex min-h-16 cursor-pointer list-none flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4 hover:bg-cream-100/60 sm:px-6 md:grid md:grid-cols-[7.5rem_9.5rem_8.5rem_9rem_minmax(0,1fr)_1.25rem] [&::-webkit-details-marker]:hidden">
        <span className="min-w-[6rem] font-display text-[1.3rem] leading-tight text-forest-900">
          {o.label}
          {o.stream ? <span className="block text-[0.8rem] text-muted">{o.stream}</span> : null}
        </span>
        <span>
          <ResultStatusBadge status={o.state.status} />
        </span>
        <span className="text-[0.88rem] text-muted">
          <span className="sr-only">Marks entered:</span>
          <Progress done={o.done} total={o.expected} />
        </span>
        <span className="text-[0.88rem] text-muted">
          Average <strong className="tabular font-semibold text-forest-900">{formatPercent(o.averagePercent)}</strong>
        </span>
        <span className="text-[0.88rem] text-muted">
          {complete ? "Passed all subjects" : "Passing so far"}:{" "}
          <strong className="tabular font-semibold text-forest-900">
            {complete ? o.passedAll : o.clearSoFar} of {o.students}
          </strong>
        </span>
        <ChevronDown className="ml-auto h-5 w-5 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>

      <div className="grid gap-5 border-t border-forest-900/10 px-5 py-5 sm:px-6">
        <p className="text-[0.92rem] text-muted">
          Class teacher: <span className="font-semibold text-forest-900">{o.classTeacherName ?? "not assigned"}</span> · {o.students} {o.students === 1 ? "student" : "students"}
        </p>

        <div className="overflow-x-auto rounded-2xl ring-1 ring-forest-900/10">
          <table className="w-full min-w-[34rem] border-collapse text-left text-[0.92rem]">
            <caption className="sr-only">
              Marks entry for {o.label}, {exam.name}, by subject
            </caption>
            <thead>
              <tr className="bg-cream-200/50 text-[0.74rem] font-bold uppercase tracking-[0.1em] text-muted">
                <th scope="col" className="px-4 py-2.5">
                  Subject
                </th>
                <th scope="col" className="px-4 py-2.5">
                  Teacher
                </th>
                <th scope="col" className="px-4 py-2.5 text-right">
                  Entered
                </th>
                <th scope="col" className="px-4 py-2.5 text-right">
                  Absent
                </th>
                <th scope="col" className="px-4 py-2.5">
                  Still to enter
                </th>
              </tr>
            </thead>
            <tbody>
              {o.subjects.map((s) => (
                <tr key={s.subjectId} className="border-t border-forest-900/[0.06]">
                  <th scope="row" className="px-4 py-2.5 font-semibold text-forest-900">
                    {o.state.status === "published" ? (
                      s.name
                    ) : (
                      <Link href={marksHref(s.subjectId)} className="underline decoration-forest-900/25 underline-offset-4 hover:decoration-forest-700">
                        {s.name}
                      </Link>
                    )}
                    <span className="block text-[0.8rem] font-normal text-muted">out of {s.maxMarks}</span>
                  </th>
                  <td className="px-4 py-2.5 text-forest-900">{s.teacherName ?? <span className="text-ochre-600">Not assigned</span>}</td>
                  <td className="tabular px-4 py-2.5 text-right">{s.entered}</td>
                  <td className="tabular px-4 py-2.5 text-right">{s.absent}</td>
                  <td className="px-4 py-2.5">
                    {s.missing ? (
                      <span className="inline-flex items-center gap-1.5 font-semibold text-ochre-600">
                        <TriangleAlert className="h-4 w-4" aria-hidden />
                        {s.missing} of {o.students}
                      </span>
                    ) : (
                      <span className="font-semibold text-forest-700">Complete</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <History o={o} events={events} />

        <div className="flex flex-wrap gap-2.5">
          <ButtonLink href={marksHref()} variant="secondary" size="sm" className="min-h-11">
            <ClipboardList className="h-4 w-4" aria-hidden />
            Class summary
          </ButtonLink>
          <ButtonLink href={`/office/exams/${exam.id}/report-cards?section=${o.sectionId}`} variant="secondary" size="sm" className="min-h-11">
            <Printer className="h-4 w-4" aria-hidden />
            Report cards
          </ButtonLink>
        </div>

        <div className="rounded-2xl bg-cream-100/70 p-4 ring-1 ring-forest-900/10">
          {/* One form for publish and reopen, so its message stays when the status changes. */}
          <ActionForm action={sectionResultsAction} className="gap-3">
            <input type="hidden" name="exam" value={exam.id} />
            <input type="hidden" name="section" value={o.sectionId} />
            <input type="hidden" name="intent" value={o.state.status === "published" ? "reopen" : "publish"} />
            {o.state.status === "published" ? (
              <>
                <div>
                  <h3 className="flex items-center gap-2 font-semibold text-forest-900">
                    <RotateCcw className="h-4 w-4" aria-hidden />
                    Reopen to correct marks
                  </h3>
                  <p className="mt-1 text-[0.9rem] text-muted">Families stop seeing these results and teachers can change marks again. Publish again when done.</p>
                </div>
                <div className="grid gap-1.5">
                  <label htmlFor={`reason-${o.sectionId}`} className="text-[0.92rem] font-semibold text-forest-900">
                    Reason <span className="text-clay-600">*</span>
                  </label>
                  <Textarea id={`reason-${o.sectionId}`} name="reason" required maxLength={300} rows={2} className="min-h-20" aria-describedby={`reason-${o.sectionId}-hint`} />
                  <p id={`reason-${o.sectionId}-hint`} className="text-[0.85rem] text-muted">
                    Required, kept in the activity log — e.g. &ldquo;Hindi marks of roll 3 entered wrongly&rdquo;.
                  </p>
                </div>
                <div>
                  <ConfirmSubmit variant="danger" size="md" confirmLabel="Yes, reopen" question="Unlock marks and hide from families?">
                    <RotateCcw className="h-4 w-4" aria-hidden />
                    Reopen results
                  </ConfirmSubmit>
                </div>
              </>
            ) : (
              <>
                <div>
                  <h3 className="flex items-center gap-2 font-semibold text-forest-900">
                    <Send className="h-4 w-4" aria-hidden />
                    Publish to families
                  </h3>
                  <p className="mt-1 text-[0.9rem] text-muted">
                    Families of {o.label} will see these results and can print report cards. Marks are then locked.
                    {texts ? " Each family also gets a text message saying the results are on the portal (once per exam)." : ""}
                    {o.state.status === "open" ? " The class teacher has not sent these results to the office yet." : ""}
                  </p>
                </div>
                {o.done === 0 ? (
                  <Alert tone="amber" title="No marks entered yet">
                    There is nothing to publish until teachers enter marks.
                  </Alert>
                ) : incomplete.length ? (
                  <>
                    <Alert tone="amber" title={`Marks are incomplete: ${o.missing} ${o.missing === 1 ? "entry is" : "entries are"} missing`}>
                      <ul className="mt-1 grid gap-0.5">
                        {incomplete.map((s) => (
                          <li key={s.subjectId}>
                            {s.name}: {s.missing} of {o.students} not entered
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1.5">If you publish now, families will see &ldquo;Not entered&rdquo; for these subjects and they are left out of the total.</p>
                    </Alert>
                    <Checkbox name="allowIncomplete" label="Publish anyway, with the missing marks shown as “Not entered”" />
                  </>
                ) : (
                  <p className="text-[0.92rem] font-semibold text-forest-700">All marks are entered.</p>
                )}
                {o.done > 0 ? (
                  <div>
                    <ConfirmSubmit
                      variant="primary"
                      size="md"
                      confirmLabel="Yes, publish"
                      question={incomplete.length ? `Publish ${o.label} with ${o.missing} missing?` : `Publish ${o.label} results?`}
                    >
                      <Lock className="h-4 w-4" aria-hidden />
                      Publish results
                    </ConfirmSubmit>
                  </div>
                ) : null}
              </>
            )}
          </ActionForm>
        </div>
      </div>
    </details>
  );
}

function History({ o, events }: { o: SectionOverview; events?: { submitted?: ResultEvent; reopened?: ResultEvent } }) {
  const lines: { key: string; icon: typeof Send; text: string }[] = [];
  if (o.state.status === "published") lines.push({ key: "p", icon: Lock, text: `Published by ${o.state.publishedBy ?? "the office"} on ${formatDateTime(o.state.publishedAt)}.` });
  if (events?.submitted && o.state.status !== "open")
    lines.push({ key: "s", icon: Send, text: `Sent to office by ${events.submitted.by} on ${formatDateTime(events.submitted.at)}.` });
  if (events?.reopened) {
    lines.push({ key: "r", icon: PencilLine, text: `Last reopened by ${events.reopened.by} on ${formatDateTime(events.reopened.at)} — reason: ${events.reopened.reason ?? "—"}` });
  }
  if (!lines.length) return null;
  return (
    <ul className="grid gap-1.5 text-[0.9rem] text-forest-900">
      {lines.map(({ key, icon: Icon, text }) => (
        <li key={key} className="flex items-start gap-2">
          <Icon className="mt-1 h-4 w-4 shrink-0 text-forest-700" aria-hidden />
          {text}
        </li>
      ))}
    </ul>
  );
}
