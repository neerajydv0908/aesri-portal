/**
 * Fee line status, shown with a word and an icon (never colour alone).
 */
import { AlertCircle, BadgeCheck, CheckCircle2, Clock, MinusCircle } from "lucide-react";
import { Badge } from "@/components/ui";
import { formatDate, type Lang } from "@/lib/dates";
import { isRteWaiver, type LedgerCharge } from "@/lib/services/fees";

export type LineState = "paid" | "overdue" | "due" | "upcoming" | "rte" | "waived";

export function lineState(l: Pick<LedgerCharge, "waived" | "waiverNote" | "outstanding" | "dueOn">, today: string): LineState {
  if (l.waived) return isRteWaiver(l.waiverNote) ? "rte" : "waived";
  if (l.outstanding <= 0) return "paid";
  if (l.dueOn < today) return "overdue";
  if (l.dueOn === today) return "due";
  return "upcoming";
}

export function LineStatus({ line, today, lang = "en" }: { line: Pick<LedgerCharge, "waived" | "waiverNote" | "outstanding" | "dueOn" | "paid">; today: string; lang?: Lang }) {
  const t = (en: string, hi: string) => (lang === "hi" ? hi : en);
  const part = line.paid > 0 && line.outstanding > 0;
  switch (lineState(line, today)) {
    case "paid":
      return (
        <Badge tone="green">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          {t("Paid", "जमा हो गई")}
        </Badge>
      );
    case "overdue":
      return (
        <Badge tone="red">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden />
          {part ? t("Part paid · overdue", "आंशिक जमा · देय तिथि बीत गई") : t("Overdue", "देय तिथि बीत गई")}
        </Badge>
      );
    case "due":
      return (
        <Badge tone="amber">
          <Clock className="h-3.5 w-3.5" aria-hidden />
          {part ? t("Part paid · due today", "आंशिक जमा · आज देय") : t("Due today", "आज देय")}
        </Badge>
      );
    case "upcoming":
      return (
        <Badge tone="grey">
          <Clock className="h-3.5 w-3.5" aria-hidden />
          {part ? t("Part paid", "आंशिक जमा") : t(`Due ${formatDate(line.dueOn, "en")}`, `${formatDate(line.dueOn, "hi")} तक देय`)}
        </Badge>
      );
    case "rte":
      return (
        <Badge tone="blue">
          <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
          {t("RTE — no fee", "RTE — कोई फ़ीस नहीं")}
        </Badge>
      );
    default:
      return (
        <Badge tone="grey">
          <MinusCircle className="h-3.5 w-3.5" aria-hidden />
          {t("Waived", "माफ़")}
        </Badge>
      );
  }
}

/** A cash payment the family recorded: waiting for approval, approved, declined or withdrawn (word and icon). */
export function ClaimStatus({ status, lang = "en" }: { status: "pending" | "approved" | "declined" | "withdrawn"; lang?: Lang }) {
  const t = (en: string, hi: string) => (lang === "hi" ? hi : en);
  switch (status) {
    case "pending":
      return (
        <Badge tone="amber">
          <Clock className="h-3.5 w-3.5" aria-hidden />
          {t("Waiting for approval", "स्वीकृति की प्रतीक्षा")}
        </Badge>
      );
    case "approved":
      return (
        <Badge tone="green">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          {t("Approved", "स्वीकृत")}
        </Badge>
      );
    case "declined":
      return (
        <Badge tone="red">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden />
          {t("Declined", "अस्वीकृत")}
        </Badge>
      );
    default:
      return (
        <Badge tone="grey">
          <MinusCircle className="h-3.5 w-3.5" aria-hidden />
          {t("Withdrawn", "हटाया गया")}
        </Badge>
      );
  }
}

/** Overall position of one student, for lists. */
export function StudentFeeBadge({ rte, lines, outstanding, overdue, dueNow }: { rte: boolean; lines: number; outstanding: number; overdue: number; dueNow: number }) {
  if (!lines) return <Badge tone="grey">No fee lines</Badge>;
  if (overdue > 0)
    return (
      <Badge tone="red">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden />
        Overdue
      </Badge>
    );
  if (dueNow > 0)
    return (
      <Badge tone="amber">
        <Clock className="h-3.5 w-3.5" aria-hidden />
        Due today
      </Badge>
    );
  if (outstanding > 0)
    return (
      <Badge tone="grey">
        <Clock className="h-3.5 w-3.5" aria-hidden />
        Not yet due
      </Badge>
    );
  if (rte)
    return (
      <Badge tone="blue">
        <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
        RTE — no fee
      </Badge>
    );
  return (
    <Badge tone="green">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
      Paid up
    </Badge>
  );
}
