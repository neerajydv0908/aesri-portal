import type { Metadata } from "next";
import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Alert, ButtonLink, Card, CardTitle, PageHeader } from "@/components/ui";
import { AttendanceIcon } from "@/components/daily/badges";
import { classLabel, classLabelHi } from "@/lib/classes";
import { formatDate, monthName, todayIST, weekdayOf } from "@/lib/dates";
import { getLang } from "@/lib/i18n/server";
import { familyPage } from "@/lib/page";
import { getSchool } from "@/lib/queries/school";
import {
  ATTENDANCE_LABELS,
  ATTENDANCE_STATUSES,
  attendanceSummary,
  formatPercent,
  monthRange,
  sessionBounds,
  shiftMonth,
  studentMarks,
  type AttendanceStatus,
} from "@/lib/services/attendance";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "उपस्थिति" : "Attendance" };
}

const cellTone: Record<AttendanceStatus, string> = {
  present: "bg-sage-100 text-forest-800",
  absent: "bg-clay-50 text-clay-600 ring-1 ring-clay-500/30",
  late: "bg-ochre-50 text-ochre-600 ring-1 ring-ochre-500/30",
  leave: "bg-cream-200 text-muted",
};
const WEEK_EN = [
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
  ["Sun", "Sunday"],
];
const WEEK_HI = [
  ["सोम", "सोमवार"],
  ["मंगल", "मंगलवार"],
  ["बुध", "बुधवार"],
  ["गुरु", "गुरुवार"],
  ["शुक्र", "शुक्रवार"],
  ["शनि", "शनिवार"],
  ["रवि", "रविवार"],
];

export default async function MyAttendancePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const ctx = await familyPage();
  const { t, lang } = ctx;
  const sp = await searchParams;
  const today = todayIST();
  const bounds = await sessionBounds(ctx.sessionId);
  const firstMonth = bounds.startsOn.slice(0, 7);
  const lastMonth = (bounds.endsOn < today ? bounds.endsOn : today).slice(0, 7);
  const requested = typeof sp.month === "string" && monthRange(sp.month) ? sp.month : lastMonth;
  const month = requested < firstMonth ? firstMonth : requested > lastMonth ? lastMonth : requested;
  const range = monthRange(month)!;
  const [session, inMonth, marks, school] = await Promise.all([
    attendanceSummary(ctx.studentId, ctx.sessionId),
    attendanceSummary(ctx.studentId, ctx.sessionId, { from: range.first, to: range.last }),
    studentMarks(ctx.studentId, range.first, range.last),
    getSchool(ctx.schoolId),
  ]);
  const warn = school?.settings.attendanceWarnPercent ?? 75;
  const byDate = new Map(marks.map((m) => [m.date, m.status]));
  const monthIdx = Number(month.slice(5)) - 1;
  const monthTitle = `${monthName(monthIdx, lang)} ${month.slice(0, 4)}`;
  const monthOnly = monthName(monthIdx, lang);
  const p = ctx.placement;
  const classText = p ? (lang === "hi" ? classLabelHi(p.className, p.stream, p.sectionName) : classLabel(p.className, p.stream, p.sectionName)) : null;

  // Calendar weeks, Monday first.
  const offset = (weekdayOf(range.first) + 6) % 7;
  const daysInMonth = Number(range.last.slice(8));
  const cells: (string | null)[] = [
    ...Array(offset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  const week = lang === "hi" ? WEEK_HI : WEEK_EN;

  const dayList = (status: AttendanceStatus) => marks.filter((m) => m.status === status).map((m) => m.date);
  const absentDays = dayList("absent");
  const lateDays = dayList("late");
  const leaveDays = dayList("leave");
  const attended = (s: typeof session) => s.present + s.late;
  const monthHref = (m: string) => `/my/attendance?month=${m}`;

  return (
    <>
      <PageHeader
        eyebrow={classText ? `${ctx.student.name} · ${classText}` : ctx.student.name}
        title={t("Attendance", "उपस्थिति")}
        description={t(
          "The days your child was present, absent, late or on leave, as marked by the class teacher.",
          "कक्षा अध्यापक द्वारा दर्ज किए गए दिन — जब आपका बच्चा उपस्थित, अनुपस्थित, देर से या अवकाश पर रहा।",
        )}
      />

      {!p ? (
        <Alert tone="blue" className="mb-6">
          {t("Your child hasn’t been placed in a class for this session yet.", "इस सत्र के लिए अभी आपके बच्चे को किसी कक्षा में नहीं जोड़ा गया है।")}
        </Alert>
      ) : null}

      {session.percent !== null && session.percent < warn ? (
        <Alert tone="amber" className="mb-6" title={t(`Attendance is below ${warn}%`, `उपस्थिति ${warn}% से कम है`)}>
          {t(
            "Coming to school every day helps your child keep up. If something is keeping your child at home, please talk to the class teacher.",
            "रोज़ विद्यालय आने से बच्चा पढ़ाई में पीछे नहीं रहता। अगर किसी कारण से बच्चा घर पर रह रहा है, तो कृपया कक्षा अध्यापक से बात करें।",
          )}
        </Alert>
      ) : null}

      <Card className="mb-6 px-3 py-5 sm:p-7">
        <dl className="grid grid-cols-3 divide-x divide-forest-900/10 text-center">
          <SummaryItem
            label={t("This session", "इस सत्र में")}
            value={formatPercent(session.percent)}
            tone={session.percent !== null && session.percent < warn ? "text-clay-600" : "text-forest-700"}
            hint={
              session.days
                ? t(`${attended(session)} of ${session.days} days`, `${session.days} में से ${attended(session)} दिन`)
                : t("No registers yet", "अभी हाज़िरी नहीं")
            }
          />
          <SummaryItem
            label={t(`In ${monthOnly}`, `${monthOnly} में`)}
            value={formatPercent(inMonth.percent)}
            tone={inMonth.percent !== null && inMonth.percent < warn ? "text-clay-600" : "text-forest-900"}
            hint={
              inMonth.days
                ? t(`${attended(inMonth)} of ${inMonth.days} days`, `${inMonth.days} में से ${attended(inMonth)} दिन`)
                : t("No registers", "हाज़िरी नहीं")
            }
          />
          <SummaryItem
            label={t("Days absent", "अनुपस्थित दिन")}
            value={String(session.absent)}
            tone={session.absent ? "text-clay-600" : "text-forest-900"}
            hint={t(`this session · ${inMonth.absent} in ${monthOnly}`, `इस सत्र में · ${monthOnly} में ${inMonth.absent}`)}
          />
        </dl>
        {session.leave || session.late ? (
          <p className="mt-4 border-t border-forest-900/10 pt-3 text-center text-[0.88rem] text-muted">
            {t(`This session: ${session.late} late, ${session.leave} on leave.`, `इस सत्र में: ${session.late} दिन देर से, ${session.leave} दिन अवकाश।`)}
          </p>
        ) : null}
      </Card>

      <Card className="px-3 sm:px-7">
        <div className="mb-4 flex items-center justify-between gap-2">
          {month > firstMonth ? (
            <ButtonLink href={monthHref(shiftMonth(month, -1))} variant="secondary" size="md" className="w-11 px-0! sm:w-auto sm:px-4!">
              <ChevronLeft className="h-4 w-4" aria-hidden />
              <span className="sr-only">{t("Previous month:", "पिछला महीना:")} </span>
              <span className="sr-only sm:not-sr-only">{monthName(Number(shiftMonth(month, -1).slice(5)) - 1, lang)}</span>
            </ButtonLink>
          ) : (
            <span className="w-11 sm:w-24" />
          )}
          <h2 className="text-center font-display text-[1.35rem] leading-tight text-forest-900">{monthTitle}</h2>
          {month < lastMonth ? (
            <ButtonLink href={monthHref(shiftMonth(month, 1))} variant="secondary" size="md" className="w-11 px-0! sm:w-auto sm:px-4!">
              <span className="sr-only">{t("Next month:", "अगला महीना:")} </span>
              <span className="sr-only sm:not-sr-only">{monthName(Number(shiftMonth(month, 1).slice(5)) - 1, lang)}</span>
              <ChevronRight className="h-4 w-4" aria-hidden />
            </ButtonLink>
          ) : (
            <span className="w-11 sm:w-24" />
          )}
        </div>

        <table className="w-full table-fixed border-separate border-spacing-1">
          <caption className="sr-only">{t(`Attendance in ${monthTitle}`, `${monthTitle} की उपस्थिति`)}</caption>
          <thead>
            <tr>
              {week.map(([short, long]) => (
                <th key={short} scope="col" className="pb-1 text-center text-[0.78rem] font-semibold text-muted">
                  <abbr title={long} className="no-underline">
                    {short}
                  </abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((w, wi) => (
              <tr key={wi}>
                {w.map((d, i) => {
                  if (!d) return <td key={i} />;
                  const st = byDate.get(d);
                  const day = Number(d.slice(8));
                  return (
                    <td key={d} className="p-0 align-top">
                      <div
                        className={clsx(
                          "flex h-14 flex-col items-center justify-center gap-0.5 rounded-xl sm:h-16",
                          st ? cellTone[st] : i === 6 ? "bg-cream-200/60 text-muted" : "text-muted",
                          d === today && "outline-2 outline-offset-1 outline-forest-700",
                        )}
                      >
                        <span className={clsx("text-[0.85rem] tabular", st ? "font-bold" : "")}>{day}</span>
                        {st ? <AttendanceIcon status={st} className="h-4 w-4" /> : null}
                        {st ? <span className="sr-only">{ATTENDANCE_LABELS[st][lang]}</span> : null}
                        {d === today ? <span className="sr-only">{t("(today)", "(आज)")}</span> : null}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <ul aria-label={t("Key", "संकेत")} className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-forest-900/10 pt-4 text-[0.9rem] text-forest-900">
          {ATTENDANCE_STATUSES.map((st) => (
            <li key={st} className="flex items-center gap-1.5">
              <span className={clsx("grid h-7 w-7 place-items-center rounded-lg", cellTone[st])}>
                <AttendanceIcon status={st} className="h-4 w-4" />
              </span>
              {ATTENDANCE_LABELS[st][lang]}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[0.85rem] text-muted">
          {t(
            "Days without a mark are holidays, Sundays or days the register wasn’t taken.",
            "बिना निशान वाले दिन छुट्टी, रविवार या बिना हाज़िरी वाले दिन हैं।",
          )}
        </p>
      </Card>

      <Card className="mt-6">
        <CardTitle>{t(`Days absent in ${monthOnly}`, `${monthOnly} में अनुपस्थित दिन`)}</CardTitle>
        {absentDays.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {absentDays.map((d) => (
              <li key={d} className="flex items-center gap-2 rounded-xl bg-clay-50 px-3 py-2 text-forest-900">
                <AttendanceIcon status="absent" className="h-4 w-4 text-clay-600" />
                {formatDate(d, lang, { weekday: true })}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">{t(`No days absent in ${monthOnly}.`, `${monthOnly} में कोई अनुपस्थिति नहीं।`)}</p>
        )}
        {lateDays.length || leaveDays.length ? (
          <dl className="mt-5 grid gap-3 text-[0.95rem] sm:grid-cols-2">
            {lateDays.length ? (
              <div>
                <dt className="font-semibold text-forest-900">{t("Late", "देर से आए")}</dt>
                <dd className="text-muted">{lateDays.map((d) => formatDate(d, lang)).join(", ")}</dd>
              </div>
            ) : null}
            {leaveDays.length ? (
              <div>
                <dt className="font-semibold text-forest-900">{t("On leave", "अवकाश पर")}</dt>
                <dd className="text-muted">{leaveDays.map((d) => formatDate(d, lang)).join(", ")}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </Card>
    </>
  );
}

function SummaryItem({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: string }) {
  return (
    <div className="flex flex-col items-center px-1.5 sm:px-4">
      <dt className="text-[0.85rem] font-semibold leading-snug text-muted">{label}</dt>
      <dd className={clsx("mt-1.5 font-display text-[1.75rem] leading-none tabular sm:text-[2.1rem]", tone)}>{value}</dd>
      <dd className="mt-1 text-[0.8rem] leading-snug text-muted">{hint}</dd>
    </div>
  );
}
