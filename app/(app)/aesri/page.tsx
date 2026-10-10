import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ArrowRight, CalendarCheck2, HandHelping, KeyRound, Megaphone, Users, Wallet, BookOpenCheck } from "lucide-react";
import { SchoolCrest } from "@/components/brand/emblems";
import { Badge, Money, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { getDb } from "@/lib/db/client";
import { schools } from "@/lib/db/schema";
import { currentSessionId, officeSchoolId, requireActor } from "@/lib/auth/dal";
import { formatDate, todayIST, weekdayOf } from "@/lib/dates";
import { headcounts, signInFigures } from "@/lib/queries/access";
import { registersStatus } from "@/lib/services/attendance";
import { marksEntryProgress } from "@/lib/services/exams";
import { schoolFeeTotals } from "@/lib/services/fees";
import { noticeStatusCounts } from "@/lib/services/notices";
import { studAiConfigProblem, studAiDir } from "@/lib/studai/config";
import { estimateCounts } from "@/lib/studai/estimates";
import { STUD_AI_RED_PERCENT } from "@/lib/support/rules";
import { workInSchoolAction } from "./actions";

export const metadata: Metadata = { title: "Both schools" };

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export default async function BothSchoolsPage() {
  const actor = await requireActor(["super_admin"]);
  const current = await officeSchoolId(actor);
  const sessionId = await currentSessionId();
  const today = todayIST();
  const db = await getDb();
  const list = await db.select().from(schools).orderBy(schools.id);
  const cards = await Promise.all(
    list.map(async (s) => {
      const [head, signIn, registers, fees, marks, notices, estimates] = await Promise.all([
        headcounts(s.id),
        signInFigures(s.id),
        registersStatus(s.id, today, sessionId),
        schoolFeeTotals(s.id, sessionId),
        marksEntryProgress(s.id, sessionId),
        noticeStatusCounts(s.id),
        studAiDir() ? estimateCounts(s.id, sessionId) : Promise.resolve(null),
      ]);
      return { school: s, head, signIn, registers, fees, marks, notices, estimates };
    }),
  );

  return (
    <>
      <PageHeader
        eyebrow={`AESRI · Session ${sessionId}`}
        title="Both schools"
        description={`How each school is doing today, ${formatDate(today, "en", { weekday: true, long: true })}. To see the details or make changes, choose “Work in this school”.`}
      />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        {cards.map(({ school: s, head, signIn, registers, fees, marks, notices, estimates }) => {
          const withStudents = registers.filter((r) => r.studentCount > 0);
          const taken = withStudents.filter((r) => r.taken).length;
          const byExam = new Map<string, { name: string; entered: number; expected: number; sections: number; published: number }>();
          for (const m of marks) {
            const e = byExam.get(m.examId) ?? { name: m.examName, entered: 0, expected: 0, sections: 0, published: 0 };
            e.entered += m.entered;
            e.expected += m.expected;
            e.sections++;
            if (m.status === "published") e.published++;
            byExam.set(m.examId, e);
          }
          const sunday = weekdayOf(today) === 0;
          return (
            <section key={s.id} aria-labelledby={`school-${s.id}`} className="card p-6 sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <SchoolCrest school={s.id} className="h-11 w-11 shrink-0 text-forest-700" />
                  <div className="min-w-0">
                    <h2 id={`school-${s.id}`} className="font-display text-[1.45rem] leading-tight text-forest-900">
                      {s.name}
                    </h2>
                    <p className="text-[0.9rem] text-muted">
                      <span lang="hi">{s.nameHi}</span> · {s.place}
                    </p>
                  </div>
                </div>
                {s.id === current ? <Badge tone="green">You’re working in this school</Badge> : null}
              </div>

              <dl className="mt-6 grid gap-x-6 gap-y-5 sm:grid-cols-2">
                <Figure icon={<Users className="h-4 w-4" aria-hidden />} label="People">
                  {head.students} current students
                  <Sub>{head.staff} staff</Sub>
                </Figure>
                <Figure icon={<KeyRound className="h-4 w-4" aria-hidden />} label="Sign-ins activated">
                  Families: {signIn.families.active} of {signIn.families.total} ({pct(signIn.families.active, signIn.families.total)}%)
                  <Sub>
                    Staff: {signIn.staff.active} of {signIn.staff.total} ({pct(signIn.staff.active, signIn.staff.total)}%)
                  </Sub>
                </Figure>
                <Figure icon={<CalendarCheck2 className="h-4 w-4" aria-hidden />} label="Attendance today">
                  {withStudents.length ? `${taken} of ${withStudents.length} registers taken` : "No classes with students yet"}
                  {sunday ? <Sub>Sunday: usually a holiday</Sub> : withStudents.length && taken < withStudents.length ? <Sub>{withStudents.length - taken} still to take</Sub> : null}
                </Figure>
                <Figure icon={<Wallet className="h-4 w-4" aria-hidden />} label={`Fees ${sessionId}`}>
                  <Money paise={fees.collected} /> collected
                  <Sub>
                    <Money paise={fees.outstanding} /> outstanding, of which <Money paise={fees.overdue} className={fees.overdue ? "font-semibold text-clay-600" : undefined} /> overdue
                  </Sub>
                </Figure>
                <Figure icon={<BookOpenCheck className="h-4 w-4" aria-hidden />} label="Marks entry">
                  {byExam.size ? (
                    <ul className="grid gap-2">
                      {[...byExam.values()].map((e) => (
                        <li key={e.name}>
                          {e.name}: {e.expected ? `${pct(e.entered, e.expected)}% entered` : "no papers yet"}
                          <Sub>
                            Results published in {e.published} of {e.sections} {e.sections === 1 ? "section" : "sections"}
                          </Sub>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "No exams with papers yet"
                  )}
                </Figure>
                <Figure icon={<HandHelping className="h-4 w-4" aria-hidden />} label="Stud-AI estimates">
                  {!studAiDir() ? (
                    "Not set up on this server"
                  ) : studAiConfigProblem() ? (
                    <span className="font-semibold text-clay-600">Set up, but not working (see Settings)</span>
                  ) : estimates?.students ? (
                    <>
                      {estimates.red} of {estimates.students} {estimates.students === 1 ? "student" : "students"} with an estimate of {STUD_AI_RED_PERCENT}% or more in a subject
                      <Sub>Teachers only. Updated as teachers open “Needs support”{estimates.lastAt ? `, last ${formatDate(todayIST(estimates.lastAt))}` : ""}.</Sub>
                    </>
                  ) : (
                    <>
                      Ready
                      <Sub>No estimates yet this session</Sub>
                    </>
                  )}
                </Figure>
                <Figure icon={<Megaphone className="h-4 w-4" aria-hidden />} label="Notices">
                  {notices.pending ? `${notices.pending} waiting for approval` : "None waiting for approval"}
                  <Sub>
                    {notices.draft ? `${notices.draft} ${notices.draft === 1 ? "draft" : "drafts"} not published yet · ` : ""}
                    {notices.published} published
                  </Sub>
                </Figure>
              </dl>

              <form action={workInSchoolAction} className="mt-6 border-t border-forest-900/10 pt-5">
                <input type="hidden" name="school" value={s.id} />
                <SubmitButton variant={s.id === current ? "secondary" : "primary"} pendingLabel="Opening…">
                  Work in this school
                  <ArrowRight className="h-4 w-4" aria-hidden />
                  <span className="sr-only">: {s.name}</span>
                </SubmitButton>
              </form>
            </section>
          );
        })}
      </div>
    </>
  );
}

function Figure({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-[0.72rem] font-bold uppercase tracking-[0.12em] text-muted">
        <span className="text-forest-700">{icon}</span>
        {label}
      </dt>
      <dd className="mt-1.5 text-[1rem] text-forest-900">{children}</dd>
    </div>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 block text-[0.9rem] text-muted">{children}</span>;
}
