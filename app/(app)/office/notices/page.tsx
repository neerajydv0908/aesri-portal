import type { Metadata } from "next";
import { Megaphone, Pencil, Plus } from "lucide-react";
import { Badge, ButtonLink, EmptyState, PageHeader, TabLinks } from "@/components/ui";
import { ConfirmSubmit } from "@/components/ui/client";
import { ActionForm } from "@/components/forms";
import { Flash, NoticeStateBadge } from "@/components/daily/badges";
import { SmsHint } from "@/components/sms/parts";
import { formatDate, formatDateTime, todayIST } from "@/lib/dates";
import { officePage } from "@/lib/page";
import { noticeSmsCounts, type StatusCounts } from "@/lib/queries/sms";
import { isOfficeNotice, listNotices, noticeAudienceText, noticeCategoryLabel, noticeStatusCounts, noticeTiming, type NoticeRow, type NoticeStatus } from "@/lib/services/notices";
import { archiveNoticeAction, publishNoticeAction } from "./actions";

export const metadata: Metadata = { title: "Notices" };

type Tab = "draft" | "published" | "archived";

export default async function OfficeNoticesPage({ searchParams }: { searchParams: Promise<{ status?: string; done?: string }> }) {
  const ctx = await officePage();
  const sp = await searchParams;
  const tab: Tab = sp.status === "draft" || sp.status === "archived" ? sp.status : "published";
  const statuses: NoticeStatus[] = tab === "draft" ? ["draft", "pending"] : [tab];
  const [counts, rows] = await Promise.all([noticeStatusCounts(ctx.schoolId), listNotices(ctx.schoolId, statuses)]);
  const sms = tab === "draft" ? new Map<string, StatusCounts>() : await noticeSmsCounts(ctx.schoolId, rows.map((r) => r.id));
  const today = todayIST();

  return (
    <>
      <PageHeader
        eyebrow="School office"
        title="Notices"
        description="Notices for the whole school (every family and all staff who sign in), for staff only, for one class, or for chosen students of a class. Teachers’ notices to their own class are listed too."
        actions={
          <ButtonLink href="/office/notices/new">
            <Plus className="h-4 w-4" aria-hidden />
            New notice
          </ButtonLink>
        }
      />
      <Flash
        code={sp.done}
        messages={{
          drafted: "Saved as a draft. Nobody else sees it until you publish it.",
          published: "Published. It shows to its readers from its “show from” date.",
          updated: "Your changes were saved.",
          unchanged: "Nothing had changed.",
          archived: "Archived. It no longer shows to anyone.",
        }}
      />
      <TabLinks
        current={tab}
        tabs={[
          { key: "draft", href: "/office/notices?status=draft", label: `Drafts (${counts.draft + counts.pending})` },
          { key: "published", href: "/office/notices?status=published", label: `Published (${counts.published})` },
          { key: "archived", href: "/office/notices?status=archived", label: `Archived (${counts.archived})` },
        ]}
      />
      {rows.length ? (
        <ul className="grid gap-3">
          {rows.map((n) => (
            <NoticeItem key={n.id} n={n} today={today} tab={tab} sms={sms.get(n.id) ?? null} />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<Megaphone className="h-5 w-5" aria-hidden />}
          title={tab === "draft" ? "No drafts" : tab === "archived" ? "Nothing archived yet" : "No published notices"}
          action={
            tab !== "archived" ? (
              <ButtonLink href="/office/notices/new" variant="secondary">
                Write a notice
              </ButtonLink>
            ) : null
          }
        />
      )}
    </>
  );
}

function audienceBadge(n: NoticeRow) {
  if (n.audience === "staff") return <Badge tone="amber">Staff only</Badge>;
  if (n.audience === "school") return <Badge tone="blue">Whole school</Badge>;
  return <Badge tone="default">{noticeAudienceText(n)}</Badge>;
}

/** "Publish to every family and all staff?" */
function publishQuestion(n: NoticeRow): string {
  if (n.audience === "staff") return "Publish to all staff who sign in?";
  if (n.audience === "school") return "Publish to every family and all staff?";
  if (n.audience === "section") return `Publish to the families of ${n.sectionLabel ?? "the class"}?`;
  return `Publish to the families of ${noticeAudienceText(n)}?`;
}

/** "Text messages: 45 sent, 2 not sent (no mobile number or the family asked not to get them)." */
function smsLine(c: StatusCounts | null, n: NoticeRow, today: string): string | null {
  if (n.status === "published" && n.publishOn > today && !c) return "Text messages go on its “show from” day.";
  if (!c) return null;
  const parts = [
    c.sent ? `${c.sent} sent` : "",
    c.queued ? `${c.queued} waiting to send` : "",
    c.failed ? `${c.failed} failed` : "",
    c.skipped ? `${c.skipped} not sent` : "",
    c.cancelled ? `${c.cancelled} cancelled` : "",
  ].filter(Boolean);
  return parts.length ? `Text messages: ${parts.join(", ")}.` : null;
}

function NoticeItem({ n, today, tab, sms }: { n: NoticeRow; today: string; tab: Tab; sms: StatusCounts | null }) {
  const timing = noticeTiming(n, today);
  const officeOwn = isOfficeNotice(n);
  const canEdit = officeOwn && n.status !== "archived";
  const smsText = smsLine(sms, n, today);
  const canPublish = n.status === "draft" || n.status === "pending";
  const canArchive = n.status !== "archived";
  return (
    <li className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <NoticeStateBadge status={n.status} timing={timing} />
        {audienceBadge(n)}
        <span className="text-[0.88rem] font-semibold text-muted">{noticeCategoryLabel(n.category)}</span>
        {n.version > 1 ? <span className="text-[0.85rem] text-muted">· version {n.version}</span> : null}
      </div>
      <h2 className="mt-2 font-sans text-[1.08rem] font-bold tracking-normal text-forest-900">{n.titleEn}</h2>
      {n.titleHi ? (
        <p lang="hi" className="text-[0.95rem] text-forest-900/80">
          {n.titleHi}
        </p>
      ) : (
        <p className="text-[0.85rem] text-muted">No Hindi version</p>
      )}
      <p className="mt-2 line-clamp-3 whitespace-pre-line text-forest-900">{n.bodyEn}</p>
      <p className="mt-3 text-[0.85rem] text-muted">
        {timing === "scheduled" ? `Shows from ${formatDate(n.publishOn)}` : `From ${formatDate(n.publishOn)}`}
        {n.expiresOn ? ` until ${formatDate(n.expiresOn)}` : " · no end date"}
        {n.createdByPerson ? ` · written by ${n.createdByPerson.name}` : ""}
        {n.status === "published" && n.approvedByPerson && n.approvedAt ? ` · published by ${n.approvedByPerson.name}, ${formatDateTime(n.approvedAt)}` : ""}
      </p>
      {smsText ? <SmsHint className="mt-2">{smsText}</SmsHint> : null}
      {canEdit || canPublish || canArchive ? (
        <div className="mt-4 flex flex-wrap items-start gap-2 border-t border-forest-900/10 pt-4">
          {canEdit ? (
            <ButtonLink href={`/office/notices/${n.id}`} variant="secondary" size="sm">
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit<span className="sr-only"> “{n.titleEn}”</span>
            </ButtonLink>
          ) : null}
          {canPublish ? (
            <ActionForm action={publishNoticeAction} className="gap-2">
              <input type="hidden" name="id" value={n.id} />
              <div>
                <ConfirmSubmit variant="primary" question={publishQuestion(n)} confirmLabel="Yes, publish">
                  Publish<span className="sr-only"> “{n.titleEn}”</span>
                </ConfirmSubmit>
              </div>
            </ActionForm>
          ) : null}
          {canArchive ? (
            <ActionForm action={archiveNoticeAction} className="gap-2">
              <input type="hidden" name="id" value={n.id} />
              <input type="hidden" name="back" value={tab} />
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
