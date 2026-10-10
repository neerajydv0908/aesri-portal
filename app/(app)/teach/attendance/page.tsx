import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { CalendarCheck2, CircleDashed, Lock, Users } from "lucide-react";
import { Alert, Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { ActionForm } from "@/components/forms";
import { DateField, FilterBar, SectionField } from "@/components/pickers";
import { AttendanceBadge, AttendanceIcon, ATTENDANCE_TONE } from "@/components/daily/badges";
import { MarkAllButton } from "@/components/daily/mark-all";
import { StatusRadios, type Choice } from "@/components/daily/status-radios";
import { SmsHint } from "@/components/sms/parts";
import { attendanceDelaySeconds, delayAfterSave, smsMode } from "@/lib/sms/config";
import { schoolSmsSettings } from "@/lib/queries/sms";
import { addDays, formatDate, formatDateTime, isValidIsoDate, todayIST, weekdayOf } from "@/lib/dates";
import { teacherPage } from "@/lib/page";
import {
  ATTENDANCE_LABELS,
  ATTENDANCE_STATUSES,
  TEACHER_EDIT_DAYS,
  registerDates,
  registerView,
  registerWindow,
  sessionBounds,
} from "@/lib/services/attendance";
import { saveAttendanceAction } from "./actions";

export const metadata: Metadata = { title: "Attendance" };

const CHOICES: Choice[] = [
  { value: "present", label: "Present", tone: "green" },
  { value: "absent", label: "Absent", tone: "red" },
  { value: "late", label: "Late", tone: "amber" },
  { value: "leave", label: "Leave", tone: "slate" },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Sat 26 Sep" */
const shortDay = (iso: string) => `${WEEKDAYS[weekdayOf(iso)]} ${formatDate(iso).replace(/ \d{4}$/, "")}`;

export default async function TeachAttendancePage({ searchParams }: { searchParams: Promise<{ section?: string; date?: string }> }) {
  const ctx = await teacherPage();
  const sp = await searchParams;
  const list = ctx.classTeacherSections;

  const header = (
    <PageHeader
      eyebrow={ctx.isAdmin ? "Registers" : "Class teacher"}
      title="Attendance"
      description="Take the register for your class. Everyone starts as Present, so you only need to change the students who are absent, late or on leave."
    />
  );
  if (!list.length) {
    return (
      <>
        {header}
        <EmptyState icon={<Users className="h-5 w-5" aria-hidden />} title="No class register for you">
          Attendance is taken by class teachers, and you aren’t the class teacher of a section this session. If that’s wrong, please tell the school office.
        </EmptyState>
      </>
    );
  }

  // A section someone may not use is "not found" — never another class's register.
  const section = typeof sp.section === "string" && sp.section ? list.find((s) => s.id === sp.section) : list[0];
  if (!section) notFound();

  const today = todayIST();
  const date = typeof sp.date === "string" && isValidIsoDate(sp.date) ? sp.date : today;
  const bounds = await sessionBounds(ctx.sessionId);
  const win = registerWindow(bounds, today, ctx.isAdmin);
  const future = date > today;
  const outside = date < bounds.startsOn || date > bounds.endsOn;
  const editable = !future && !outside && date >= win.from && date <= win.to;
  const view = !future && !outside ? await registerView(section.id, date) : null;

  const chipDays = Array.from({ length: TEACHER_EDIT_DAYS + 1 }, (_, i) => addDays(today, -i)).filter((d) => d >= bounds.startsOn);
  // Families hear about today's and yesterday's registers by text message (if the school has that on).
  const smsSettings = await schoolSmsSettings(ctx.schoolId);
  const smsMarks = (["absent", "late", "leave", "present"] as const).filter((m) => smsSettings.enabled && smsSettings.events[`attendance_${m}`]);
  const smsNote =
    editable && (date === today || date === addDays(today, -1)) && smsMarks.length && smsMode() !== "off"
      ? `Families get a text message about their child’s mark ${delayAfterSave(attendanceDelaySeconds())} (${
          smsMarks.length === 4 ? "every mark" : smsMarks.map((m) => (m === "leave" ? "on leave" : m)).join(", ")
        }). If you change a mark before it goes, only the new mark is sent; after that, a short correction.`
      : null;
  const taken = await registerDates(section.id, chipDays[chipDays.length - 1] ?? today, today);
  const href = (d: string) => `/teach/attendance?section=${section.id}&date=${d}`;

  return (
    <>
      {header}

      <FilterBar>
        <SectionField sections={list} value={section.id} />
        <DateField value={date} min={bounds.startsOn} max={today} />
      </FilterBar>

      <nav aria-label="Recent days" className="no-print -mt-2 mb-6">
        <ul className="flex flex-wrap gap-2">
          {chipDays.map((d, i) => {
            const isTaken = taken.has(d);
            return (
              <li key={d}>
                <Link
                  href={href(d)}
                  aria-current={d === date ? "page" : undefined}
                  className={clsx(
                    "flex min-h-11 flex-col justify-center rounded-2xl px-3.5 py-1.5 text-[0.85rem] leading-tight ring-1 transition-colors",
                    d === date ? "bg-forest-800 text-cream-50 ring-forest-800" : "bg-cream-50 text-forest-900 ring-forest-900/15 hover:ring-forest-900/35",
                  )}
                >
                  <span className="font-semibold">{i === 0 ? "Today" : i === 1 ? "Yesterday" : shortDay(d)}</span>
                  <span className={clsx("flex items-center gap-1 text-[0.78rem]", d === date ? "text-sage-200" : "text-muted")}>
                    {isTaken ? <CalendarCheck2 className="h-3.5 w-3.5" aria-hidden /> : <CircleDashed className="h-3.5 w-3.5" aria-hidden />}
                    {isTaken ? "Taken" : "Not taken"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Card className="px-4 sm:px-7">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="eyebrow">{section.longLabel}</p>
            <h2 className="mt-1 font-display text-[1.45rem] leading-tight text-forest-900">{formatDate(date, "en", { weekday: true, long: true })}</h2>
            {view?.register ? (
              <p className="mt-1.5 text-[0.92rem] text-muted">
                Last saved by {view.register.takenBy.name}
                {view.register.takenBy.loginId ? ` (${view.register.takenBy.loginId})` : ""} · {formatDateTime(view.register.takenAt)}
              </p>
            ) : null}
          </div>
          {view ? (
            view.register ? (
              <Badge tone="green" className="self-start">
                <CalendarCheck2 className="h-3.5 w-3.5" aria-hidden />
                Register taken
              </Badge>
            ) : (
              <Badge tone="grey" className="self-start">
                <CircleDashed className="h-3.5 w-3.5" aria-hidden />
                Not taken yet
              </Badge>
            )
          ) : null}
        </div>

        {weekdayOf(date) === 0 && !future && !outside ? (
          <Alert tone="amber" className="mb-5" title="Sunday — usually a holiday">
            You can still save a register if the school was open today.
          </Alert>
        ) : null}

        {future ? (
          <Alert tone="amber" title="That date is in the future">
            You can take attendance for today, or check an earlier day.{" "}
            <Link href={href(today)} className="font-semibold underline underline-offset-4">
              Go to today
            </Link>
          </Alert>
        ) : outside ? (
          <Alert tone="amber" title={`That date isn’t in the ${bounds.id} session`}>
            The session runs from {formatDate(bounds.startsOn)} to {formatDate(bounds.endsOn)}.
          </Alert>
        ) : !view || !view.students.length ? (
          <EmptyState icon={<Users className="h-5 w-5" aria-hidden />} title={`No students in ${section.label} yet`}>
            Once the office adds students to this class, they’ll appear here.
          </EmptyState>
        ) : editable ? (
          <ActionForm key={`${section.id}:${date}`} action={saveAttendanceAction} className="gap-4 [html:has(&)]:scroll-pb-28">
            <input type="hidden" name="section" value={section.id} />
            <input type="hidden" name="date" value={date} />
            <input type="hidden" name="roster" value={view.students.map((s) => s.id).join(",")} />
            {smsNote ? <SmsHint>{smsNote}</SmsHint> : null}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SavedCounts counts={view.register ? view.counts : null} total={view.students.length} />
              <MarkAllButton
                group="attendance"
                value="present"
                label="Mark everyone present"
                announce="Everyone is marked present. Press Save attendance to keep it."
              />
            </div>
            {/* Keyed by the last save, so the choices show the saved marks after saving. */}
            <ol key={view.register?.takenAt.toISOString() ?? "new"} className="divide-y divide-forest-900/[0.07] border-y border-forest-900/[0.07]">
              {view.students.map((s) => (
                <li key={s.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] sm:items-center sm:gap-4">
                  <p id={`name-${s.id}`} className="flex min-w-0 items-baseline gap-3">
                    <span className="w-7 shrink-0 text-right text-[0.9rem] text-muted tabular">
                      <span className="sr-only">Roll </span>
                      {s.rollNo ?? "–"}
                    </span>
                    <span className="min-w-0 font-semibold text-forest-900">{s.name}</span>
                  </p>
                  <StatusRadios
                    name={`st_${s.id}`}
                    labelledBy={`name-${s.id}`}
                    choices={CHOICES}
                    value={s.status ?? "present"}
                    markAllGroup="attendance"
                    className="grid-cols-4"
                  />
                </li>
              ))}
            </ol>
            <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-forest-900/10 bg-cream-50/95 px-4 py-3 backdrop-blur sm:-mx-7 sm:px-7">
              <p className="text-[0.88rem] text-muted">
                {view.register ? "Saving again replaces the marks for this day." : "Nothing is saved until you press Save."}
              </p>
              <SubmitButton pendingLabel="Saving…">Save attendance</SubmitButton>
            </div>
          </ActionForm>
        ) : (
          <>
            <Alert tone="blue" className="mb-5" title={ctx.isAdmin ? "Read only" : "This register can no longer be changed here"}>
              <span className="inline-flex items-start gap-1.5">
                <Lock className="mt-1 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  Teachers can take or change attendance for today and the {TEACHER_EDIT_DAYS} days before. To correct an older day, please ask the school
                  office.
                </span>
              </span>
            </Alert>
            {view.register ? (
              <>
                <SavedCounts counts={view.counts} total={view.students.length} />
                <ol className="mt-4 divide-y divide-forest-900/[0.07] border-y border-forest-900/[0.07]">
                  {view.students.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="flex min-w-0 items-baseline gap-3">
                        <span className="w-7 shrink-0 text-right text-[0.9rem] text-muted tabular">
                          <span className="sr-only">Roll </span>
                          {s.rollNo ?? "–"}
                        </span>
                        <span className="min-w-0 font-semibold text-forest-900">{s.name}</span>
                      </span>
                      <AttendanceBadge status={s.status} />
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="text-muted">No register was taken for {section.label} on this day.</p>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function SavedCounts({ counts, total }: { counts: Record<(typeof ATTENDANCE_STATUSES)[number], number> | null; total: number }) {
  if (!counts) {
    return (
      <p className="text-[0.95rem] text-forest-900">
        <span className="font-semibold tabular">{total}</span> students on the roll
      </p>
    );
  }
  return (
    <ul aria-label="Saved marks" className="flex flex-wrap gap-1.5">
      {ATTENDANCE_STATUSES.map((st) => (
        <li key={st}>
          <Badge tone={ATTENDANCE_TONE[st]}>
            <AttendanceIcon status={st} />
            <span className="tabular">{counts[st]}</span> {ATTENDANCE_LABELS[st].en.toLowerCase()}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
