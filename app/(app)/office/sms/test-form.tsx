/** "Send a test message": to a number an administrator types, in Hindi or English, sent at once. */
import { ActionForm } from "@/components/forms";
import { TextField } from "@/components/access/fields";
import { Card, CardTitle } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import type { SmsLang } from "@/lib/sms/templates";
import { sendTestSmsAction } from "./actions";

/** `schoolId`: the school whose template is tested (AESRI page); the office page tests its own school. */
export function TestSmsCard({ defaultLang, schoolId, schoolName }: { defaultLang: SmsLang; schoolId?: string; schoolName?: string }) {
  return (
    <Card>
      <CardTitle>Send a test message</CardTitle>
      <p className="mb-4 text-[0.95rem] text-muted">
        Checks the set-up end to end: it goes out at once (even in the quiet time) with the test wording{schoolName ? ` and ${schoolName}’s name` : ""}, and is kept in the list of
        messages. At most 5 in ten minutes.
      </p>
      <ActionForm action={sendTestSmsAction} aria-label="Send a test message" className="gap-4">
        {schoolId ? <input type="hidden" name="school" value={schoolId} /> : null}
        <TextField name="mobile" label="Mobile number" type="tel" inputMode="numeric" autoComplete="off" required hint="10 digits, for example 98765 43210." inputClassName="max-w-56 tabular" />
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[0.92rem] font-semibold text-forest-900">Language</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[0.95rem] text-forest-900">
              <input type="radio" name="lang" value="hi" defaultChecked={defaultLang === "hi"} className="h-5 w-5 accent-forest-700" />
              <span>
                Hindi (<span lang="hi">हिंदी</span>)
              </span>
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[0.95rem] text-forest-900">
              <input type="radio" name="lang" value="en" defaultChecked={defaultLang === "en"} className="h-5 w-5 accent-forest-700" />
              <span>English</span>
            </label>
          </div>
        </fieldset>
        <div>
          <SubmitButton pendingLabel="Sending…">Send test message</SubmitButton>
        </div>
      </ActionForm>
    </Card>
  );
}
