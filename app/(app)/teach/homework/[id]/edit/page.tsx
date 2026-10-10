import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ButtonLink, Card, Dl, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { ActionForm } from "@/components/forms";
import { teacherPage } from "@/lib/page";
import { sessionBounds } from "@/lib/services/attendance";
import { homeworkById } from "@/lib/services/homework";
import { updateHomeworkAction } from "../../actions";
import { HomeworkFields } from "../../fields";
import { homeworkAccess } from "../../scope";

export const metadata: Metadata = { title: "Edit homework" };

export default async function EditHomeworkPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await teacherPage();
  const { id } = await params;
  const hw = await homeworkById(id);
  if (!hw) notFound();
  const access = await homeworkAccess(ctx, hw);
  const section = ctx.sections.find((s) => s.id === hw.sectionId);
  if (!access.edit || !section) notFound();
  const bounds = await sessionBounds(ctx.sessionId);

  return (
    <>
      <PageHeader eyebrow="Homework" title="Edit homework" description="Families see the change straight away. Checks already recorded are kept." />
      <Card className="max-w-2xl">
        <Dl
          className="mb-6 border-b border-forest-900/10 pb-5"
          items={[
            { label: "Class", value: section.longLabel },
            { label: "Subject", value: hw.subjectName ?? "General (class teacher)" },
          ]}
        />
        <ActionForm action={updateHomeworkAction}>
          <input type="hidden" name="id" value={hw.id} />
          <HomeworkFields defaults={hw} min={bounds.startsOn} max={bounds.endsOn} />
          <p className="text-[0.88rem] text-muted">To move homework to another class or subject, delete it and set it again.</p>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
            <ButtonLink href={`/teach/homework/${hw.id}`} variant="ghost">
              Cancel
            </ButtonLink>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
