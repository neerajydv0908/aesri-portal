import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CircleDashed, Pencil, Users } from "lucide-react";
import { Alert, Badge, ButtonLink, Card, CardTitle, Dl, EmptyState, PageHeader } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { ActionForm } from "@/components/forms";
import { Flash, HomeworkCheckIcon } from "@/components/daily/badges";
import { MarkAllButton } from "@/components/daily/mark-all";
import { StatusRadios, type Choice } from "@/components/daily/status-radios";
import { addDays, formatDate, formatDateTime, todayIST } from "@/lib/dates";
import { teacherPage } from "@/lib/page";
import { sectionStudents } from "@/lib/queries/school";
import { HOMEWORK_CHECKS, HOMEWORK_CHECK_LABELS, checksFor, homeworkById } from "@/lib/services/homework";
import { deleteHomeworkAction, saveChecksAction } from "../actions";
import { homeworkAccess } from "../scope";

export const metadata: Metadata = { title: "Homework" };

const CHOICES: Choice[] = [
  { value: "done", label: "Done", tone: "green" },
  { value: "late", label: "Late", tone: "amber" },
  { value: "not_done", label: "Not done", tone: "red" },
  { value: "excused", label: "Excused", tone: "slate" },
  { value: "", label: "Not checked", tone: "plain", compactIcon: <CircleDashed className="h-4 w-4" /> },
];

export default async function HomeworkDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string }> }) {
  const ctx = await teacherPage();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const hw = await homeworkById(id);
  if (!hw) notFound();
  const access = await homeworkAccess(ctx, hw);
  const section = ctx.sections.find((s) => s.id === hw.sectionId);
  if (!access.view || !section) notFound();

  const [roll, checks] = await Promise.all([sectionStudents(hw.sectionId), checksFor(hw.id)]);
  const today = todayIST();
  const subject = hw.subjectName ?? "General";
  const counts = { done: 0, late: 0, not_done: 0, excused: 0 };
  let unchecked = 0;
  let lastCheck = 0;
  for (const s of roll) {
    const c = checks.get(s.id);
    if (c) {
      counts[c.status]++;
      lastCheck = Math.max(lastCheck, c.checkedAt.getTime());
    } else unchecked++;
  }

  return (
    <>
      <PageHeader
        eyebrow={`Homework · ${section.label} · ${subject}`}
        title={hw.title}
        actions={
          <>
            {access.edit ? (
              <ButtonLink href={`/teach/homework/${hw.id}/edit`} variant="secondary">
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </ButtonLink>
            ) : null}
            <ButtonLink href={`/teach/homework?section=${hw.sectionId}`} variant="ghost">
              All homework for {section.label}
            </ButtonLink>
          </>
        }
      />
      <Flash
        code={sp.done}
        messages={{
          created: "Homework set. Families can see it now. Come back here to record who did it.",
          updated: "Your changes to the homework were saved.",
          unchanged: "Nothing had changed.",
        }}
      />

      <Card className="mb-6">
        <Dl
          className="sm:grid-cols-4"
          items={[
            { label: "Class", value: section.longLabel },
            { label: "Set on", value: formatDate(hw.assignedOn, "en", { weekday: true }) },
            {
              label: "Due on",
              value: (
                <span className="flex flex-wrap items-center gap-2">
                  {formatDate(hw.dueOn, "en", { weekday: true })}
                  {hw.dueOn === today ? <Badge tone="amber">Today</Badge> : hw.dueOn === addDays(today, 1) ? <Badge tone="blue">Tomorrow</Badge> : null}
                </span>
              ),
            },
            { label: "Set by", value: hw.createdByPerson ? `${hw.createdByPerson.name} (${hw.createdByPerson.loginId})` : "—" },
          ]}
        />
        {hw.details ? <p className="mt-5 whitespace-pre-line border-t border-forest-900/10 pt-4 text-forest-900">{hw.details}</p> : null}
      </Card>

      <Card className="px-4 sm:px-7">
        <CardTitle>Who did it?</CardTitle>
        <ul aria-label="Checked so far" className="mb-4 flex flex-wrap gap-1.5">
          {HOMEWORK_CHECKS.map((st) => (
            <li key={st}>
              <Badge tone={st === "done" ? "green" : st === "late" ? "amber" : st === "not_done" ? "red" : "grey"}>
                <HomeworkCheckIcon status={st} />
                <span className="tabular">{counts[st]}</span> {HOMEWORK_CHECK_LABELS[st].en.toLowerCase()}
              </Badge>
            </li>
          ))}
          <li>
            <Badge tone="default">
              <HomeworkCheckIcon status={null} />
              <span className="tabular">{unchecked}</span> not checked yet
            </Badge>
          </li>
        </ul>
        {hw.dueOn > today ? (
          <Alert tone="blue" className="mb-4">
            This homework is due on {formatDate(hw.dueOn, "en", { weekday: true })}. You can record checks now or after it’s handed in.
          </Alert>
        ) : null}

        {roll.length ? (
          <ActionForm action={saveChecksAction} className="gap-4 [html:has(&)]:scroll-pb-28">
            <input type="hidden" name="id" value={hw.id} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[0.95rem] text-muted">
                Choose for each student. Leave “Not checked” for anyone you haven’t checked yet.
                {lastCheck ? ` Last saved ${formatDateTime(new Date(lastCheck))}.` : ""}
              </p>
              <MarkAllButton group="homework" value="done" label="Mark all done" announce="Everyone is marked done. Press Save checks to keep it." />
            </div>
            <ol key={lastCheck} className="divide-y divide-forest-900/[0.07] border-y border-forest-900/[0.07]">
              {roll.map((s) => (
                <li key={s.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,31rem)] sm:items-center sm:gap-4">
                  <p id={`name-${s.id}`} className="flex min-w-0 items-baseline gap-3">
                    <span className="w-7 shrink-0 text-right text-[0.9rem] text-muted tabular">
                      <span className="sr-only">Roll </span>
                      {s.rollNo ?? "–"}
                    </span>
                    <span className="min-w-0 font-semibold text-forest-900">{s.name}</span>
                  </p>
                  <StatusRadios
                    name={`hw_${s.id}`}
                    labelledBy={`name-${s.id}`}
                    choices={CHOICES}
                    value={checks.get(s.id)?.status ?? ""}
                    markAllGroup="homework"
                    className="grid-cols-[repeat(4,minmax(0,1fr))_2.75rem] sm:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.25fr)]"
                  />
                </li>
              ))}
            </ol>
            <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-forest-900/10 bg-cream-50/95 px-4 py-3 backdrop-blur sm:-mx-7 sm:px-7">
              <SubmitButton pendingLabel="Saving…">Save checks</SubmitButton>
            </div>
          </ActionForm>
        ) : (
          <EmptyState icon={<Users className="h-5 w-5" aria-hidden />} title={`No students in ${section.label}`}>
            Once students are added to this class, you can record who did the homework.
          </EmptyState>
        )}
      </Card>

      {access.edit ? (
        <Card className="mt-6">
          <CardTitle>Delete this homework</CardTitle>
          <p className="text-muted">
            It will disappear for families too
            {hw.checks.checked ? `, and the ${hw.checks.checked} ${hw.checks.checked === 1 ? "check" : "checks"} recorded for it will be removed` : ""}. This
            can’t be undone.
          </p>
          <ActionForm action={deleteHomeworkAction} className="mt-4">
            <input type="hidden" name="id" value={hw.id} />
            <div>
              <ConfirmSubmit question="Delete this homework?" confirmLabel="Yes, delete it">
                Delete homework
              </ConfirmSubmit>
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
