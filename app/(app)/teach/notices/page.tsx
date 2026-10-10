import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Megaphone, Pencil } from "lucide-react";
import { Alert, Badge, ButtonLink, Card, CardTitle, EmptyState, PageHeader } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { ActionForm } from "@/components/forms";
import { Flash, NoticeStateBadge } from "@/components/daily/badges";
import { NoticeFields } from "@/components/daily/notice-fields";
import { FilterBar, SectionField } from "@/components/pickers";
import { ClassAudienceFields } from "@/components/sms/notice-audience";
import { SmsHint } from "@/components/sms/parts";
import { classNoticeSmsText } from "@/components/sms/texts";
import { formatDate, todayIST } from "@/lib/dates";
import { teacherPage } from "@/lib/page";
import { sectionStudents } from "@/lib/queries/school";
import { noticeSmsInfo } from "@/lib/queries/sms";
import { sessionBounds } from "@/lib/services/attendance";
import { activeNoticesForStaff, listClassNotices, noticeAudienceText, noticeCategoryLabel, noticeTiming, type NoticeRow } from "@/lib/services/notices";
import { archiveClassNoticeAction, postClassNoticeAction } from "./actions";

export const metadata: Metadata = { title: "Class notices" };

export default async function TeachNoticesPage({ searchParams }: { searchParams: Promise<{ done?: string; section?: string }> }) {
  const ctx = await teacherPage();
  const sp = await searchParams;
  const today = todayIST();
  const mySections = ctx.classTeacherSections;
  // A section someone may not post to is "not found" — never another class's list of students.
  const section = typeof sp.section === "string" && sp.section ? mySections.find((s) => s.id === sp.section) : mySections[0];
  if (mySections.length && !section) notFound();
  const [bounds, mine, office, roll, sms] = await Promise.all([
    sessionBounds(ctx.sessionId),
    listClassNotices(
      ctx.schoolId,
      mySections.map((s) => s.id),
    ),
    activeNoticesForStaff(ctx.schoolId, today),
    section ? sectionStudents(section.id) : Promise.resolve([]),
    noticeSmsInfo(ctx.schoolId),
  ]);

  return (
    <>
      <PageHeader
        eyebrow={ctx.isAdmin ? "Notices" : "Class teacher"}
        title="Class notices"
        description="Post a notice to the families of your class. It shows on their Notices page straight away."
      />
      <Flash
        code={sp.done}
        messages={{
          updated: "Your notice was updated. Families now see the new version.",
          unchanged: "Nothing had changed.",
          archived: "The notice was archived. Families no longer see it.",
        }}
      />

      {mySections.length && section ? (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card>
            <CardTitle>Post a notice</CardTitle>
            {mySections.length > 1 ? (
              <FilterBar submitLabel="Choose">
                <SectionField sections={mySections} value={section.id} label="Class" />
              </FilterBar>
            ) : null}
            {/* Keyed by class, so switching class starts a fresh form. */}
            <ActionForm key={section.id} action={postClassNoticeAction} resetOnSuccess>
              <input type="hidden" name="section" value={section.id} />
              <p className="text-[0.95rem] text-forest-900">
                For the families of <span className="font-semibold">{section.longLabel}</span>
                {mySections.length > 1 ? " (choose another class above)" : ""}.
              </p>
              <ClassAudienceFields sectionLabel={section.label} roll={roll.map((r) => ({ id: r.id, name: r.name, rollNo: r.rollNo }))} />
              <NoticeFields withPublishOn={false} minDate={today} maxDate={bounds.endsOn} />
              <SmsHint>{classNoticeSmsText(section.label, sms)}</SmsHint>
              <div>
                <SubmitButton pendingLabel="Posting…">Post notice</SubmitButton>
              </div>
            </ActionForm>
          </Card>

          <section aria-labelledby="my-notices">
            <h2 id="my-notices" className="mb-3 font-display text-[1.35rem] text-forest-900">
              Notices to your {mySections.length === 1 ? "class" : "classes"}
            </h2>
            {mine.length ? (
              <ul className="grid gap-3">
                {mine.map((n) => (
                  <ClassNoticeItem
                    key={n.id}
                    n={n}
                    today={today}
                    canEdit={n.createdBy === ctx.actor.accountId && n.status !== "archived"}
                    canArchive={(n.createdBy === ctx.actor.accountId || ctx.isAdmin) && n.status !== "archived"}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Megaphone className="h-5 w-5" aria-hidden />} title="No class notices yet">
                Notices you post appear here, newest first.
              </EmptyState>
            )}
          </section>
        </div>
      ) : (
        <Alert tone="blue" className="mb-6">
          Class notices are posted by class teachers. You aren’t the class teacher of a section this session, so you can read the office’s notices below.
        </Alert>
      )}

      <section aria-labelledby="from-office" className="mt-10">
        <h2 id="from-office" className="mb-1 font-display text-[1.45rem] text-forest-900">
          From the office
        </h2>
        <p className="mb-4 text-muted">Notices for the whole school, and for staff only, that are showing today.</p>
        {office.length ? (
          <ul className="grid gap-3">
            {office.map((n) => (
              <li key={n.id} className="card p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={n.audience === "staff" ? "amber" : "blue"}>{n.audience === "staff" ? "Staff only" : "Whole school"}</Badge>
                  <span className="text-[0.88rem] font-semibold text-muted">{noticeCategoryLabel(n.category)}</span>
                </div>
                <h3 className="mt-2 font-sans text-[1.05rem] font-bold tracking-normal text-forest-900">{n.titleEn}</h3>
                <p className="mt-1 whitespace-pre-line text-forest-900">{n.bodyEn}</p>
                <p className="mt-2 text-[0.85rem] text-muted">
                  From {formatDate(n.publishOn)}
                  {n.expiresOn ? ` until ${formatDate(n.expiresOn)}` : ""}
                  {n.version > 1 ? ` · updated (version ${n.version})` : ""}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<Megaphone className="h-5 w-5" aria-hidden />} title="No notices from the office today" />
        )}
      </section>
    </>
  );
}

function ClassNoticeItem({ n, today, canEdit, canArchive }: { n: NoticeRow; today: string; canEdit: boolean; canArchive: boolean }) {
  return (
    <li className="card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <NoticeStateBadge status={n.status} timing={noticeTiming(n, today)} />
        {n.sectionLabel ? <Badge tone="default">{n.audience === "students" ? noticeAudienceText(n) : n.sectionLabel}</Badge> : null}
        <span className="text-[0.88rem] font-semibold text-muted">{noticeCategoryLabel(n.category)}</span>
      </div>
      <h3 className="mt-2 font-sans text-[1.05rem] font-bold tracking-normal text-forest-900">{n.titleEn}</h3>
      <p className="mt-1 line-clamp-4 whitespace-pre-line text-forest-900">{n.bodyEn}</p>
      {n.titleHi ? (
        <p lang="hi" className="mt-1 text-[0.9rem] text-muted">
          हिंदी: {n.titleHi}
        </p>
      ) : null}
      <p className="mt-2 text-[0.85rem] text-muted">
        Posted {formatDate(n.publishOn)}
        {n.createdByPerson ? ` by ${n.createdByPerson.name}` : ""}
        {n.expiresOn ? ` · shows until ${formatDate(n.expiresOn)}` : ""}
        {n.version > 1 ? ` · version ${n.version}` : ""}
      </p>
      {canEdit || canArchive ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canEdit ? (
            <ButtonLink href={`/teach/notices/${n.id}`} variant="ghost" size="sm">
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit<span className="sr-only"> “{n.titleEn}”</span>
            </ButtonLink>
          ) : null}
          {canArchive ? (
            <ActionForm action={archiveClassNoticeAction} className="gap-2">
              <input type="hidden" name="id" value={n.id} />
              <div>
                <ConfirmSubmit question="Stop showing this notice?" confirmLabel="Yes, archive">
                  Archive<span className="sr-only"> “{n.titleEn}”</span>
                </ConfirmSubmit>
              </div>
            </ActionForm>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
