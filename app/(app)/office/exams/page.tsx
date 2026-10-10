import type { Metadata } from "next";
import Link from "next/link";
import { BookOpenCheck, ChevronRight, Pencil } from "lucide-react";
import { officePage } from "@/lib/page";
import { ButtonLink, Card, CardTitle, EmptyState, Field, Input, PageHeader } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { ActionForm, FieldError } from "@/components/forms";
import { formatPercent } from "@/components/exams/rules";
import { listExams, marksEntryProgress, type ExamListRow } from "@/lib/services/exams";
import { createExamAction, deleteExamAction, updateExamAction } from "./actions";

export const metadata: Metadata = { title: "Exams & results" };

export default async function ExamsPage() {
  const ctx = await officePage();
  const [exams, progress] = await Promise.all([listExams(ctx), marksEntryProgress(ctx.schoolId, ctx.sessionId)]);
  const entry = (examId: string) =>
    progress.filter((p) => p.examId === examId).reduce((a, p) => ({ entered: a.entered + p.entered, expected: a.expected + p.expected }), { entered: 0, expected: 0 });
  const nextOrder = Math.min(99, exams.reduce((m, e) => Math.max(m, e.sortOrder), 0) + 1);

  return (
    <>
      <PageHeader
        eyebrow={`School office · Session ${ctx.sessionId}`}
        title="Exams & results"
        description="Add the year's exams, set their maximum marks, follow marks entry and publish results to families."
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="exam-list" className="grid gap-4">
          <h2 id="exam-list" className="sr-only">
            This session&apos;s exams
          </h2>
          {exams.length ? (
            exams.map((e) => <ExamCard key={e.id} exam={e} entry={entry(e.id)} />)
          ) : (
            <EmptyState icon={<BookOpenCheck className="h-6 w-6" aria-hidden />} title="No exams yet">
              Add the first exam of the session, such as &ldquo;Unit Test 1&rdquo;. Then set its maximum marks for each class.
            </EmptyState>
          )}
        </section>

        <Card className="lg:sticky lg:top-24">
          <CardTitle>Add an exam</CardTitle>
          <ActionForm action={createExamAction} className="gap-4">
            <Field label="Name" htmlFor="name" hint="For example Unit Test 1, Half-yearly, Annual." required>
              <Input id="name" name="name" required maxLength={60} autoComplete="off" aria-describedby="name-hint name-error" />
              <FieldError name="name" />
            </Field>
            <Field label="Order in the year" htmlFor="order" hint="1 for the first exam, 2 for the next…" required>
              <Input id="order" name="order" inputMode="numeric" defaultValue={nextOrder} required className="max-w-28" aria-describedby="order-hint order-error" />
              <FieldError name="order" />
            </Field>
            <div>
              <SubmitButton pendingLabel="Adding…">Add exam</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}

function ExamCard({ exam: e, entry }: { exam: ExamListRow; entry: { entered: number; expected: number } }) {
  const href = `/office/exams/${e.id}`;
  return (
    <Card as="article" className="!p-5 sm:!p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Exam {e.sortOrder}</p>
          <h3 className="mt-1 font-display text-[1.45rem] leading-tight text-forest-900">
            <Link href={href} className="hover:underline hover:underline-offset-4">
              {e.name}
            </Link>
          </h3>
        </div>
        <ButtonLink href={href} variant="secondary" size="sm" className="min-h-11">
          Open
          <ChevronRight className="h-4 w-4" aria-hidden />
        </ButtonLink>
      </div>
      <dl className="mt-4 grid gap-3 text-[0.92rem] sm:grid-cols-3">
        <div>
          <dt className="text-muted">Papers</dt>
          <dd className="font-semibold text-forest-900">
            {e.classesWithPapers ? `${e.classesWithPapers} ${e.classesWithPapers === 1 ? "class" : "classes"}` : <span className="text-ochre-600">Not set yet</span>}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Results published</dt>
          <dd className="font-semibold text-forest-900">
            {e.sectionsWithPapers ? `${e.published} of ${e.sectionsWithPapers} sections` : "—"}
            {e.submitted ? <span className="block font-normal text-muted">{e.submitted} sent to office, waiting</span> : null}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Marks entered</dt>
          <dd className="tabular font-semibold text-forest-900">
            {entry.expected ? formatPercent(Math.round((entry.entered * 1000) / entry.expected)) : "—"}
            {entry.expected ? (
              <span className="block font-normal text-muted">
                {entry.entered} of {entry.expected} entries
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      <details className="group mt-4 border-t border-forest-900/10 pt-3">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full px-1 text-[0.92rem] font-semibold text-forest-800 hover:text-forest-600 [&::-webkit-details-marker]:hidden">
          <Pencil className="h-4 w-4" aria-hidden />
          Rename or {e.marksCount ? "reorder" : "delete"}
        </summary>
        <div className="mt-3 grid gap-4">
          <ActionForm action={updateExamAction} className="gap-3">
            <input type="hidden" name="exam" value={e.id} />
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_auto] sm:items-start">
              <Field label="Name" htmlFor={`name-${e.id}`}>
                <Input id={`name-${e.id}`} name="name" defaultValue={e.name} maxLength={60} required autoComplete="off" aria-describedby={`name-${e.id}-error`} />
                <FieldError name="name" id={`name-${e.id}-error`} />
              </Field>
              <Field label="Order" htmlFor={`order-${e.id}`}>
                <Input id={`order-${e.id}`} name="order" inputMode="numeric" defaultValue={e.sortOrder} required aria-describedby={`order-${e.id}-error`} />
                <FieldError name="order" id={`order-${e.id}-error`} />
              </Field>
              <div className="sm:pt-[1.85rem]">
                <SubmitButton variant="secondary" pendingLabel="Saving…">
                  Save
                </SubmitButton>
              </div>
            </div>
          </ActionForm>
          {e.marksCount === 0 ? (
            <ActionForm action={deleteExamAction} className="gap-3">
              <input type="hidden" name="exam" value={e.id} />
              <div>
                <ConfirmSubmit confirmLabel="Yes, delete" question={`Delete “${e.name}” and its papers?`}>
                  Delete exam
                </ConfirmSubmit>
              </div>
            </ActionForm>
          ) : (
            <p className="text-[0.88rem] text-muted">This exam has marks, so it can&apos;t be deleted.</p>
          )}
        </div>
      </details>
    </Card>
  );
}
