import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, ButtonLink, Card, PageHeader } from "@/components/ui";
import { NoticeStateBadge } from "@/components/daily/badges";
import { NoticeTargetPicker } from "@/components/sms/notice-audience";
import { formatDate, todayIST } from "@/lib/dates";
import { officePage } from "@/lib/page";
import { noticeSmsInfo } from "@/lib/queries/sms";
import { sessionBounds } from "@/lib/services/attendance";
import { isOfficeNotice, noticeAudienceText, noticeById, noticeRecipientsOf, noticeTiming } from "@/lib/services/notices";
import { OfficeNoticeForm } from "../notice-form";
import { chooseNoticeTo } from "../target";

export const metadata: Metadata = { title: "Edit notice" };

export default async function EditNoticePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ to?: string }> }) {
  const ctx = await officePage();
  const { id } = await params;
  const sp = await searchParams;
  const n = await noticeById(id);
  // The office edits its own notices; teachers' class notices can only be archived (from the list).
  if (!n || n.schoolId !== ctx.schoolId || !isOfficeNotice(n)) notFound();
  const today = todayIST();
  if (n.status === "archived") {
    return (
      <>
        <PageHeader eyebrow="Notices" title="Archived notice" description={<NoticeStateBadge status={n.status} timing={noticeTiming(n, today)} />} />
        <Card className="max-w-3xl">
          <Alert tone="blue" title="This notice is archived">
            Archived notices are kept for the record and can’t be changed. To say something new, write a new notice.
          </Alert>
          <h2 className="mt-5 font-sans text-[1.08rem] font-bold tracking-normal text-forest-900">{n.titleEn}</h2>
          <p className="mt-1 text-[0.9rem] text-muted">For: {noticeAudienceText(n)}</p>
          <p className="mt-2 whitespace-pre-line text-forest-900">{n.bodyEn}</p>
          <p className="mt-3 text-[0.85rem] text-muted">
            Showed from {formatDate(n.publishOn)}
            {n.expiresOn ? ` until ${formatDate(n.expiresOn)}` : ""} · version {n.version}
          </p>
          <ButtonLink href="/office/notices?status=archived" variant="secondary" className="mt-5">
            Back to archived notices
          </ButtonLink>
        </Card>
      </>
    );
  }
  const [bounds, choice, sms, recipients] = await Promise.all([
    sessionBounds(ctx.sessionId),
    chooseNoticeTo(ctx, sp.to, n),
    noticeSmsInfo(ctx.schoolId),
    n.audience === "students" ? noticeRecipientsOf(n.id) : Promise.resolve([]),
  ]);
  return (
    <>
      <PageHeader eyebrow="Notices" title="Edit notice" description={<NoticeStateBadge status={n.status} timing={noticeTiming(n, today)} />} />
      <Card className="grid max-w-3xl gap-6">
        <NoticeTargetPicker action={`/office/notices/${n.id}`} value={choice.value} sections={choice.sections} />
        <OfficeNoticeForm
          notice={n}
          to={choice.to}
          roll={choice.roll}
          chosen={recipients.map((r) => r.id)}
          today={today}
          minDate={bounds.startsOn}
          maxDate={bounds.endsOn}
          sms={sms}
        />
      </Card>
    </>
  );
}
