/** The "Text messages" card on a student's record: where messages go, the family's choice, and their last messages. */
import Link from "next/link";
import { BellOff, Phone } from "lucide-react";
import { ActionForm } from "@/components/forms";
import { MaskedMobile, SmsStatusBadge } from "@/components/sms/parts";
import { Alert, Badge, Card, CardTitle } from "@/components/ui";
import { ConfirmSubmit } from "@/components/ui/client";
import { formatDateTime } from "@/lib/dates";
import type { studentSmsHistory } from "@/lib/queries/sms";
import { KIND_LABELS, type ResolvedSmsSettings } from "@/lib/sms/settings";
import { validMobile } from "@/lib/sms/templates";
import { smsOffAction } from "./actions";

type History = Awaited<ReturnType<typeof studentSmsHistory>>;

export function StudentSmsCard({
  studentId,
  srNo,
  info,
  settings,
  history,
  current,
}: {
  studentId: string;
  srNo: string;
  info: { smsOff: boolean; guardianMobile: string | null; mobile2: string | null };
  settings: ResolvedSmsSettings;
  history: History;
  current: boolean;
}) {
  const first = validMobile(info.guardianMobile);
  const second = validMobile(info.mobile2);
  const numbers = [first, settings.alsoSecondMobile && second && second !== first ? second : null].filter((m): m is string => !!m);
  return (
    <Card>
      <CardTitle>Text messages</CardTitle>
      {!settings.enabled ? (
        <Alert tone="blue" className="mb-4">
          Text messages are switched off for the school (<Link href="/office/settings" className="font-semibold underline underline-offset-2">Settings</Link>).
        </Alert>
      ) : null}
      <div className="grid gap-3">
        <p className="flex flex-wrap items-center gap-2">
          {info.smsOff ? (
            <Badge tone="grey">
              <BellOff className="h-3.5 w-3.5" aria-hidden />
              Off: the family asked not to get them
            </Badge>
          ) : (
            <Badge tone="green">On</Badge>
          )}
        </p>
        {numbers.length ? (
          <div className="text-[0.95rem] text-forest-900">
            <p className="font-semibold">{info.smsOff ? "Would go to" : "Messages go to"}</p>
            <ul className="mt-1 grid gap-1">
              {numbers.map((m, i) => (
                <li key={m} className="flex items-center gap-1.5 tabular">
                  <Phone className="h-3.5 w-3.5 text-muted" aria-hidden />
                  {m}
                  <span className="text-[0.85rem] text-muted">{i === 0 ? "· parent’s mobile" : "· second mobile"}</span>
                </li>
              ))}
            </ul>
            {!settings.alsoSecondMobile && second && second !== first ? (
              <p className="mt-1 text-[0.85rem] text-muted">The second mobile isn’t used: the school sends to the parent’s mobile only (Settings).</p>
            ) : null}
          </div>
        ) : (
          <p className="text-[0.92rem] text-forest-900">No valid mobile number on record, so no messages can be sent. Add the parent’s mobile under “Edit details”.</p>
        )}
        {current ? (
          <ActionForm action={smsOffAction.bind(null, studentId)} aria-label="Text messages to this family" className="gap-3">
            <input type="hidden" name="smsOff" value={info.smsOff ? "no" : "yes"} />
            <p className="text-[0.88rem] text-muted">
              {info.smsOff
                ? "Only if the family has asked for text messages again. The change is kept in the activity log."
                : "Only if the family has asked not to get text messages. They still see everything in the portal; the change is kept in the activity log."}
            </p>
            <div>
              <ConfirmSubmit
                key={info.smsOff ? "on" : "off"}
                variant={info.smsOff ? "primary" : "danger"}
                question={info.smsOff ? "Send text messages to this family again?" : "Stop text messages to this family?"}
                confirmLabel={info.smsOff ? "Yes, send them again" : "Yes, stop them"}
              >
                {info.smsOff ? "Send text messages again" : "Stop text messages"}
              </ConfirmSubmit>
            </div>
          </ActionForm>
        ) : null}
      </div>
      <h3 className="mt-6 text-[0.95rem] font-semibold text-forest-900">Last messages</h3>
      {history.length ? (
        <ul className="mt-2 grid gap-3">
          {history.map((m) => (
            <li key={m.id} className="border-t border-forest-900/10 pt-3 text-[0.9rem]">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold text-forest-900">{(KIND_LABELS as Record<string, string>)[m.kind] ?? m.kind}</span>
                <SmsStatusBadge status={m.status} provider={m.provider} attempts={m.attempts} />
              </p>
              <p className="mt-0.5 text-[0.85rem] text-muted">
                <time dateTime={m.createdAt.toISOString()}>{formatDateTime(m.createdAt)}</time> · <MaskedMobile mobile={m.toMobile} />
              </p>
              {m.body ? <p className="mt-1 break-words text-forest-900/90">{m.body}</p> : null}
              {m.error && m.status !== "sent" ? <p className="mt-1 text-[0.85rem] text-forest-900/80">{m.error}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[0.92rem] text-muted">No text messages yet.</p>
      )}
      <p className="mt-4 text-[0.88rem]">
        <Link href={`/office/sms?q=${encodeURIComponent(srNo)}`} className="font-semibold text-forest-800 underline underline-offset-2">
          All text messages
        </Link>
      </p>
    </Card>
  );
}
