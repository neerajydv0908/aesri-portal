import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { AlertTriangle, CalendarCheck2, ChevronLeft, ChevronRight, CircleDashed } from "lucide-react";
import { Alert, Badge, ButtonLink, Card, CardTitle, EmptyState, PageHeader, Stat, TabLinks, Table, Td, Th } from "@/components/ui";
import { DateField, FilterBar, MonthField, SectionField } from "@/components/pickers";
import { formatDate, formatDateTime, isValidIsoDate, monthName, todayIST, weekdayOf } from "@/lib/dates";
import { officePage } from "@/lib/page";
import { getSchool, listSections } from "@/lib/queries/school";
import {
  ATTENDANCE_LABELS,
  ATTENDANCE_STATUSES,
  emptyCounts,
  formatPercent,
  monthRange,
  registersStatus,
  sectionMonthGrid,
  sessionBounds,
  shiftMonth,
  summarise,
  type AttendanceStatus,
} from "@/lib/services/attendance";

export const metadata: Metadata = { title: "Attendance" };

type SP = { view?: string; date?: string; section?: string; month?: string };

export default async function OfficeAttendancePage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await officePage();
  const sp = await searchParams;
  const view = sp.view === "month" ? "month" : "day";
  const school = await getSchool(ctx.schoolId);
  const warn = school?.settings.attendanceWarnPercent ?? 75;
  return (
    <>
      <PageHeader eyebrow="School office" title="Attendance" description="See which registers have been taken each day, and each class’s month at a glance." />
      <TabLinks
        current={view}
        tabs={[
          { key: "day", href: "/office/attendance", label: "Day" },
          { key: "month", href: "/office/attendance?view=month", label: "Month" },
        ]}
      />
      {view === "day" ? <DayView ctx={ctx} sp={sp} /> : <MonthView ctx={ctx} sp={sp} warn={warn} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Day: every section, taken or not                                    */
/* ------------------------------------------------------------------ */

async function DayView({ ctx, sp }: { ctx: Awaited<ReturnType<typeof officePage>>; sp: SP }) {
  const today = todayIST();
  const bounds = await sessionBounds(ctx.sessionId);
  const date = typeof sp.date === "string" && isValidIsoDate(sp.date) ? sp.date : today;
  const rows = await registersStatus(ctx.schoolId, date, ctx.sessionId);
  const withStudents = rows.filter((r) => r.studentCount > 0);
  const taken = withStudents.filter((r) => r.taken);
  const totals = emptyCounts();
  for (const r of taken) for (const st of ATTENDANCE_STATUSES) totals[st] += r.counts[st];
  const overall = summarise(totals);
  const future = date > today;
  const outside = date < bounds.startsOn || date > bounds.endsOn;

  return (
    <>
      <FilterBar>
        <DateField value={date} min={bounds.startsOn} max={bounds.endsOn < today ? bounds.endsOn : today} />
      </FilterBar>
      <h2 className="mb-4 font-display text-[1.45rem] text-forest-900">{formatDate(date, "en", { weekday: true, long: true })}</h2>
      {weekdayOf(date) === 0 ? (
        <Alert tone="amber" className="mb-5" title="Sunday — usually a holiday">
          Registers can still be taken if the school was open.
        </Alert>
      ) : null}
      {future ? (
        <Alert tone="amber" className="mb-5" title="That date is in the future">
          Registers can only be taken for today or earlier.
        </Alert>
      ) : outside ? (
        <Alert tone="amber" className="mb-5" title={`That date isn’t in the ${bounds.id} session`}>
          The session runs from {formatDate(bounds.startsOn)} to {formatDate(bounds.endsOn)}.
        </Alert>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat
          label="Registers taken"
          value={
            <>
              {taken.length}
              <span className="text-[1.2rem] text-muted"> of {withStudents.length}</span>
            </>
          }
          tone={taken.length === withStudents.length && withStudents.length ? "green" : "amber"}
          hint={withStudents.length - taken.length ? `${withStudents.length - taken.length} still to take` : "All taken"}
        />
        <Stat
          label="Present or late"
          value={formatPercent(overall.percent)}
          hint={`${totals.present + totals.late} of ${overall.days} children in taken registers`}
        />
        <Stat label="Absent" value={totals.absent} tone={totals.absent ? "red" : "default"} hint={`${totals.leave} on leave · ${totals.late} late`} />
      </div>

      {rows.length ? (
        <Table caption={`Attendance registers on ${formatDate(date, "en", { weekday: true })}`}>
          <thead>
            <tr>
              <Th>Class</Th>
              <Th>Register</Th>
              <Th>Taken by</Th>
              {ATTENDANCE_STATUSES.map((st) => (
                <Th key={st} className="text-right">
                  {ATTENDANCE_LABELS[st].en}
                </Th>
              ))}
              {/* "relative" keeps screen-reader-only text inside the scrolling table on phones. */}
              <Th className="relative">
                <span className="sr-only">Open</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sectionId}>
                <Td className="min-w-44">
                  <p className="font-semibold text-forest-900">{r.label}</p>
                  <p className="text-[0.85rem] text-muted">
                    {r.classTeacherName ?? "No class teacher"} · {r.studentCount} {r.studentCount === 1 ? "student" : "students"}
                  </p>
                </Td>
                <Td>
                  {r.taken ? (
                    <Badge tone="green">
                      <CalendarCheck2 className="h-3.5 w-3.5" aria-hidden />
                      Taken
                    </Badge>
                  ) : r.studentCount ? (
                    <Badge tone="amber">
                      <CircleDashed className="h-3.5 w-3.5" aria-hidden />
                      Not taken
                    </Badge>
                  ) : (
                    <span className="text-muted">No students</span>
                  )}
                </Td>
                <Td className="min-w-40 text-[0.9rem]">
                  {r.takenBy ? (
                    <>
                      <p className="text-forest-900">{r.takenBy.name}</p>
                      <p className="text-muted">{r.takenAt ? formatDateTime(r.takenAt).split(", ").pop() : ""}</p>
                    </>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
                {ATTENDANCE_STATUSES.map((st) => (
                  <Td key={st} className={clsx("text-right tabular", st === "absent" && r.counts.absent ? "font-bold text-clay-600" : "")}>
                    {r.taken ? r.counts[st] : <span className="text-muted">–</span>}
                  </Td>
                ))}
                <Td className="text-right">
                  {r.studentCount && !future && !outside ? (
                    <ButtonLink
                      href={`/teach/attendance?section=${r.sectionId}&date=${date}`}
                      variant={r.taken ? "ghost" : "secondary"}
                      size="sm"
                      className="relative whitespace-nowrap"
                    >
                      {r.taken ? "View or edit" : "Take register"}
                      <span className="sr-only"> for {r.label}</span>
                    </ButtonLink>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState title="No classes this session">Add classes and sections under Classes &amp; subjects.</EmptyState>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Month: one section, students × days                                 */
/* ------------------------------------------------------------------ */

const cellTone: Record<AttendanceStatus, string> = {
  present: "bg-sage-100 text-forest-800",
  absent: "bg-clay-50 text-clay-600",
  late: "bg-ochre-50 text-ochre-600",
  leave: "bg-cream-200 text-muted",
};
const DAY_LETTER = ["S", "M", "T", "W", "T", "F", "S"];

async function MonthView({ ctx, sp, warn }: { ctx: Awaited<ReturnType<typeof officePage>>; sp: SP; warn: number }) {
  const sections = await listSections(ctx.schoolId, ctx.sessionId);
  if (!sections.length) return <EmptyState title="No classes this session">Add classes and sections under Classes &amp; subjects.</EmptyState>;
  const section = typeof sp.section === "string" && sp.section ? sections.find((s) => s.id === sp.section) : sections[0];
  if (!section) notFound();

  const today = todayIST();
  const bounds = await sessionBounds(ctx.sessionId);
  const firstMonth = bounds.startsOn.slice(0, 7);
  const lastMonth = (bounds.endsOn < today ? bounds.endsOn : today).slice(0, 7);
  const requested = typeof sp.month === "string" && monthRange(sp.month) ? sp.month : lastMonth;
  const month = requested < firstMonth ? firstMonth : requested > lastMonth ? lastMonth : requested;
  const grid = await sectionMonthGrid(section.id, month, ctx.sessionId);
  if (!grid) notFound();
  const [y, m] = month.split("-").map(Number);
  const title = `${monthName(m - 1)} ${y}`;
  const low = grid.students.filter((s) => s.session.percent !== null && s.session.percent < warn);
  const monthHref = (mm: string) => `/office/attendance?view=month&section=${section.id}&month=${mm}`;

  return (
    <>
      <FilterBar hidden={{ view: "month" }}>
        <SectionField sections={sections} value={section.id} />
        <MonthField value={month} min={firstMonth} max={lastMonth} />
      </FilterBar>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[1.45rem] text-forest-900">
          {section.label} · {title}
        </h2>
        <nav aria-label="Months" className="flex gap-2">
          {month > firstMonth ? (
            <ButtonLink href={monthHref(shiftMonth(month, -1))} variant="secondary" size="sm">
              <ChevronLeft className="h-4 w-4" aria-hidden />
              {monthName(Number(shiftMonth(month, -1).slice(5)) - 1)}
            </ButtonLink>
          ) : null}
          {month < lastMonth ? (
            <ButtonLink href={monthHref(shiftMonth(month, 1))} variant="secondary" size="sm">
              {monthName(Number(shiftMonth(month, 1).slice(5)) - 1)}
              <ChevronRight className="h-4 w-4" aria-hidden />
            </ButtonLink>
          ) : null}
        </nav>
      </div>

      {low.length ? (
        <Alert tone="amber" className="mb-5" title={`${low.length} ${low.length === 1 ? "student is" : "students are"} below ${warn}% this session`}>
          {low.map((s) => `${s.name} (${formatPercent(s.session.percent)})`).join(", ")}
        </Alert>
      ) : null}

      <ul aria-label="Key" className="mb-4 flex flex-wrap gap-x-4 gap-y-2 text-[0.88rem] text-forest-900">
        {ATTENDANCE_STATUSES.map((st) => (
          <li key={st} className="flex items-center gap-1.5">
            <span className={clsx("grid h-6 min-w-6 place-items-center rounded-md px-1 text-[0.75rem] font-bold", cellTone[st])} aria-hidden>
              {ATTENDANCE_LABELS[st].abbr}
            </span>
            {ATTENDANCE_LABELS[st].en}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="grid h-6 min-w-6 place-items-center rounded-md bg-cream-200/60 px-1 text-[0.75rem] text-muted" aria-hidden>
            ·
          </span>
          No register that day
        </li>
      </ul>

      {grid.students.length ? (
        <Table caption={`${section.longLabel}: attendance in ${title}, with each student's month and session percentage`}>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 border-b border-forest-900/10 bg-cream-100 px-3 py-2 text-left text-[0.74rem] font-bold uppercase tracking-[0.1em] text-muted"
              >
                Student
              </th>
              <th
                scope="col"
                className="border-b border-forest-900/10 bg-cream-100 px-2 py-1.5 text-right text-[0.72rem] font-bold uppercase tracking-[0.1em] text-muted"
              >
                Session
              </th>
              <th
                scope="col"
                className="border-b border-r border-forest-900/10 bg-cream-100 px-2 py-1.5 text-right text-[0.72rem] font-bold uppercase tracking-[0.1em] text-muted"
              >
                Month
              </th>
              {grid.days.map((d) => {
                const wd = weekdayOf(d);
                const day = Number(d.slice(8));
                const label = (
                  <>
                    <span className="block" aria-hidden>
                      {DAY_LETTER[wd]}
                    </span>
                    <span className="block tabular text-forest-900" aria-hidden>
                      {day}
                    </span>
                  </>
                );
                return (
                  <th
                    key={d}
                    scope="col"
                    className={clsx(
                      "border-b border-forest-900/10 px-0 py-1 text-center text-[0.72rem] font-semibold text-muted",
                      wd === 0 ? "bg-cream-200/70" : "bg-cream-100",
                    )}
                  >
                    {/* Each day opens that day's register, to take or correct it. */}
                    {d <= today && d >= bounds.startsOn ? (
                      <Link
                        href={`/teach/attendance?section=${section.id}&date=${d}`}
                        title={`Open the register for ${formatDate(d, "en", { weekday: true })}`}
                        className="relative block min-w-7 rounded-md py-0.5 hover:bg-forest-900/[0.07] hover:text-forest-900"
                      >
                        {label}
                        <span className="sr-only">{formatDate(d, "en", { weekday: true })}</span>
                      </Link>
                    ) : (
                      <span className="relative block min-w-7 py-0.5" title={formatDate(d, "en", { weekday: true })}>
                        {label}
                        <span className="sr-only">{formatDate(d, "en", { weekday: true })}</span>
                      </span>
                    )}
                  </th>
                );
              })}
              {(["P", "A", "Lt", "Lv"] as const).map((h, i) => (
                <th key={h} scope="col" className="border-b border-forest-900/10 bg-cream-100 px-2 py-1.5 text-right text-[0.72rem] font-bold text-muted">
                  <abbr title={ATTENDANCE_LABELS[ATTENDANCE_STATUSES[i]].en} className="no-underline">
                    {h}
                  </abbr>
                </th>
              ))}
              <th
                scope="col"
                className="border-b border-forest-900/10 bg-cream-100 px-3 py-1.5 text-right text-[0.72rem] font-bold uppercase tracking-[0.1em] text-muted"
              >
                Days
              </th>
            </tr>
          </thead>
          <tbody>
            {grid.students.map((s) => {
              const lowSession = s.session.percent !== null && s.session.percent < warn;
              const lowMonth = s.month.percent !== null && s.month.percent < warn;
              return (
                <tr key={s.id} className="border-b border-forest-900/[0.06]">
                  <th scope="row" className="sticky left-0 z-10 bg-cream-50 px-3 py-1.5 text-left font-normal">
                    <span className="flex items-baseline gap-2 whitespace-nowrap">
                      <span className="w-5 text-right text-[0.8rem] text-muted tabular">{s.rollNo ?? "–"}</span>
                      <span className="font-semibold text-forest-900">{s.name}</span>
                    </span>
                  </th>
                  <td
                    className={clsx(
                      "px-2 text-right tabular text-[0.88rem] whitespace-nowrap",
                      lowSession ? "font-bold text-clay-600" : "font-semibold text-forest-900",
                    )}
                  >
                    {lowSession ? <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-label={`Below ${warn}%`} /> : null}
                    {formatPercent(s.session.percent)}
                  </td>
                  <td
                    className={clsx(
                      "border-r border-forest-900/10 px-2 text-right tabular text-[0.88rem] whitespace-nowrap",
                      lowMonth ? "font-bold text-clay-600" : "",
                    )}
                  >
                    {lowMonth ? <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-label={`Below ${warn}%`} /> : null}
                    {formatPercent(s.month.percent)}
                  </td>
                  {grid.days.map((d) => {
                    const st = s.marks[d];
                    const reg = grid.registerDays.has(d);
                    return (
                      <td key={d} className={clsx("h-9 min-w-7 px-0.5 text-center", weekdayOf(d) === 0 && !st ? "bg-cream-200/50" : "")}>
                        {st ? (
                          <abbr
                            title={`${ATTENDANCE_LABELS[st].en}, ${formatDate(d)}`}
                            className={clsx("grid h-7 place-items-center rounded-md text-[0.72rem] font-bold no-underline", cellTone[st])}
                          >
                            {ATTENDANCE_LABELS[st].abbr}
                          </abbr>
                        ) : reg ? (
                          <span className="text-muted" title="Not on the roll that day">
                            –
                          </span>
                        ) : (
                          <span className="text-muted/50" aria-hidden>
                            ·
                          </span>
                        )}
                      </td>
                    );
                  })}
                  {ATTENDANCE_STATUSES.map((st) => (
                    <td key={st} className={clsx("px-2 text-right tabular text-[0.88rem]", st === "absent" && s.month.absent ? "font-bold text-clay-600" : "")}>
                      {s.month[st]}
                    </td>
                  ))}
                  <td className="px-3 text-right tabular text-[0.88rem] text-muted">{s.month.days}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      ) : (
        <EmptyState title={`No students in ${section.label}`}>Once students are added to this class, their attendance appears here.</EmptyState>
      )}

      <Card className="mt-6">
        <CardTitle>How the percentage is worked out</CardTitle>
        <p className="text-[0.95rem] text-muted">
          Attendance % = (days present + days late) ÷ school days on which the class register was taken while the student was on the roll. Days on leave are
          counted as school days but not as present, and are shown separately. Students below {warn}% (the school’s setting) are marked with{" "}
          <AlertTriangle className="inline h-3.5 w-3.5 align-[-2px] text-clay-600" aria-hidden /> in red.
        </p>
        <p className="mt-3 text-[0.95rem] text-muted">
          To take or correct a register, select the day at the top of its column, or choose the date in the{" "}
          <Link href={`/office/attendance?date=${today}`} className="font-semibold text-forest-800 underline underline-offset-4">
            Day
          </Link>{" "}
          view.
        </p>
      </Card>
    </>
  );
}
