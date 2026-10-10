/** Settings → Text messages (SMS): the school's switches, language, second mobile, homework time and quiet time. */
import Link from "next/link";
import { ActionForm, FieldError } from "@/components/forms";
import { Alert, Card, CardTitle, Checkbox, Input } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import type { SmsSetup, StatusCounts } from "@/lib/queries/sms";
import { SMS_EVENTS, type ResolvedSmsSettings } from "@/lib/sms/settings";
import { saveSmsSettingsAction } from "./actions";

function lastMonth(c: StatusCounts | undefined): string {
  if (!c) return "None in the last 30 days.";
  const parts = [
    c.sent ? `${c.sent} sent` : "",
    c.queued ? `${c.queued} waiting` : "",
    c.failed ? `${c.failed} failed` : "",
    c.skipped ? `${c.skipped} not sent` : "",
    c.cancelled ? `${c.cancelled} cancelled` : "",
  ].filter(Boolean);
  return parts.length ? `Last 30 days: ${parts.join(", ")}.` : "None in the last 30 days.";
}

function TimeField({ name, label, value, hint }: { name: string; label: string; value: string; hint?: string }) {
  const id = `f-${name}`;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[0.92rem] font-semibold text-forest-900">
        {label}
      </label>
      <Input
        id={id}
        name={name}
        type="time"
        defaultValue={value}
        className="max-w-40"
        aria-describedby={[hint ? `${id}-hint` : "", `${name}-error`].filter(Boolean).join(" ")}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-[0.85rem] text-muted">
          {hint}
        </p>
      ) : null}
      <FieldError name={name} />
    </div>
  );
}

export function SmsSettingsCard({ settings, counts, setup }: { settings: ResolvedSmsSettings; counts: Map<string, StatusCounts>; setup: SmsSetup }) {
  return (
    <Card>
      <CardTitle action={<Link href="/office/sms" className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline underline-offset-4">See the messages</Link>}>
        Text messages (SMS)
      </CardTitle>
      {setup.mode === "test" ? (
        <Alert tone="amber" className="mb-5" title="Test mode">
          This server has no SMS company set up, so messages are written to its log and marked “Sent (test mode)” — nobody’s phone gets them.
        </Alert>
      ) : setup.mode === "off" ? (
        <Alert tone="amber" className="mb-5" title="Text messages aren’t set up yet">
          No SMS company is connected, so messages are recorded as “Not sent”. The AESRI administrator sets this up.
        </Alert>
      ) : null}
      <ActionForm action={saveSmsSettingsAction} aria-label="Text message settings" className="gap-6">
        <Checkbox
          name="smsEnabled"
          defaultChecked={settings.enabled}
          label={
            <>
              <span className="font-semibold">Send text messages to families and staff</span>
              <span className="block text-[0.85rem] text-muted">
                The main switch. Messages are sent to the parent’s mobile on each student’s record, as well as being shown in the portal.
              </span>
            </>
          }
        />

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-[0.95rem] font-semibold text-forest-900">Which events send a message</legend>
          <p className="-mt-1 text-[0.88rem] text-muted">Families only ever get messages about their own child, or notices meant for them.</p>
          <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
            {SMS_EVENTS.map((e) => (
              <Checkbox
                key={e.key}
                name={`ev_${e.key}`}
                defaultChecked={settings.events[e.key]}
                label={
                  <>
                    <span className="font-semibold">{e.label}</span>
                    <span className="block text-[0.85rem] text-muted">{e.hint}</span>
                    <span className="mt-0.5 block text-[0.82rem] text-forest-900/80">{lastMonth(counts.get(e.key))}</span>
                  </>
                }
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[0.95rem] font-semibold text-forest-900">Language of the messages</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[0.95rem] text-forest-900">
              <input type="radio" name="smsLang" value="hi" defaultChecked={settings.lang === "hi"} className="h-5 w-5 accent-forest-700" />
              <span>
                Hindi (<span lang="hi">हिंदी</span>)
              </span>
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[0.95rem] text-forest-900">
              <input type="radio" name="smsLang" value="en" defaultChecked={settings.lang === "en"} className="h-5 w-5 accent-forest-700" />
              <span>English</span>
            </label>
          </div>
          <p className="text-[0.85rem] text-muted">
            For everyone at this school. A Hindi message costs more (it fits fewer letters per SMS). Each language’s wording must be registered by AESRI before it can be sent.
          </p>
          <FieldError name="lang" />
        </fieldset>

        <Checkbox
          name="alsoSecondMobile"
          defaultChecked={settings.alsoSecondMobile}
          label={
            <>
              <span className="font-semibold">Also send to the second mobile</span>
              <span className="block text-[0.85rem] text-muted">When a student’s record has a second mobile number, family messages go to both numbers (each counts as a message).</span>
            </>
          }
        />

        <TimeField
          name="homeworkDigestAt"
          label="Homework summary time"
          value={settings.homeworkDigestAt}
          hint="Each day at this time, families of classes that were set homework that day get one summary with the subjects."
        />

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-[0.95rem] font-semibold text-forest-900">Quiet time</legend>
          <Checkbox
            name="quietOn"
            value="yes"
            defaultChecked={!!settings.quietHours}
            label={
              <>
                <span className="font-semibold">No messages at night</span>
                <span className="block text-[0.85rem] text-muted">Messages that come due in the quiet time wait until it ends.</span>
              </>
            }
          />
          <div className="flex flex-wrap gap-5 pl-9">
            <TimeField name="quietFrom" label="From" value={settings.quietHours?.from ?? "21:00"} />
            <TimeField name="quietTo" label="Until" value={settings.quietHours?.to ?? "07:00"} />
          </div>
        </fieldset>

        <div>
          <SubmitButton pendingLabel="Saving…">Save text message settings</SubmitButton>
        </div>
      </ActionForm>
    </Card>
  );
}
