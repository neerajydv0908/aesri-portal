/**
 * Small pieces of the text message (SMS) screens: a message's status (word
 * and icon, never colour alone), a masked mobile number, and the one-line
 * hint that tells staff when a text message will go.
 */
import type { ReactNode } from "react";
import clsx from "clsx";
import { Ban, Check, CircleMinus, Clock, FlaskConical, RotateCw, Smartphone, XCircle } from "lucide-react";
import { Badge } from "@/components/ui";
import { maskMobile } from "@/lib/sms/templates";

const ic = "h-3.5 w-3.5 shrink-0";

export function SmsStatusBadge({ status, provider, attempts = 0 }: { status: string; provider?: string | null; attempts?: number }) {
  switch (status) {
    case "sent":
      return provider === "log" ? (
        <Badge tone="blue">
          <FlaskConical className={ic} aria-hidden />
          Sent (test mode)
        </Badge>
      ) : (
        <Badge tone="green">
          <Check className={ic} strokeWidth={3} aria-hidden />
          Sent
        </Badge>
      );
    case "queued":
      return attempts > 0 ? (
        <Badge tone="amber">
          <RotateCw className={ic} aria-hidden />
          Will try again
        </Badge>
      ) : (
        <Badge tone="default">
          <Clock className={ic} aria-hidden />
          Waiting to send
        </Badge>
      );
    case "failed":
      return (
        <Badge tone="red">
          <XCircle className={ic} aria-hidden />
          Failed
        </Badge>
      );
    case "skipped":
      return (
        <Badge tone="grey">
          <CircleMinus className={ic} aria-hidden />
          Not sent
        </Badge>
      );
    default:
      return (
        <Badge tone="grey">
          <Ban className={ic} aria-hidden />
          Cancelled
        </Badge>
      );
  }
}

/** "98•••••12", read out as "mobile ending 12". */
export function MaskedMobile({ mobile, className }: { mobile: string; className?: string }) {
  const digits = mobile.replace(/\D/g, "");
  if (digits.length < 4) return <span className={clsx("text-muted", className)}>No number</span>;
  return (
    <span className={clsx("whitespace-nowrap tabular", className)}>
      <span aria-hidden>{maskMobile(digits)}</span>
      <span className="sr-only">mobile ending {digits.slice(-2)}</span>
    </span>
  );
}

/** A quiet line under a form saying what text message will go (or why none will). */
export function SmsHint({ children, id, className }: { children: ReactNode; id?: string; className?: string }) {
  return (
    <p id={id} className={clsx("flex items-start gap-2 text-[0.88rem] text-forest-900/85", className)}>
      <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-forest-700" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
