/** Settings → "Needs support" colours: the school's red rule, and whether Stud-AI's estimates work on this server. */
import { ActionForm } from "@/components/forms";
import { Alert, Card, CardTitle } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { TextField } from "@/components/access/fields";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { ModelCard } from "@/lib/studai/config";
import type { StudAiStatusRecord } from "@/lib/studai/estimates";
import { STUD_AI_RED_PERCENT, type SupportRule } from "@/lib/support/rules";
import { checkStudAiAction, saveSupportRuleAction } from "./actions";

export type StudAiSetup = { state: "off" } | { state: "problem"; message: string } | { state: "ready"; card: ModelCard | null };

const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n * 1000) / 10}%`);

function subjectList(names: string[]): string {
  const words = names.map((s) => (["english", "hindi", "sanskrit", "urdu"].includes(s) ? s[0].toUpperCase() + s.slice(1) : s));
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : (words[0] ?? "—");
}

/** "english" → "English", "social studies" → "Social Studies". */
const titleCase = (s: string) => s.replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());

export type SubjectCoverage = { covered: string[]; notCovered: { name: string; like: string | null }[]; sameSubject: { key: string; names: string[] }[] };

export function SupportSettingsCard({ rule, setup, record, coverage }: { rule: SupportRule; setup: StudAiSetup; record: StudAiStatusRecord; coverage?: SubjectCoverage | null }) {
  const failedLast = record.lastErrorAt && (!record.lastOkAt || record.lastErrorAt > record.lastOkAt);
  return (
    <Card>
      <div id="support" className="scroll-mt-24" />
      <CardTitle>“Needs support” colours (teachers only)</CardTitle>
      <p className="mb-4 max-w-[70ch] text-[0.95rem] text-forest-900">
        Class teachers see their students in red, amber, grey or green. A student is <strong>red</strong> when either of these is true. Families and students never see the
        colours or the estimates.
      </p>
      <ActionForm action={saveSupportRuleAction} aria-label="Needs support colour rule" className="gap-5">
        <fieldset className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <legend className="sr-only">When a student is red</legend>
          <div className="rounded-2xl bg-sage-50 p-4 ring-1 ring-forest-700/10">
            <p className="mb-3 text-[0.92rem] font-semibold text-forest-900">1. Stud-AI&rsquo;s estimate</p>
            <p>
              Red when Stud-AI&rsquo;s estimated risk of not passing the next exam is {STUD_AI_RED_PERCENT}% or more in a subject. Subjects it wasn&rsquo;t trained on show
              &ldquo;Not enough data as of now&rdquo;.
            </p>
          </div>
          <div className="rounded-2xl bg-sage-50 p-4 ring-1 ring-forest-700/10">
            <p className="mb-3 text-[0.92rem] font-semibold text-forest-900">2. Attendance together with concerns</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField name="attendanceRedPercent" label="Attendance below (%)" required inputMode="numeric" autoComplete="off" defaultValue={String(rule.attendanceRedPercent)} inputClassName="max-w-28" />
              <TextField name="concernsRed" label="and at least this many concerns" required inputMode="numeric" autoComplete="off" defaultValue={String(rule.concernsRed)} inputClassName="max-w-28" />
              <TextField name="concernDays" label="in the last (days)" required inputMode="numeric" autoComplete="off" defaultValue={String(rule.concernDays)} inputClassName="max-w-28" />
            </div>
            <p className="mt-2 text-[0.85rem] text-muted">Attendance counts once 10 register days are recorded this session.</p>
          </div>
        </fieldset>
        <p className="text-[0.9rem] text-muted">
          Otherwise a student is <strong className="font-semibold text-forest-900">amber</strong> (&ldquo;Review needed&rdquo;) when a subject&rsquo;s most recent exam mark
          is below the pass mark or the student was absent from it, in any subject, or Stud-AI doesn&rsquo;t recognise a subject name that looks like one it covers;{" "}
          <strong className="font-semibold text-forest-900">grey</strong> while there is no
          current Stud-AI result for every subject; and <strong className="font-semibold text-forest-900">green</strong> when Stud-AI&rsquo;s estimate is below{" "}
          {STUD_AI_RED_PERCENT}% in every subject it was trained on.
        </p>
        <div>
          <SubmitButton pendingLabel="Saving…">Save colour rule</SubmitButton>
        </div>
      </ActionForm>

      <h3 className="mt-7 font-sans text-[1.05rem] font-bold text-forest-900">Stud-AI on this server</h3>
      {setup.state === "off" ? (
        <Alert tone="amber" className="mt-2" title="Not set up">
          Stud-AI isn&rsquo;t set up on this server (STUD_AI_DIR), so there are no estimates: students are red only for attendance with concerns, &ldquo;Review
          needed&rdquo; for a most recent mark below the pass mark or an absence, and grey otherwise. The AESRI administrator sets it up (docs/STUD-AI.md).
        </Alert>
      ) : setup.state === "problem" ? (
        <Alert tone="red" className="mt-2" title="Set up, but not working">
          {setup.message}
        </Alert>
      ) : (
        <div className="mt-2 grid gap-2 text-[0.93rem] text-forest-900">
          {setup.card ? (
            <p>
              Model {setup.card.version ?? ""} trained {setup.card.created ? formatDate(setup.card.created) : ""} on {subjectList(setup.card.subjects)}.
              {setup.card.test ? (
                <>
                  {" "}
                  On {setup.card.test.students ?? "the"} test students it had never seen: right {pct(setup.card.test.accuracy)} of the time at 50%, and caught{" "}
                  {pct(setup.card.test.recall)} of the results that were not a pass.
                </>
              ) : null}
            </p>
          ) : (
            <p>Ready (the model card is missing, so its details can&rsquo;t be shown).</p>
          )}
          <p className="text-muted">
            {record.lastOkAt
              ? `Estimates last worked out ${formatDateTime(new Date(record.lastOkAt))}${record.lastStudents ? ` for ${record.lastStudents} ${record.lastStudents === 1 ? "student" : "students"}` : ""}${record.lastRunMs ? ` in ${(record.lastRunMs / 1000).toFixed(1)} s` : ""}.`
              : "No estimates worked out yet: they are, the first time a teacher opens “Needs support”."}{" "}
            They are worked out again when a student&rsquo;s marks, homework or attendance change.
          </p>
          {failedLast ? (
            <Alert tone="amber" title={`Last problem, ${formatDateTime(new Date(record.lastErrorAt!))}`}>
              {record.lastError}
            </Alert>
          ) : null}
          {coverage ? (
            <div className="grid gap-1.5">
              <p>
                <span className="font-semibold">Covers this school&rsquo;s subjects:</span> {coverage.covered.length ? coverage.covered.join(", ") : "none yet"}.
              </p>
              {coverage.notCovered.length ? (
                <p>
                  <span className="font-semibold">Doesn&rsquo;t cover:</span> {coverage.notCovered.map((c) => c.name).join(", ")}. Teachers see &ldquo;Not enough data as of
                  now&rdquo; for these; their marks still count, so a mark below the pass mark or an absence means &ldquo;Review needed&rdquo;.
                </p>
              ) : null}
              {coverage.notCovered
                .filter((c) => c.like)
                .map((c) => (
                  <Alert key={c.name} tone="amber" title={`“${c.name}” looks like ${titleCase(c.like!)}`}>
                    Stud-AI covers {titleCase(c.like!)}, but not a subject named &ldquo;{c.name}&rdquo;, so teachers see &ldquo;Review needed&rdquo; for it. If it is the same
                    subject, rename it to &ldquo;{titleCase(c.like!)}&rdquo; in Classes &amp; subjects so Stud-AI covers it.
                  </Alert>
                ))}
              {coverage.sameSubject.map((d) => (
                <Alert key={d.key} tone="amber" title={`${d.names.map((n) => `“${n}”`).join(" and ")} are the same subject to Stud-AI`}>
                  Stud-AI reads them all as {titleCase(d.key)}. In a class that has more than one of them, it can answer for only one, so its students can&rsquo;t show as on
                  track. Keep one name per subject in Classes &amp; subjects.
                </Alert>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {setup.state !== "off" ? (
        <ActionForm action={checkStudAiAction} aria-label="Check Stud-AI" className="mt-4">
          <div>
            <SubmitButton variant="secondary" pendingLabel="Checking…">
              Check Stud-AI now
            </SubmitButton>
          </div>
        </ActionForm>
      ) : null}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div>
          <p className="text-[0.92rem] font-semibold text-forest-900">What Stud-AI is given</p>
          <ul className="mt-1 grid list-disc gap-1 pl-5 text-[0.9rem] text-forest-900/90">
            <li>Each subject&rsquo;s test marks this session, as percentages.</li>
            <li>Homework done per subject, and whole-day attendance, as percentages.</li>
            <li>The portal&rsquo;s own ID for the student and subject, so the answer can be matched up.</li>
          </ul>
        </div>
        <div>
          <p className="text-[0.92rem] font-semibold text-forest-900">What it never gets</p>
          <ul className="mt-1 grid list-disc gap-1 pl-5 text-[0.9rem] text-forest-900/90">
            <li>Names, SR numbers, gender, age, parents&rsquo; details, fees or RTE seats.</li>
            <li>What teachers wrote in remarks; anything about health, caste or religion.</li>
            <li>Nothing leaves this server: Stud-AI runs here, not at an AI company.</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}
