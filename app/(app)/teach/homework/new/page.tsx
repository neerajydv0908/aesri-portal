import type { Metadata } from "next";
import { NotebookPen } from "lucide-react";
import { ButtonLink, Card, EmptyState, Field, PageHeader, Select } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { ActionForm, FieldError } from "@/components/forms";
import { addDays, todayIST, weekdayOf } from "@/lib/dates";
import { teacherPage } from "@/lib/page";
import { sessionBounds } from "@/lib/services/attendance";
import { createHomeworkAction } from "../actions";
import { HomeworkFields } from "../fields";
import { homeworkPairs, type HomeworkPair } from "../scope";

export const metadata: Metadata = { title: "Set homework" };

export default async function NewHomeworkPage({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const ctx = await teacherPage();
  const sp = await searchParams;
  const pairs = await homeworkPairs(ctx);
  const header = (
    <PageHeader
      eyebrow="Homework"
      title="Set homework"
      description="Families will see it on their homework page. You can record who did it once it’s due."
      actions={
        <ButtonLink href="/teach/homework" variant="secondary">
          All homework
        </ButtonLink>
      }
    />
  );
  if (!pairs.length) {
    return (
      <>
        {header}
        <EmptyState icon={<NotebookPen className="h-5 w-5" aria-hidden />} title="No classes to set homework for">
          You can set homework for the subjects you teach, and general homework for your own class. If that’s wrong, please tell the school office.
        </EmptyState>
      </>
    );
  }

  const today = todayIST();
  const bounds = await sessionBounds(ctx.sessionId);
  let due = addDays(today, 1);
  if (weekdayOf(due) === 0) due = addDays(due, 1);
  const wanted = typeof sp.section === "string" ? pairs.filter((p) => p.section.id === sp.section) : [];
  const preselect = pairs.length === 1 ? pairs[0].key : wanted.length ? wanted[0].key : "";
  const groups = new Map<string, HomeworkPair[]>();
  for (const p of pairs) groups.set(p.section.id, [...(groups.get(p.section.id) ?? []), p]);

  return (
    <>
      {header}
      <Card className="max-w-2xl">
        <ActionForm action={createHomeworkAction}>
          <Field label="Class and subject" htmlFor="pair" required>
            <Select id="pair" name="pair" required defaultValue={preselect} aria-describedby="pair-error">
              <option value="" disabled>
                Choose a class and subject…
              </option>
              {[...groups.values()].map((list) => (
                <optgroup key={list[0].section.id} label={list[0].section.longLabel}>
                  {list.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.section.label} · {p.subjectName}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            <FieldError name="pair" />
          </Field>
          <HomeworkFields
            defaults={{ assignedOn: today < bounds.endsOn ? today : bounds.endsOn, dueOn: due < bounds.endsOn ? due : bounds.endsOn }}
            min={bounds.startsOn}
            max={bounds.endsOn}
          />
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pendingLabel="Saving…">Set homework</SubmitButton>
            <ButtonLink href="/teach/homework" variant="ghost">
              Cancel
            </ButtonLink>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
