/**
 * Attendance: one register per section per school day, and one mark per
 * student on the roll that day — present, absent, late or leave.
 *
 *  - The register records who last saved it and when. Each mark records who
 *    set it and when, and only changes when its status changes. Every save
 *    is audited, with the marks that changed, so the history can be traced.
 *  - Class teachers may take or change a register for today and the
 *    3 days before; school admins for any day of the session up to today.
 *  - Attendance % = (present + late) ÷ school days on which the register was
 *    taken while the student was on that section's roll (so a child admitted
 *    in September isn't counted absent for April). Leave is shown separately
 *    and doesn't count as present.
 *
 * Writes take the caller's transaction and always write an audit entry.
 * Read helpers open their own connection. This file also holds the small
 * helpers shared by the other daily-work services (homework, remarks,
 * notices). It deliberately avoids "server-only" imports so the demo script
 * can use it.
 */
import { and, asc, count, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import { academicSessions, accounts, attendance, attendanceRegisters, classes, enrolments, sections, staff, students } from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { classLabel, sectionLabel } from "@/lib/classes";
import { addDays, eachDay, isValidIsoDate } from "@/lib/dates";
import { displayLoginId } from "@/lib/ids";
import { queueAttendance, type AttendanceSmsResult } from "@/lib/sms/outbox";
import { RecordError } from "./students";

/* ------------------------------------------------------------------ */
/* Shared helpers for the daily-work services                          */
/* ------------------------------------------------------------------ */

/** The signed-in person making a change (their account is stored on the record). */
export type Writer = AuditActor & { accountId: string };

/** A staff member (or AESRI admin) as shown next to a record: "Sunita Meena (AryaE3)". */
export type Person = { name: string; loginId: string };

/** Names for account IDs: the staff member's name, an AESRI admin's display name, or the login ID. */
export async function peopleByAccount(ids: (string | null | undefined)[]): Promise<Map<string, Person>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, Person>();
  if (!wanted.length) return out;
  const db = await getDb();
  const rows = await db
    .select({ id: accounts.id, loginId: accounts.loginId, displayName: accounts.displayName, staffName: staff.name, studentName: students.name })
    .from(accounts)
    .leftJoin(staff, eq(staff.id, accounts.staffId))
    .leftJoin(students, eq(students.id, accounts.studentId))
    .where(inArray(accounts.id, wanted));
  for (const r of rows) {
    const loginId = displayLoginId(r.loginId);
    out.set(r.id, { name: r.staffName ?? r.displayName ?? r.studentName ?? loginId, loginId });
  }
  return out;
}

/** Tidy text typed into a box: trims, keeps line breaks (at most one blank line), caps the length. */
export function cleanLongText(input: unknown, max: number): string | null {
  if (typeof input !== "string") return null;
  const s = input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s ? s.slice(0, max) : null;
}

/** A section with its school and session, or null. */
export async function sectionOf(tx: Tx, sectionId: string) {
  if (!isUuid(sectionId)) return null;
  const [row] = await tx
    .select({
      id: sections.id,
      name: sections.name,
      schoolId: classes.schoolId,
      sessionId: sections.sessionId,
      classId: classes.id,
      className: classes.name,
      stream: classes.stream,
    })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(eq(sections.id, sectionId));
  return row ? { ...row, label: sectionLabel(row.className, row.name), longLabel: `${classLabel(row.className, row.stream)}, section ${row.name}` } : null;
}

/** IDs from forms and URLs are checked for shape before they reach a query. */
export function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** Students on a section's roll (active and enrolled in it), by roll number, then name. */
export async function sectionRoll(tx: Tx, sectionId: string) {
  return tx
    .select({ id: students.id, name: students.name, srNo: students.srNo, rollNo: enrolments.rollNo })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(and(eq(enrolments.sectionId, sectionId), eq(students.status, "active")))
    .orderBy(asc(enrolments.rollNo), asc(students.name));
}
export type RollStudent = Awaited<ReturnType<typeof sectionRoll>>[number];

export type SessionBounds = { id: string; startsOn: string; endsOn: string };

/** First and last day of an academic session. */
export async function sessionBounds(sessionId: string, tx?: Tx): Promise<SessionBounds> {
  const db = tx ?? (await getDb());
  const [s] = await db
    .select({ id: academicSessions.id, startsOn: academicSessions.startsOn, endsOn: academicSessions.endsOn })
    .from(academicSessions)
    .where(eq(academicSessions.id, sessionId));
  if (!s) throw new Error(`Unknown academic session ${sessionId}.`);
  return s;
}

async function currentSessionIdOf(tx: Tx): Promise<string> {
  const [s] = await tx.select({ id: academicSessions.id }).from(academicSessions).where(eq(academicSessions.isCurrent, true));
  if (!s) throw new Error("No current academic session. Run `npm run setup`.");
  return s.id;
}

const minIso = (a: string, b: string) => (a < b ? a : b);
const maxIso = (a: string, b: string) => (a > b ? a : b);

/* ------------------------------------------------------------------ */
/* Statuses and percentages                                            */
/* ------------------------------------------------------------------ */

export type AttendanceStatus = "present" | "absent" | "late" | "leave";
export const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = ["present", "absent", "late", "leave"];

export function isAttendanceStatus(v: unknown): v is AttendanceStatus {
  return typeof v === "string" && (ATTENDANCE_STATUSES as readonly string[]).includes(v);
}

/** Words for each status; `abbr` is the one- or two-letter symbol used in month grids. */
export const ATTENDANCE_LABELS: Record<AttendanceStatus, { en: string; hi: string; abbr: string }> = {
  present: { en: "Present", hi: "उपस्थित", abbr: "P" },
  absent: { en: "Absent", hi: "अनुपस्थित", abbr: "A" },
  late: { en: "Late", hi: "देर से", abbr: "Lt" },
  leave: { en: "Leave", hi: "अवकाश", abbr: "Lv" },
};

export type StatusCounts = Record<AttendanceStatus, number>;
export const emptyCounts = (): StatusCounts => ({ present: 0, absent: 0, late: 0, leave: 0 });

/**
 * A student's attendance over a period.
 *  - `days`: school days on which the register was taken while the student was on the roll
 *  - `percent`: (present + late) ÷ days × 100, rounded to one decimal; null when no register has been taken yet
 */
export type AttendanceSummary = StatusCounts & { days: number; percent: number | null };

export function summarise(counts: StatusCounts): AttendanceSummary {
  const days = counts.present + counts.absent + counts.late + counts.leave;
  return { ...counts, days, percent: days ? Math.round(((counts.present + counts.late) / days) * 1000) / 10 : null };
}

/** "93.5%", "100%", or "—" when there is nothing to count yet. */
export function formatPercent(p: number | null | undefined): string {
  if (p === null || p === undefined) return "—";
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}

/* ------------------------------------------------------------------ */
/* Which days may be marked                                            */
/* ------------------------------------------------------------------ */

/** How many days back (besides today) a class teacher may take or change a register. */
export const TEACHER_EDIT_DAYS = 3;

/**
 * The dates a person may take or change a register for (inclusive). Empty
 * (from > to) when the session hasn't started or is over.
 */
export function registerWindow(bounds: SessionBounds, today: string, isAdmin: boolean): { from: string; to: string } {
  const to = minIso(today, bounds.endsOn);
  const from = maxIso(bounds.startsOn, isAdmin ? bounds.startsOn : addDays(today, -TEACHER_EDIT_DAYS));
  return { from, to };
}

/** "2026-09" → first and last date of that month, or null if it isn't a month. */
export function monthRange(month: string): { first: string; last: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = `${month}-01`;
  return isValidIsoDate(first) ? { first, last: `${month}-${String(lastDay).padStart(2, "0")}` } : null;
}

/** "2026-09" + n months → "2026-10". */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/* ------------------------------------------------------------------ */
/* Saving a register                                                   */
/* ------------------------------------------------------------------ */

/** The roll changed after the page was opened (a student was added), so the teacher must check again. */
export class RollChangedError extends RecordError {
  constructor(public readonly names: string[]) {
    super(
      `The class list has changed since you opened this page: ${names.join(", ")} ${names.length === 1 ? "was" : "were"} added. ` +
        "Please check the list and save again.",
    );
  }
}

export type RegisterMark = { studentId: string; status: AttendanceStatus };

/**
 * Take or change a section's register for one day. Every student on the roll
 * must have a mark. Marks for anyone not on the roll are ignored.
 *
 * For today's and yesterday's registers, the families of students whose
 * mark is new or changed get a text message (lib/sms/outbox.ts,
 * queueAttendance): queued in this transaction and sent after a short
 * delay, so a corrected register sends one message, not two.
 */
export async function saveRegister(
  tx: Tx,
  input: { schoolId: string; sectionId: string; date: string; marks: RegisterMark[] },
  actor: Writer,
): Promise<{ counts: StatusCounts; changed: number; firstSave: boolean; sms: AttendanceSmsResult }> {
  const sec = await sectionOf(tx, input.sectionId);
  if (!sec || sec.schoolId !== input.schoolId) throw new RecordError("Choose a class of this school.");
  if (!isValidIsoDate(input.date)) throw new RecordError("Choose a valid date.");
  const bounds = await sessionBounds(sec.sessionId, tx);
  if (input.date < bounds.startsOn || input.date > bounds.endsOn) throw new RecordError(`That date is outside the ${bounds.id} session.`);

  const roll = await sectionRoll(tx, sec.id);
  if (!roll.length) throw new RecordError(`There are no students in ${sec.label} yet, so there is no register to take.`);
  const wanted = new Map<string, AttendanceStatus>();
  for (const m of input.marks) if (isAttendanceStatus(m.status)) wanted.set(m.studentId, m.status);
  const missing = roll.filter((s) => !wanted.has(s.id));
  if (missing.length) throw new RollChangedError(missing.map((s) => s.name));

  const rollIds = roll.map((s) => s.id);
  const existing = await tx
    .select({ studentId: attendance.studentId, status: attendance.status, sectionId: attendance.sectionId })
    .from(attendance)
    .where(and(eq(attendance.date, input.date), inArray(attendance.studentId, rollIds)));
  const before = new Map(existing.map((e) => [e.studentId, e]));
  const [prevRegister] = await tx
    .select({ takenBy: attendanceRegisters.takenBy })
    .from(attendanceRegisters)
    .where(and(eq(attendanceRegisters.sectionId, sec.id), eq(attendanceRegisters.date, input.date)));

  const now = new Date();
  await tx
    .insert(attendanceRegisters)
    .values({ sectionId: sec.id, date: input.date, takenBy: actor.accountId, takenAt: now })
    .onConflictDoUpdate({ target: [attendanceRegisters.sectionId, attendanceRegisters.date], set: { takenBy: actor.accountId, takenAt: now } });

  const counts = emptyCounts();
  const fresh: (typeof attendance.$inferInsert)[] = [];
  const changedTo = new Map<AttendanceStatus, string[]>();
  const changes: { studentId: string; name: string; from: AttendanceStatus | null; to: AttendanceStatus }[] = [];
  /** Marks that are new or different: their families may get a text message. */
  const toTell: { studentId: string; status: AttendanceStatus }[] = [];
  for (const s of roll) {
    const status = wanted.get(s.id)!;
    counts[status]++;
    const old = before.get(s.id);
    if (!old) {
      fresh.push({ studentId: s.id, date: input.date, sectionId: sec.id, status, markedBy: actor.accountId, markedAt: now });
      if (prevRegister) changes.push({ studentId: s.id, name: s.name, from: null, to: status });
      toTell.push({ studentId: s.id, status });
    } else if (old.status !== status || old.sectionId !== sec.id) {
      changedTo.set(status, [...(changedTo.get(status) ?? []), s.id]);
      if (old.status !== status) {
        changes.push({ studentId: s.id, name: s.name, from: old.status, to: status });
        toTell.push({ studentId: s.id, status });
      }
    }
  }
  if (fresh.length) {
    // Upsert, so two people saving the same register at once can't fail on a duplicate.
    await tx
      .insert(attendance)
      .values(fresh)
      .onConflictDoUpdate({
        target: [attendance.studentId, attendance.date],
        set: { status: sql`excluded.status`, sectionId: sql`excluded.section_id`, markedBy: sql`excluded.marked_by`, markedAt: sql`excluded.marked_at` },
      });
  }
  for (const [status, ids] of changedTo) {
    await tx
      .update(attendance)
      .set({ status, sectionId: sec.id, markedBy: actor.accountId, markedAt: now })
      .where(and(eq(attendance.date, input.date), inArray(attendance.studentId, ids)));
  }

  await audit(tx, actor, prevRegister ? "attendance.changed" : "attendance.taken", {
    schoolId: sec.schoolId,
    targetType: "section",
    targetId: sec.id,
    details: { section: sec.label, date: input.date, counts, ...(prevRegister ? { changes } : {}) },
  });
  const sms = await queueAttendance(tx, { schoolId: sec.schoolId, date: input.date, sectionLabel: sec.label, changes: toTell, createdBy: actor.accountId });
  return { counts, changed: prevRegister ? changes.length : roll.length, firstSave: !prevRegister, sms };
}

/* ------------------------------------------------------------------ */
/* Reading registers                                                   */
/* ------------------------------------------------------------------ */

export type RegisterView = {
  /** Null until the register has been saved for this day. */
  register: { takenAt: Date; takenBy: Person } | null;
  students: (RollStudent & { status: AttendanceStatus | null })[];
  counts: StatusCounts;
};

/** One section's register for one day: the roll with each student's saved mark (if any). */
export async function registerView(sectionId: string, date: string): Promise<RegisterView> {
  const db = await getDb();
  const roll = await sectionRoll(db, sectionId);
  const [reg] = await db
    .select({ takenAt: attendanceRegisters.takenAt, takenBy: attendanceRegisters.takenBy })
    .from(attendanceRegisters)
    .where(and(eq(attendanceRegisters.sectionId, sectionId), eq(attendanceRegisters.date, date)));
  const marks = roll.length
    ? await db
        .select({ studentId: attendance.studentId, status: attendance.status })
        .from(attendance)
        .where(
          and(
            eq(attendance.date, date),
            inArray(
              attendance.studentId,
              roll.map((s) => s.id),
            ),
          ),
        )
    : [];
  const byStudent = new Map(marks.map((m) => [m.studentId, m.status]));
  const counts = emptyCounts();
  const list = roll.map((s) => {
    const status = byStudent.get(s.id) ?? null;
    if (status) counts[status]++;
    return { ...s, status };
  });
  const people = reg ? await peopleByAccount([reg.takenBy]) : new Map<string, Person>();
  return {
    register: reg ? { takenAt: reg.takenAt, takenBy: people.get(reg.takenBy) ?? { name: "Unknown", loginId: "" } } : null,
    students: list,
    counts,
  };
}

/** Dates (between from and to) on which a section's register was taken. */
export async function registerDates(sectionId: string, from: string, to: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db
    .select({ date: attendanceRegisters.date })
    .from(attendanceRegisters)
    .where(and(eq(attendanceRegisters.sectionId, sectionId), gte(attendanceRegisters.date, from), lte(attendanceRegisters.date, to)));
  return new Set(rows.map((r) => r.date));
}

export type RegisterStatusRow = {
  sectionId: string;
  /** "V-A" */
  label: string;
  /** "Class V, section A" */
  longLabel: string;
  classTeacherName: string | null;
  /** Students on the roll now. */
  studentCount: number;
  taken: boolean;
  takenBy: Person | null;
  takenAt: Date | null;
  /** Marks saved that day (all zero when not taken). */
  counts: StatusCounts;
};

/**
 * Every section of a school (in the current session unless one is given)
 * with whether its register was taken on `date`, who took it and the counts.
 * Sections are in class order.
 */
export async function registersStatus(schoolId: string, date: string, sessionId?: string): Promise<RegisterStatusRow[]> {
  const db = await getDb();
  const sid = sessionId ?? (await currentSessionIdOf(db));
  const secs = await db
    .select({
      id: sections.id,
      name: sections.name,
      className: classes.name,
      stream: classes.stream,
      classTeacherName: staff.name,
    })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(staff, eq(staff.id, sections.classTeacherId))
    .where(and(eq(classes.schoolId, schoolId), eq(sections.sessionId, sid)))
    .orderBy(asc(classes.sortOrder), asc(sections.name));
  if (!secs.length) return [];
  const ids = secs.map((s) => s.id);
  const [regs, marks, sizes] = await Promise.all([
    db
      .select({ sectionId: attendanceRegisters.sectionId, takenAt: attendanceRegisters.takenAt, takenBy: attendanceRegisters.takenBy })
      .from(attendanceRegisters)
      .where(and(eq(attendanceRegisters.date, date), inArray(attendanceRegisters.sectionId, ids))),
    db
      .select({ sectionId: attendance.sectionId, status: attendance.status, n: count() })
      .from(attendance)
      .where(and(eq(attendance.date, date), inArray(attendance.sectionId, ids)))
      .groupBy(attendance.sectionId, attendance.status),
    db
      .select({ sectionId: enrolments.sectionId, n: count() })
      .from(enrolments)
      .innerJoin(students, eq(students.id, enrolments.studentId))
      .where(and(inArray(enrolments.sectionId, ids), eq(students.status, "active")))
      .groupBy(enrolments.sectionId),
  ]);
  const people = await peopleByAccount(regs.map((r) => r.takenBy));
  const regBy = new Map(regs.map((r) => [r.sectionId, r]));
  const sizeBy = new Map(sizes.map((s) => [s.sectionId, Number(s.n)]));
  const countsBy = new Map<string, StatusCounts>();
  for (const m of marks) {
    const c = countsBy.get(m.sectionId) ?? emptyCounts();
    c[m.status] += Number(m.n);
    countsBy.set(m.sectionId, c);
  }
  return secs.map((s) => {
    const reg = regBy.get(s.id);
    return {
      sectionId: s.id,
      label: sectionLabel(s.className, s.name),
      longLabel: `${classLabel(s.className, s.stream)}, section ${s.name}`,
      classTeacherName: s.classTeacherName,
      studentCount: sizeBy.get(s.id) ?? 0,
      taken: !!reg,
      takenBy: reg ? (people.get(reg.takenBy) ?? null) : null,
      takenAt: reg?.takenAt ?? null,
      counts: reg ? (countsBy.get(s.id) ?? emptyCounts()) : emptyCounts(),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Per-student figures                                                 */
/* ------------------------------------------------------------------ */

/** A student's marks that count (their section's register was taken that day), between two dates. */
async function countedMarks(studentIds: string[], from: string, to: string) {
  if (!studentIds.length) return [];
  const db = await getDb();
  return db
    .select({ studentId: attendance.studentId, date: attendance.date, status: attendance.status })
    .from(attendance)
    .innerJoin(attendanceRegisters, and(eq(attendanceRegisters.sectionId, attendance.sectionId), eq(attendanceRegisters.date, attendance.date)))
    .where(and(inArray(attendance.studentId, studentIds), gte(attendance.date, from), lte(attendance.date, to)))
    .orderBy(asc(attendance.date));
}

async function countsByStudent(studentIds: string[], from: string, to: string): Promise<Map<string, StatusCounts>> {
  const out = new Map<string, StatusCounts>();
  if (!studentIds.length) return out;
  const db = await getDb();
  const rows = await db
    .select({ studentId: attendance.studentId, status: attendance.status, n: count() })
    .from(attendance)
    .innerJoin(attendanceRegisters, and(eq(attendanceRegisters.sectionId, attendance.sectionId), eq(attendanceRegisters.date, attendance.date)))
    .where(and(inArray(attendance.studentId, studentIds), gte(attendance.date, from), lte(attendance.date, to)))
    .groupBy(attendance.studentId, attendance.status);
  for (const r of rows) {
    const c = out.get(r.studentId) ?? emptyCounts();
    c[r.status] += Number(r.n);
    out.set(r.studentId, c);
  }
  return out;
}

/**
 * A student's attendance for a session (optionally narrowed to a date range
 * inside it): { percent, present, absent, late, leave, days }.
 * `percent` is null until at least one register has been taken.
 */
export async function attendanceSummary(studentId: string, sessionId: string, range?: { from?: string; to?: string }): Promise<AttendanceSummary> {
  const b = await sessionBounds(sessionId);
  const from = range?.from ? maxIso(range.from, b.startsOn) : b.startsOn;
  const to = range?.to ? minIso(range.to, b.endsOn) : b.endsOn;
  const counts = (await countsByStudent([studentId], from, to)).get(studentId) ?? emptyCounts();
  return summarise(counts);
}

/** A student's counted marks between two dates, oldest first (for the family calendar). */
export async function studentMarks(studentId: string, from: string, to: string): Promise<{ date: string; status: AttendanceStatus }[]> {
  return (await countedMarks([studentId], from, to)).map((r) => ({ date: r.date, status: r.status }));
}

export type MonthGridStudent = RollStudent & {
  marks: Record<string, AttendanceStatus>;
  month: AttendanceSummary;
  session: AttendanceSummary;
};

/**
 * A section's month: every day of the month, the days its register was
 * taken, and for each student on the roll their marks with month and
 * session figures.
 */
export async function sectionMonthGrid(
  sectionId: string,
  month: string,
  sessionId: string,
): Promise<{ days: string[]; registerDays: Set<string>; students: MonthGridStudent[] } | null> {
  const range = monthRange(month);
  if (!range) return null;
  const db = await getDb();
  const b = await sessionBounds(sessionId);
  const roll = await sectionRoll(db, sectionId);
  const ids = roll.map((s) => s.id);
  const [regDays, marks, monthCounts, sessionCounts] = await Promise.all([
    registerDates(sectionId, range.first, range.last),
    countedMarks(ids, range.first, range.last),
    countsByStudent(ids, range.first, range.last),
    countsByStudent(ids, b.startsOn, b.endsOn),
  ]);
  const byStudent = new Map<string, Record<string, AttendanceStatus>>();
  for (const m of marks) {
    const rec = byStudent.get(m.studentId) ?? {};
    rec[m.date] = m.status;
    byStudent.set(m.studentId, rec);
  }
  return {
    days: eachDay(range.first, range.last),
    registerDays: regDays,
    students: roll.map((s) => ({
      ...s,
      marks: byStudent.get(s.id) ?? {},
      month: summarise(monthCounts.get(s.id) ?? emptyCounts()),
      session: summarise(sessionCounts.get(s.id) ?? emptyCounts()),
    })),
  };
}

/** The last few registers saved for a section (newest first), e.g. for a teacher's home page. */
export async function recentRegisters(sectionId: string, limit = 5): Promise<{ date: string; takenAt: Date }[]> {
  const db = await getDb();
  return db
    .select({ date: attendanceRegisters.date, takenAt: attendanceRegisters.takenAt })
    .from(attendanceRegisters)
    .where(eq(attendanceRegisters.sectionId, sectionId))
    .orderBy(desc(attendanceRegisters.date))
    .limit(limit);
}
