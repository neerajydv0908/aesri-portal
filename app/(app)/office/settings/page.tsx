import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/forms";
import { Card, CardTitle, PageHeader } from "@/components/ui";
import { InfoList } from "@/components/access/info-list";
import { SubmitButton } from "@/components/ui/client";
import { TextField } from "@/components/access/fields";
import { formatDateTime, todayIST } from "@/lib/dates";
import { officePage } from "@/lib/page";
import { lastEntry } from "@/lib/queries/log";
import { getSchool, listSubjects } from "@/lib/queries/school";
import { last30DaysByKind, smsSetup } from "@/lib/queries/sms";
import { resolveSmsSettings } from "@/lib/sms/settings";
import { readModelCard, studAiConfigProblem, studAiDir } from "@/lib/studai/config";
import { subjectCoverage } from "@/lib/studai/coverage";
import { studAiStatusRecord } from "@/lib/studai/estimates";
import { resolveSupportRule } from "@/lib/support/rules";
import { saveSettingsAction } from "./actions";
import { SmsSettingsCard } from "./sms-form";
import { SupportSettingsCard, type StudAiSetup } from "./support-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await officePage();
  const [school, last, smsCounts, studAiRecord, schoolSubjects] = await Promise.all([
    getSchool(ctx.schoolId),
    lastEntry(ctx.schoolId, "settings.updated"),
    last30DaysByKind(ctx.schoolId, todayIST()),
    studAiStatusRecord(),
    listSubjects(ctx.schoolId),
  ]);
  if (!school) notFound();
  const dir = studAiDir();
  const problem = studAiConfigProblem();
  const setup: StudAiSetup = !dir ? { state: "off" } : problem ? { state: "problem", message: problem } : { state: "ready", card: readModelCard(dir) };
  // Which of this school's subjects Stud-AI covers, and names that look like one it does.
  const coverage = setup.state === "ready" && setup.card?.subjects.length ? subjectCoverage(schoolSubjects.map((s) => s.name), setup.card.subjects) : null;
  return (
    <>
      <PageHeader eyebrow="School office" title="Settings" description={`How ${school.name} works in the portal. Changes apply straight away and are kept in the activity log.`} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardTitle>Results, attendance and contact</CardTitle>
          <ActionForm action={saveSettingsAction} aria-label="School settings" className="gap-5">
            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="sr-only">Results and attendance</legend>
              <TextField
                name="passPercent"
                label="Pass mark (%)"
                required
                inputMode="numeric"
                autoComplete="off"
                defaultValue={String(school.settings.passPercent)}
                hint="A subject mark below this shows as “below pass mark” on results and report cards."
                inputClassName="max-w-32"
              />
              <TextField
                name="attendanceWarnPercent"
                label="Attendance warning (%)"
                required
                inputMode="numeric"
                autoComplete="off"
                defaultValue={String(school.settings.attendanceWarnPercent)}
                hint="Students whose attendance is below this are highlighted for teachers and the office."
                inputClassName="max-w-32"
              />
            </fieldset>
            <fieldset className="grid gap-4">
              <legend className="mb-1 text-[0.95rem] font-semibold text-forest-900">Shown to families</legend>
              <TextField
                name="phone"
                label="Office phone"
                type="tel"
                autoComplete="off"
                defaultValue={school.phone ?? ""}
                hint="On families’ pages and on the “Forgot your password?” page. Leave empty to show no number."
              />
              <TextField
                name="email"
                label="Office email"
                type="email"
                autoComplete="off"
                spellCheck={false}
                defaultValue={school.email ?? ""}
                hint="Shown next to the phone number. Leave empty to show no email."
              />
            </fieldset>
            <div>
              <SubmitButton pendingLabel="Saving…">Save settings</SubmitButton>
            </div>
          </ActionForm>
        </Card>
        <Card>
          <CardTitle>About this school</CardTitle>
          <InfoList
            items={[
              {
                label: "Name",
                value: (
                  <>
                    {school.name}
                    <span lang="hi" className="block text-forest-900/80">
                      {school.nameHi}
                    </span>
                  </>
                ),
              },
              { label: "Place", value: school.place },
              { label: "Login IDs", value: <span className="tabular">{`${school.loginPrefix} + SR no. for families (${school.loginPrefix}7634), ${school.loginPrefix}E + employee no. for staff`}</span> },
              { label: "Receipt numbers start with", value: <span className="tabular">{school.code}</span> },
              { label: "Last changed", value: last ? `${formatDateTime(last.at)}${last.who ? ` by ${last.who}` : ""}` : "Not changed in the portal yet" },
            ]}
          />
          <p className="mt-5 text-[0.9rem] text-muted">The school’s name, login IDs and receipt numbers are fixed. To change them, contact the AESRI administrator.</p>
        </Card>
      </div>
      <div className="mt-6">
        <SmsSettingsCard settings={resolveSmsSettings(school.settings.sms)} counts={smsCounts.byKind} setup={smsSetup()} />
      </div>
      <div className="mt-6">
        <SupportSettingsCard rule={resolveSupportRule(school.settings.support)} setup={setup} record={studAiRecord} coverage={coverage} />
      </div>
    </>
  );
}
