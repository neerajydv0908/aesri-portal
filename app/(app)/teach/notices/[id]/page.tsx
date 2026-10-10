import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ButtonLink, Card, Dl, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { ActionForm } from "@/components/forms";
import { NoticeFields } from "@/components/daily/notice-fields";
import { ClassAudienceFields } from "@/components/sms/notice-audience";
import { SmsHint } from "@/components/sms/parts";
import { classNoticeSmsText } from "@/components/sms/texts";
import { formatDate } from "@/lib/dates";
import { teacherPage } from "@/lib/page";
import { sectionStudents } from "@/lib/queries/school";
import { noticeSmsInfo } from "@/lib/queries/sms";
import { sessionBounds } from "@/lib/services/attendance";
import { isNoticeCategory, noticeAudienceText, noticeById, noticeRecipientsOf } from "@/lib/services/notices";
import { updateClassNoticeAction } from "../actions";

export const metadata: Metadata = { title: "Edit class notice" };

export default async function EditClassNoticePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await teacherPage();
  const { id } = await params;
  const n = await noticeById(id);
  // Only the author, for a class they are still class teacher of.
  if (!n || n.schoolId !== ctx.schoolId || (n.audience !== "section" && n.audience !== "students") || n.createdBy !== ctx.actor.accountId) notFound();
  const section = ctx.classTeacherSections.find((s) => s.id === n.sectionId);
  if (!section || n.status === "archived") notFound();
  const [bounds, roll, chosen, sms] = await Promise.all([
    sessionBounds(ctx.sessionId),
    sectionStudents(section.id),
    n.audience === "students" ? noticeRecipientsOf(n.id) : Promise.resolve([]),
    noticeSmsInfo(ctx.schoolId),
  ]);
  // Only students on the roll now can be ticked: saving drops any chosen student who has since left the class.
  const list = roll.map((r) => ({ id: r.id, name: r.name, rollNo: r.rollNo }));

  return (
    <>
      <PageHeader
        eyebrow="Class notices"
        title="Edit notice"
        description={`Families see the new version straight away. This will be version ${n.version + 1}; the earlier wording is kept in the activity log.`}
      />
      <Card className="max-w-2xl">
        <Dl
          className="mb-6 border-b border-forest-900/10 pb-5"
          items={[
            { label: "For", value: noticeAudienceText(n) },
            { label: "Posted on", value: formatDate(n.publishOn, "en", { weekday: true }) },
          ]}
        />
        <ActionForm action={updateClassNoticeAction}>
          <input type="hidden" name="id" value={n.id} />
          <ClassAudienceFields sectionLabel={section.label} roll={list} defaultScope={n.audience === "students" ? "students" : "section"} defaultChosen={chosen.map((c) => c.id)} />
          <NoticeFields
            withPublishOn={false}
            minDate={n.publishOn}
            maxDate={bounds.endsOn}
            defaults={{ ...n, category: isNoticeCategory(n.category) ? n.category : "general" }}
          />
          <SmsHint>{classNoticeSmsText(section.label, sms, true)}</SmsHint>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
            <ButtonLink href={`/teach/notices?section=${section.id}`} variant="ghost">
              Cancel
            </ButtonLink>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
