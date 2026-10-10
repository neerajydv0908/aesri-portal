/**
 * Status badges for attendance, homework checks, remarks and notices.
 * Each has an icon and a word as well as a colour, in English or Hindi.
 */
import type { ReactNode } from "react";
import { Alert, Badge, type Tone } from "@/components/ui";
import { CalendarClock, CalendarOff, Check, CircleCheck, CircleDashed, CircleMinus, CircleX, Clock, Eye, EyeOff, Flag, Hourglass, Star, X } from "lucide-react";
import type { Lang } from "@/lib/i18n";
import { ATTENDANCE_LABELS, type AttendanceStatus } from "@/lib/services/attendance";
import { HOMEWORK_CHECK_LABELS, NOT_CHECKED_LABEL, type HomeworkCheck } from "@/lib/services/homework";
import { REMARK_KIND_LABELS, type RemarkKind } from "@/lib/services/remarks";

const ic = "h-3.5 w-3.5 shrink-0";

export const ATTENDANCE_TONE: Record<AttendanceStatus, Tone> = { present: "green", absent: "red", late: "amber", leave: "grey" };

export function AttendanceIcon({ status, className = ic }: { status: AttendanceStatus; className?: string }) {
  switch (status) {
    case "present":
      return <Check className={className} strokeWidth={3} aria-hidden />;
    case "absent":
      return <X className={className} strokeWidth={3} aria-hidden />;
    case "late":
      return <Clock className={className} strokeWidth={2.5} aria-hidden />;
    default:
      return <CalendarOff className={className} strokeWidth={2.5} aria-hidden />;
  }
}

export function AttendanceBadge({ status, lang = "en" }: { status: AttendanceStatus | null; lang?: Lang }) {
  if (!status) {
    return (
      <Badge tone="grey">
        <CircleDashed className={ic} aria-hidden />
        {lang === "hi" ? "दर्ज नहीं" : "Not marked"}
      </Badge>
    );
  }
  return (
    <Badge tone={ATTENDANCE_TONE[status]}>
      <AttendanceIcon status={status} />
      {ATTENDANCE_LABELS[status][lang]}
    </Badge>
  );
}

const HW_TONE: Record<HomeworkCheck, Tone> = { done: "green", late: "amber", not_done: "red", excused: "grey" };

export function HomeworkCheckIcon({ status, className = ic }: { status: HomeworkCheck | null; className?: string }) {
  switch (status) {
    case "done":
      return <CircleCheck className={className} aria-hidden />;
    case "late":
      return <Clock className={className} aria-hidden />;
    case "not_done":
      return <CircleX className={className} aria-hidden />;
    case "excused":
      return <CircleMinus className={className} aria-hidden />;
    default:
      return <CircleDashed className={className} aria-hidden />;
  }
}

export function HomeworkCheckBadge({ status, lang = "en" }: { status: HomeworkCheck | null; lang?: Lang }) {
  return (
    <Badge tone={status ? HW_TONE[status] : "default"}>
      <HomeworkCheckIcon status={status} />
      {status ? HOMEWORK_CHECK_LABELS[status][lang] : NOT_CHECKED_LABEL[lang]}
    </Badge>
  );
}

export function RemarkKindBadge({ kind, lang = "en" }: { kind: RemarkKind; lang?: Lang }) {
  return kind === "appreciation" ? (
    <Badge tone="green">
      <Star className={ic} aria-hidden />
      {REMARK_KIND_LABELS.appreciation[lang]}
    </Badge>
  ) : (
    <Badge tone="amber">
      <Flag className={ic} aria-hidden />
      {REMARK_KIND_LABELS.concern[lang]}
    </Badge>
  );
}

export function VisibilityBadge({ visible }: { visible: boolean }) {
  return visible ? (
    <Badge tone="blue">
      <Eye className={ic} aria-hidden />
      Family can see
    </Badge>
  ) : (
    <Badge tone="grey">
      <EyeOff className={ic} aria-hidden />
      Staff only
    </Badge>
  );
}

/** Where a notice stands: draft, live, scheduled, ended or archived. */
export function NoticeStateBadge({ status, timing }: { status: string; timing: "live" | "scheduled" | "expired" | null }) {
  if (status === "archived") return <Badge tone="grey">Archived</Badge>;
  if (status === "draft" || status === "pending") {
    return (
      <Badge tone="default">
        <Hourglass className={ic} aria-hidden />
        {status === "pending" ? "Waiting for approval" : "Draft"}
      </Badge>
    );
  }
  if (timing === "scheduled") {
    return (
      <Badge tone="blue">
        <CalendarClock className={ic} aria-hidden />
        Scheduled
      </Badge>
    );
  }
  if (timing === "expired") return <Badge tone="grey">Ended</Badge>;
  return (
    <Badge tone="green">
      <Check className={ic} strokeWidth={3} aria-hidden />
      Live
    </Badge>
  );
}

export { Flash } from "@/components/flash";
