import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { ButtonLink, Card, Dl, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { ActionForm } from "@/components/forms";
import { canSeeStudent } from "@/lib/auth/dal";
import { getDb } from "@/lib/db/client";
import { enrolments } from "@/lib/db/schema";
import { formatDate } from "@/lib/dates";
import { teacherPage } from "@/lib/page";
import { isRemarkCategory, remarkForReader, staffRemarkReader } from "@/lib/services/remarks";
import { schoolSmsSettings } from "@/lib/queries/sms";
import { smsMode } from "@/lib/sms/config";
import { eventOn } from "@/lib/sms/settings";
import { updateRemarkAction } from "../actions";
import { RemarkFields } from "../fields";

export const metadata: Metadata = { title: "Edit remark" };

export default async function EditRemarkPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await teacherPage();
  const { id } = await params;
  // Class teachers and admins: any remark about their class; other teachers: their own. Only for a student they work with.
  const r = await remarkForReader(staffRemarkReader(ctx), ctx.schoolId, id);
  if (!r) notFound();
  if (!(await canSeeStudent(ctx.actor, r.studentId))) notFound();
  const db = await getDb();
  const [e] = await db
    .select({ sectionId: enrolments.sectionId })
    .from(enrolments)
    .where(and(eq(enrolments.studentId, r.studentId), eq(enrolments.sessionId, ctx.sessionId)));
  const back = e && ctx.sections.some((s) => s.id === e.sectionId) ? `/teach/remarks?section=${e.sectionId}` : "/teach/remarks";
  const byYou = r.recordedBy === ctx.actor.accountId;
  const smsNote =
    !r.visibleToGuardian && eventOn(await schoolSmsSettings(ctx.schoolId), "remark") && smsMode() !== "off"
      ? "If you now show it to the family, they also get a text message (SMS) saying there is a new note to read on the portal — never the note itself."
      : null;

  return (
    <>
      <PageHeader eyebrow="Remarks" title="Edit remark" description="The change is kept in the activity log, with what the remark said before." />
      <Card className="max-w-2xl">
        <Dl
          className="mb-6 border-b border-forest-900/10 pb-5"
          items={[
            { label: "Student", value: r.studentName },
            { label: "Recorded on", value: formatDate(r.recordedOn, "en", { weekday: true }) },
            { label: "Written by", value: byYou ? "You" : (r.recordedByPerson?.name ?? "A member of staff") },
          ]}
        />
        <ActionForm action={updateRemarkAction}>
          <input type="hidden" name="id" value={r.id} />
          <RemarkFields
            smsNote={smsNote}
            defaults={{
              kind: r.kind,
              category: isRemarkCategory(r.category) ? r.category : undefined,
              note: r.note,
              actionTaken: r.actionTaken,
              visibleToGuardian: r.visibleToGuardian,
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
            <ButtonLink href={back} variant="ghost">
              Cancel
            </ButtonLink>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
