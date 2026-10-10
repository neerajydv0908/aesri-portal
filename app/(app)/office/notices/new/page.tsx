import type { Metadata } from "next";
import { Card, PageHeader } from "@/components/ui";
import { NoticeTargetPicker } from "@/components/sms/notice-audience";
import { todayIST } from "@/lib/dates";
import { officePage } from "@/lib/page";
import { noticeSmsInfo } from "@/lib/queries/sms";
import { sessionBounds } from "@/lib/services/attendance";
import { OfficeNoticeForm } from "../notice-form";
import { chooseNoticeTo } from "../target";

export const metadata: Metadata = { title: "New notice" };

export default async function NewNoticePage({ searchParams }: { searchParams: Promise<{ to?: string }> }) {
  const ctx = await officePage();
  const sp = await searchParams;
  const [bounds, choice, sms] = await Promise.all([sessionBounds(ctx.sessionId), chooseNoticeTo(ctx, sp.to), noticeSmsInfo(ctx.schoolId)]);
  return (
    <>
      <PageHeader
        eyebrow="Notices"
        title="New notice"
        description="Save it as a draft to check it first, or publish it now. A published notice shows from its “show from” date."
      />
      <Card className="grid max-w-3xl gap-6">
        <NoticeTargetPicker action="/office/notices/new" value={choice.value} sections={choice.sections} />
        <OfficeNoticeForm to={choice.to} roll={choice.roll} chosen={[]} today={todayIST()} minDate={bounds.startsOn} maxDate={bounds.endsOn} sms={sms} />
      </Card>
    </>
  );
}
