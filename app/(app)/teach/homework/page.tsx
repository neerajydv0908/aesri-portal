import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NotebookPen, Plus } from "lucide-react";
import { Badge, ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { FilterBar, SectionField } from "@/components/pickers";
import { Flash, HomeworkCheckIcon } from "@/components/daily/badges";
import { formatDate, todayIST } from "@/lib/dates";
import { teacherPage } from "@/lib/page";
import { listHomework, type HomeworkRow } from "@/lib/services/homework";
import { dueText } from "./due";
import { homeworkListScope, homeworkPairs } from "./scope";

export const metadata: Metadata = { title: "Homework" };

export default async function TeachHomeworkPage({ searchParams }: { searchParams: Promise<{ section?: string; done?: string; more?: string }> }) {
  const ctx = await teacherPage();
  const sp = await searchParams;
  const pairs = await homeworkPairs(ctx);
  const { scope, sections } = await homeworkListScope(ctx, pairs);
  const only = typeof sp.section === "string" && sp.section ? sections.find((s) => s.id === sp.section) : undefined;
  if (sp.section && !only) notFound();
  const limit = sp.more === "1" ? 300 : 60;
  const rows = await listHomework(scope, { onlySection: only?.id, limit });
  const today = todayIST();
  const size = new Map(ctx.sections.map((s) => [s.id, s.studentCount]));
  const label = new Map(ctx.sections.map((s) => [s.id, s.label]));
  const canSet = pairs.some((p) => !only || p.section.id === only.id);

  return (
    <>
      <PageHeader
        eyebrow="Teaching"
        title="Homework"
        description="Set homework for your classes, then record who did it. Families see the homework and their own child’s status."
        actions={
          pairs.length ? (
            <ButtonLink href={only && canSet ? `/teach/homework/new?section=${only.id}` : "/teach/homework/new"}>
              <Plus className="h-4 w-4" aria-hidden />
              Set homework
            </ButtonLink>
          ) : null
        }
      />
      <Flash code={sp.done} messages={{ deleted: "The homework and its checks were deleted." }} />

      {sections.length > 1 ? (
        <FilterBar>
          <SectionField sections={sections} value={only?.id ?? ""} allowAll allLabel="All my classes" />
        </FilterBar>
      ) : null}

      {!sections.length ? (
        <EmptyState icon={<NotebookPen className="h-5 w-5" aria-hidden />} title="No classes to set homework for">
          You don’t teach a subject or have a class of your own this session. If that’s wrong, please tell the school office.
        </EmptyState>
      ) : !rows.length ? (
        <EmptyState
          icon={<NotebookPen className="h-5 w-5" aria-hidden />}
          title={only ? `No homework for ${only.label} yet` : "No homework yet"}
          action={
            pairs.length ? (
              <ButtonLink href={only ? `/teach/homework/new?section=${only.id}` : "/teach/homework/new"} variant="secondary">
                Set homework
              </ButtonLink>
            ) : null
          }
        >
          Homework you set appears here, newest first.
        </EmptyState>
      ) : (
        <Card className="p-2 sm:p-3">
          <h2 className="sr-only">{only ? `Homework for ${only.label}` : "Homework, newest first"}</h2>
          <ul className="divide-y divide-forest-900/[0.07]">
            {rows.map((hw) => (
              <HomeworkItem
                key={hw.id}
                hw={hw}
                today={today}
                sectionLabel={label.get(hw.sectionId) ?? ""}
                rollSize={size.get(hw.sectionId) ?? 0}
                mine={hw.createdBy === ctx.actor.accountId}
              />
            ))}
          </ul>
          {rows.length === limit && limit < 300 ? (
            <p className="px-4 py-3 text-[0.9rem] text-muted">
              Showing the latest {limit}.{" "}
              <Link href={`/teach/homework?${only ? `section=${only.id}&` : ""}more=1`} className="font-semibold text-forest-800 underline underline-offset-4">
                Show more
              </Link>
            </p>
          ) : null}
        </Card>
      )}
    </>
  );
}

function HomeworkItem({ hw, today, sectionLabel, rollSize, mine }: { hw: HomeworkRow; today: string; sectionLabel: string; rollSize: number; mine: boolean }) {
  const due = dueText(hw.dueOn, today);
  const c = hw.checks;
  return (
    <li>
      <Link href={`/teach/homework/${hw.id}`} className="block rounded-2xl px-3 py-3.5 transition-colors hover:bg-cream-200/50 sm:px-4">
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone="default">{sectionLabel}</Badge>
          <span className="text-[0.88rem] font-semibold text-muted">{hw.subjectName ?? "General"}</span>
          <Badge tone={due.tone}>{due.text}</Badge>
        </span>
        <span className="mt-1.5 block font-semibold text-forest-900">{hw.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.88rem] text-muted">
          <span>
            Set {formatDate(hw.assignedOn)}
            {mine ? "" : hw.createdByPerson ? ` by ${hw.createdByPerson.name}` : ""}
          </span>
          {c.checked ? (
            <span className="inline-flex items-center gap-1">
              <HomeworkCheckIcon status="done" />
              Checked {c.checked} of {Math.max(rollSize, c.checked)}: {c.done} done
              {c.late ? `, ${c.late} late` : ""}
              {c.not_done ? `, ${c.not_done} not done` : ""}
              {c.excused ? `, ${c.excused} excused` : ""}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <HomeworkCheckIcon status={null} />
              Not checked yet
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}
