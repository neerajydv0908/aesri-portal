/** Home for a teacher: what still needs doing today in their own classes. */
import Link from "next/link";
import { BookOpenCheck, CalendarCheck2, CircleCheck, CircleDashed, Megaphone, MessageSquareText, NotebookPen } from "lucide-react";
import { teacherPage } from "@/lib/page";
import { formatDate, todayIST } from "@/lib/dates";
import { teacherScope } from "@/lib/auth/dal";
import { pendingMarksForTeacher, teacherPaperCounts } from "@/lib/services/exams";
import { activeNoticesForStaff } from "@/lib/services/notices";
import { homeworkDueOn, registersTakenOn } from "@/lib/queries/home";
import { Alert, Badge, ButtonLink, Card, CardTitle, PageHeader } from "@/components/ui";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function TeacherHome({ welcome }: { welcome: boolean }) {
  const ctx = await teacherPage();
  const today = todayIST();
  const staffId = ctx.actor.staffId;
  const scope = staffId ? await teacherScope(staffId) : { classTeacherOf: [], teaches: [], sectionIds: [] };
  const own = ctx.classTeacherSections;
  const [taken, marks, papers, homework, notices] = await Promise.all([
    registersTakenOn(
      own.map((s) => s.id),
      today,
    ),
    staffId ? pendingMarksForTeacher(staffId, ctx.sessionId) : Promise.resolve([]),
    staffId ? teacherPaperCounts(staffId, ctx.schoolId, ctx.sessionId) : Promise.resolve({ exams: 0, papers: 0 }),
    homeworkDueOn({ sectionIds: scope.classTeacherOf, pairs: scope.teaches.filter((p) => !scope.classTeacherOf.includes(p.sectionId)) }, today),
    activeNoticesForStaff(ctx.schoolId, today),
  ]);
  const label = new Map(ctx.sections.map((s) => [s.id, s.label]));
  const size = new Map(ctx.sections.map((s) => [s.id, s.studentCount]));
  const withStudents = own.filter((s) => s.studentCount > 0);
  const toTake = withStudents.filter((s) => !taken.has(s.id));
  const hasClasses = ctx.sections.length > 0;

  return (
    <>
      <PageHeader eyebrow={formatDate(today, "en", { weekday: true, long: true })} title={`Hello, ${ctx.actor.name}`} description={`Session ${ctx.sessionId}`} />

      {welcome ? (
        <Alert tone="green" title="Welcome! Your account is ready." className="mb-6">
          From here you take attendance for your class, set and check homework, enter marks and write remarks. Keep your password to yourself; if you forget it, the
          school office can print you a new slip.
        </Alert>
      ) : null}

      {!hasClasses ? (
        <Alert tone="blue" title="No classes yet" className="mb-6">
          You aren&rsquo;t a class teacher and don&rsquo;t teach a subject in any section this session. If that&rsquo;s wrong, please tell the school office.
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        {own.length ? (
          <Card>
            <CardTitle>
              <span className="flex items-center gap-2.5">
                <CalendarCheck2 className="h-5 w-5 text-forest-700" aria-hidden />
                Attendance today
              </span>
            </CardTitle>
            {toTake.length ? (
              <p className="mb-3 font-semibold text-ochre-600">{plural(toTake.length, "register is", "registers are")} still to take.</p>
            ) : withStudents.length ? (
              <p className="mb-3 font-semibold text-forest-700">All your registers are taken. Thank you.</p>
            ) : null}
            <ul className="grid gap-2">
              {own.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-forest-900">{s.label}</span>
                  {!s.studentCount ? (
                    <span className="text-[0.9rem] text-muted">No students yet</span>
                  ) : taken.has(s.id) ? (
                    <Badge tone="green">
                      <CircleCheck className="h-3.5 w-3.5" aria-hidden />
                      Taken
                    </Badge>
                  ) : (
                    <ButtonLink href={`/teach/attendance?section=${s.id}`} size="sm" className="min-h-11">
                      Take register<span className="sr-only"> for {s.label}</span>
                    </ButtonLink>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card>
          <CardTitle>
            <span className="flex items-center gap-2.5">
              <BookOpenCheck className="h-5 w-5 text-forest-700" aria-hidden />
              Marks to enter
            </span>
          </CardTitle>
          {marks.length ? (
            <ul className="grid gap-2">
              {marks.slice(0, 6).map((m) => (
                <li key={`${m.examId}:${m.sectionId}:${m.subjectId}`}>
                  <Link href={m.href} className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 rounded-xl px-2 py-1 hover:bg-cream-200/50">
                    <span className="font-semibold text-forest-800 underline-offset-2 hover:underline">
                      {m.examName}: {m.sectionLabel} {m.subjectName}
                    </span>
                    <span className="text-[0.9rem] text-muted tabular">
                      {m.missing} of {m.students} still to enter
                    </span>
                  </Link>
                </li>
              ))}
              {marks.length > 6 ? (
                <li>
                  <Link href="/teach/marks" className="inline-flex min-h-11 items-center px-2 font-semibold text-forest-800 underline underline-offset-2">
                    {marks.length - 6} more
                  </Link>
                </li>
              ) : null}
            </ul>
          ) : !papers.exams ? (
            <p className="text-forest-900">No exams yet this session. When the school office adds one and sets its maximum marks, your papers will appear here.</p>
          ) : !scope.teaches.length ? (
            <p className="text-forest-900">You don&rsquo;t teach a subject this session, so there are no marks for you to enter.</p>
          ) : !papers.papers ? (
            <p className="text-forest-900">
              The office hasn&rsquo;t set maximum marks for your subjects in this session&rsquo;s exams yet. Your papers will appear here when it has.
            </p>
          ) : (
            <p className="text-forest-900">
              <CircleCheck className="mr-1.5 inline h-5 w-5 text-forest-700" aria-hidden />
              Nothing waiting: every paper you teach has its marks entered.
            </p>
          )}
        </Card>

        <Card>
          <CardTitle>
            <span className="flex items-center gap-2.5">
              <NotebookPen className="h-5 w-5 text-forest-700" aria-hidden />
              Homework due today
            </span>
          </CardTitle>
          {homework.length ? (
            <ul className="grid gap-2">
              {homework.map((h) => {
                const roll = size.get(h.sectionId) ?? 0;
                const done = roll > 0 && h.checked >= roll;
                return (
                  <li key={h.id}>
                    <Link href={`/teach/homework/${h.id}`} className="flex min-h-11 flex-col rounded-xl px-2 py-1 hover:bg-cream-200/50">
                      <span className="text-[0.88rem] font-semibold text-muted">
                        {label.get(h.sectionId) ?? ""} · {h.subjectName ?? "General"}
                      </span>
                      <span className="font-semibold text-forest-800 underline-offset-2 hover:underline">{h.title}</span>
                      <span className="inline-flex items-center gap-1 text-[0.88rem] text-muted">
                        {done ? <CircleCheck className="h-3.5 w-3.5 text-forest-700" aria-hidden /> : <CircleDashed className="h-3.5 w-3.5" aria-hidden />}
                        {done ? "All checked" : `Checked ${h.checked} of ${roll}`}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-forest-900">No homework is due today in your classes.</p>
          )}
        </Card>

        <Card>
          <CardTitle>
            <span className="flex items-center gap-2.5">
              <Megaphone className="h-5 w-5 text-forest-700" aria-hidden />
              From the office
            </span>
          </CardTitle>
          {notices.length ? (
            <ul className="grid gap-3">
              {notices.slice(0, 3).map((n) => (
                <li key={n.id}>
                  <p className="text-[0.88rem] text-muted">
                    {formatDate(n.publishOn)}
                    {n.audience === "staff" ? " · staff only" : ""}
                  </p>
                  <p className="font-semibold text-forest-900">{n.titleEn}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-forest-900">No notices from the office today.</p>
          )}
          <Link href="/teach/notices#from-office" className="mt-3 inline-flex min-h-11 items-center font-semibold text-forest-800 underline underline-offset-2">
            All notices
          </Link>
        </Card>
      </div>

      {hasClasses ? (
        <nav aria-label="Quick links" className="mt-8 flex flex-wrap gap-2.5">
          {own.length ? (
            <ButtonLink href="/teach/attendance" variant="secondary">
              <CalendarCheck2 className="h-4 w-4" aria-hidden />
              Attendance
            </ButtonLink>
          ) : null}
          <ButtonLink href="/teach/homework/new" variant="secondary">
            <NotebookPen className="h-4 w-4" aria-hidden />
            Set homework
          </ButtonLink>
          <ButtonLink href="/teach/marks" variant="secondary">
            <BookOpenCheck className="h-4 w-4" aria-hidden />
            Enter marks
          </ButtonLink>
          <ButtonLink href="/teach/remarks" variant="secondary">
            <MessageSquareText className="h-4 w-4" aria-hidden />
            Write a remark
          </ButtonLink>
          {own.length ? (
            <ButtonLink href="/teach/notices" variant="secondary">
              <Megaphone className="h-4 w-4" aria-hidden />
              Notice to my class
            </ButtonLink>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
