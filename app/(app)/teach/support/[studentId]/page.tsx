import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { Card, CardTitle, PageHeader, Table, Td, Th } from "@/components/ui";
import { EstimatePercent, SupportBadge, SupportIcon } from "@/components/support/badge";
import { EstimatesNotice } from "@/components/support/estimates-status";
import { teacherPage } from "@/lib/page";
import { formatDateTime } from "@/lib/dates";
import { REMARK_AREA_WORDS, attendancePercent, homeworkChecked, latestSubjectResults, pct } from "@/lib/support/figures";
import { STUD_AI_RED_PERCENT, SUPPORT_INFO, usablePassPercent } from "@/lib/support/rules";
import type { SubjectInput } from "@/lib/studai/contract";
import { supportStudent } from "../student";

export const metadata: Metadata = { title: "Needs support" };

/** What Stud-AI was given for a subject, in words. */
function inputWords(i: SubjectInput | undefined): string {
  if (!i) return "";
  const tests = i.tests.length ? `tests ${i.tests.slice(-5).map((t) => pct(t)).join(", ")}` : "no tests yet";
  const hw = i.homework === null ? "homework not checked enough yet" : `homework done ${pct(i.homework)}`;
  const att = i.attendance === null ? "attendance not counted yet" : `attendance ${pct(i.attendance)}`;
  return `${tests} · ${hw} · ${att}`;
}

/** One student in "Needs support": the colour, every reason, Stud-AI's estimate in each subject with its reasons, and the records behind them. Teachers only. */
export default async function SupportStudentPage({ params }: { params: Promise<{ studentId: string }> }) {
  const ctx = await teacherPage();
  const { studentId } = await params;
  const { section, student, figures: f, estimates, estimatesStatus, status, thresholds, rule } = await supportStudent(ctx, studentId);
  const att = attendancePercent(f.attendance, SUPPORT_INFO.minAttendanceDays);
  // Each subject's most recent exam result: the same results the colour rule looks at.
  const recent = latestSubjectResults(f.exams).sort((a, b) => a.subject.name.localeCompare(b.subject.name));
  const pass = usablePassPercent(thresholds.passPercent);
  const checks = homeworkChecked(f.homework);
  const inputs = new Map(estimates.inputs.map((i) => [i.key, i]));
  // "Not covered" names that look like a covered subject: the rule counts them as unsure.
  const misnamed = new Map(status.misnamed.map((m) => [m.subjectId, m.like.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase())]));
  const bySubject = [...estimates.subjects].sort((a, b) => a.subjectName.localeCompare(b.subjectName));
  const computed = estimates.subjects.reduce<Date | null>((d, s) => (!d || s.computedAt > d ? s.computedAt : d), null);

  return (
    <>
      <Link
        href={`/teach/support?section=${section.id}`}
        className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-full pr-3 text-[0.92rem] font-semibold text-forest-800 hover:text-forest-600"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Needs support · {section.label}
      </Link>
      <PageHeader eyebrow={`Needs support · ${section.longLabel}`} title={student.name} description={<SupportBadge colour={status.colour} className="text-[0.9rem]" />} className="pb-6" />
      <EstimatesNotice status={estimatesStatus} className="mb-6" />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Why this colour</CardTitle>
          {status.reasons.length || status.review.length ? (
            <ul className="grid gap-1.5">
              {status.reasons.map((r) => (
                <li key={`r:${r}`} className="flex items-start gap-2 text-forest-900">
                  <SupportIcon colour="red" className="mt-1 h-4 w-4 shrink-0 text-clay-600" />
                  <span>
                    <span className="sr-only">Needs support: </span>
                    {r}
                  </span>
                </li>
              ))}
              {status.review.map((r) => (
                <li key={`v:${r}`} className="flex items-start gap-2 text-forest-900">
                  <SupportIcon colour="amber" className="mt-1 h-4 w-4 shrink-0 text-ochre-600" />
                  <span>
                    <span className="sr-only">Review needed: </span>
                    {r}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-forest-900">
              {status.colour === "grey"
                ? status.greyWhy
                : `Nothing in the rule applies, and Stud-AI’s estimate is below ${STUD_AI_RED_PERCENT}% in every subject it was trained on: on track.`}
            </p>
          )}
          {status.notes.length ? (
            <>
              <h3 className="mt-5 font-sans text-[1rem] font-bold text-forest-900">Worth knowing</h3>
              <ul className="mt-1 grid list-disc gap-1 pl-5 text-forest-900">
                {status.notes.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          ) : null}
          {status.strengths.length ? (
            <>
              <h3 className="mt-5 font-sans text-[1rem] font-bold text-forest-900">Going well</h3>
              <ul className="mt-1 grid list-disc gap-1 pl-5 text-forest-900">
                {status.strengths.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          ) : null}
          {status.trends.length ? (
            <>
              <h3 className="mt-5 font-sans text-[1rem] font-bold text-forest-900">Changes</h3>
              <ul className="mt-1 grid list-disc gap-1 pl-5 text-forest-900">
                {status.trends.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="mt-5 text-[0.85rem] text-muted">
            Red when Stud-AI&rsquo;s estimate is {STUD_AI_RED_PERCENT}% or more in a subject, or attendance is below {rule.attendanceRedPercent}% with {rule.concernsRed} or
            more concerns in the last {rule.concernDays} days. Review needed when a subject&rsquo;s most recent exam mark is below the pass mark (
            {usablePassPercent(thresholds.passPercent)}%) or the student was absent from it — the school&rsquo;s rule, explained on{" "}
            <Link href={`/teach/support?section=${section.id}#how-colours`} className="font-semibold text-forest-800 underline underline-offset-2">
              Needs support
            </Link>
            . For teachers only.
          </p>
        </Card>

        <Card>
          <CardTitle>The records this session</CardTitle>
          <dl className="grid gap-3 text-forest-900 sm:grid-cols-2">
            <div>
              <dt className="eyebrow">Attendance</dt>
              <dd className="mt-1">
                {att !== null ? `${pct(att)} (${f.attendance.present + f.attendance.late} of ${f.attendance.days} days)` : `Not enough days yet (${f.attendance.days} recorded)`}
              </dd>
            </div>
            <div>
              <dt className="eyebrow">Homework done</dt>
              <dd className="mt-1">{checks ? `${f.homework.done + f.homework.late} of ${checks} checked${f.homework.excused ? `, ${f.homework.excused} excused` : ""}` : "None checked yet"}</dd>
            </div>
            <div>
              <dt className="eyebrow">Concerns, last {rule.concernDays} days</dt>
              <dd className="mt-1">{f.remarks.concernsRecent}</dd>
            </div>
            <div>
              <dt className="eyebrow">Remarks this session</dt>
              <dd className="mt-1">
                {f.remarks.appreciations} {f.remarks.appreciations === 1 ? "appreciation" : "appreciations"}
                {f.remarks.appreciationAreas.length ? ` (${f.remarks.appreciationAreas.map((a) => REMARK_AREA_WORDS[a]).join(", ")})` : ""}, {f.remarks.concerns}{" "}
                {f.remarks.concerns === 1 ? "concern" : "concerns"}
                {f.remarks.concernAreas.length ? ` (${f.remarks.concernAreas.map((a) => REMARK_AREA_WORDS[a]).join(", ")})` : ""}
              </dd>
            </div>
          </dl>
          {recent.length ? (
            <div className="mt-5">
              <Table caption={`${student.name}: the most recent exam result in each subject`} className="[&_table]:min-w-0">
                <thead>
                  <tr>
                    <Th>Subject</Th>
                    <Th>Most recent exam</Th>
                    <Th className="text-right">%</Th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map(({ exam, subject: s }) => (
                    <tr key={s.subjectId}>
                      <Td>{s.name}</Td>
                      <Td>{exam.name}</Td>
                      <Td className="tabular text-right">
                        {s.absent ? (
                          <span className="font-semibold text-clay-600">Absent</span>
                        ) : s.percent === null ? (
                          "—"
                        ) : s.belowPass === true || s.percent / 10 < pass ? (
                          <span className="font-semibold text-clay-600">{s.percent / 10 < pass ? pct(s.percent / 10) : `just under ${pass}%`} (below pass mark)</span>
                        ) : (
                          pct(s.percent / 10)
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <p className="mt-5 text-muted">No exam marks yet this session.</p>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <CardTitle>Stud-AI&rsquo;s estimates</CardTitle>
        {bySubject.length ? (
          <>
            <p className="mb-4 text-[0.92rem] text-muted">
              Each estimate is the risk of not passing the next exam in that subject, from this session&rsquo;s test marks, homework and attendance, with the main reasons.
              Subjects Stud-AI wasn&rsquo;t trained on show &ldquo;Not enough data as of now&rdquo;, so check their marks yourself.
              {computed ? ` Worked out ${formatDateTime(computed)}${estimates.outdated ? ", before the latest records (out of date)" : ""}.` : ""}
            </p>
            <ul className="grid gap-4">
              {bySubject.map((e) => (
                <li key={e.subjectId} className="rounded-2xl bg-sage-50 p-4 ring-1 ring-forest-700/10">
                  <p className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold text-forest-900">{e.subjectName}</span>
                    <EstimatePercent percent={e.percent} knownSubject={e.knownSubject} unsure={misnamed.has(e.subjectId)} className="text-[1.05rem]" />
                  </p>
                  {misnamed.has(e.subjectId) ? (
                    <p className="mt-2 text-[0.9rem] text-muted">
                      {misnamed.get(e.subjectId)
                        ? `Stud-AI doesn’t recognise the name “${e.subjectName}”, but it looks like ${misnamed.get(e.subjectId)}, which Stud-AI covers. Please look at the marks yourself. If it is the same subject, the office can rename it in Classes & subjects so Stud-AI covers it.`
                        : "Stud-AI’s list of the subjects it covers couldn’t be read, so this result can’t be relied on. Please look at the marks yourself."}
                    </p>
                  ) : !e.knownSubject ? (
                    <p className="mt-2 text-[0.9rem] text-muted">
                      Stud-AI hasn&rsquo;t been trained on this subject yet, so it gives no estimate. Check the marks yourself: a most recent mark below the pass mark, or an
                      absence, still shows as &ldquo;Review needed&rdquo;.
                    </p>
                  ) : typeof e.percent === "number" ? (
                    <>
                      <p className="mt-2 text-forest-900">{e.text}</p>
                      {e.reasons.length ? (
                        <ul className="mt-2 grid list-disc gap-1 pl-5 text-[0.9rem] text-forest-900">
                          {e.reasons.map((r) => (
                            <li key={r.key}>{r.sentence}</li>
                          ))}
                        </ul>
                      ) : null}
                      {e.assumed.length ? (
                        <p className="mt-2 text-[0.82rem] text-muted">Not recorded yet, so a typical value was used: {e.assumed.join(", ")}.</p>
                      ) : null}
                    </>
                  ) : (
                    <p className="mt-2 text-[0.9rem] text-muted">Stud-AI&rsquo;s result for this subject couldn&rsquo;t be read. Please look at the student&rsquo;s marks, homework and attendance.</p>
                  )}
                  <p className="mt-2 text-[0.82rem] text-muted">Given: {inputWords(inputs.get(e.subjectId))}.</p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-forest-900">
            {estimatesStatus.state === "off" || estimatesStatus.state === "problem"
              ? "No estimates: Stud-AI isn’t available on this server."
              : estimates.outdated
                ? "No estimate yet: Stud-AI couldn’t run just now."
                : estimates.inputs.some((i) => i.tests.length > 0)
                  ? "No estimate yet for the subjects with marks."
                  : "No estimate yet: there are no marks this session."}
          </p>
        )}
        <p className="mt-5 flex items-start gap-2 text-[0.85rem] text-forest-900/85">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-forest-700" aria-hidden />
          A prompt to help early, not a judgement of the child, and it can be wrong. Never shown to families or students, never used for marks, promotion or admission. Stud-AI
          runs on the school&rsquo;s own server and is given only numbers — never names.
        </p>
      </Card>
    </>
  );
}
