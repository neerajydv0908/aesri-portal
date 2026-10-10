/**
 * Read queries for the home page (/home): a school's numbers at a glance,
 * its recent activity, and a teacher's day. Each number is one grouped
 * query — never a query per student.
 */
import "server-only";
import { and, count, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  accounts,
  attendanceRegisters,
  auditLog,
  classSubjects,
  classes,
  enrolments,
  homework,
  homeworkChecks,
  notices,
  oneTimeCodes,
  payments,
  sections,
  staff,
  studentCharges,
  students,
  subjects,
  teachingAssignments,
} from "@/lib/db/schema";
import { peopleByAccount, type Person } from "@/lib/services/attendance";
import { OPENING_NONE_ACTION } from "@/lib/services/fees";

export type OfficeOverview = {
  /** Students studying now and placed in a class this session. */
  students: number;
  /** Current students not yet placed in a class this session. */
  studentsUnplaced: number;
  staff: number;
  /** Current staff who can sign in. */
  staffWithLogin: number;
  /** Families of current students who have set their password. */
  familiesActive: number;
  /** Sections with students, and how many of their registers were taken today. */
  registers: { taken: number; of: number };
  /** Office notices saved as drafts (or waiting for approval). */
  noticesWaiting: number;
  /** For the "Getting started" steps on the office home page. Each says how far the step really is. */
  setup: {
    /** Subjects in the school's list. */
    subjects: number;
    /** Classes from Class I up with students but no subjects (Nursery, LKG and UKG may have none). */
    classesWithoutSubjects: number;
    /** Current staff with Teacher access. */
    teachers: number;
    /** Sections with students but no class teacher. */
    sectionsWithoutClassTeacher: number;
    /** Subjects taught in sections with students that nobody teaches there yet (one per section and subject). */
    subjectTeachersMissing: number;
    /**
     * Opening balances (fees paid on paper before the portal), class by class. Of the sections whose
     * current students owe fees, a section is done once one of its students has an opening receipt this
     * session, or the office marked it as having nothing paid on paper (OPENING_NONE_ACTION).
     */
    opening: { done: number; of: number };
    /**
     * Current people who can sign in but can't yet: no activated account and no slip that still works.
     * Accounts turned off on purpose are left out. `adminStaff`: principals and office admins
     * (their slips come from the AESRI administrator).
     */
    slips: { staff: number; adminStaff: number; families: number };
  };
};

/** Pre-primary classes: the portal doesn't expect subjects for them. */
const PRE_PRIMARY = ["Nursery", "LKG", "UKG"];

/** Sections (this session) that have current students — as an SQL condition on `sections`. */
const hasCurrentStudents = sql`exists (select 1 from ${enrolments} e join ${students} s on s.id = e.student_id where e.section_id = ${sections.id} and s.status = 'active')`;

/** A school's key numbers for the office home page. */
export async function officeOverview(schoolId: string, sessionId: string, today: string): Promise<OfficeOverview> {
  const db = await getDb();
  const [studentRows, placedRows, staffRows, familyRows, sectionRows, registerRows, noticeRows, setup] = await Promise.all([
    db.select({ n: count() }).from(students).where(and(eq(students.schoolId, schoolId), eq(students.status, "active"))),
    db
      .select({ n: count() })
      .from(enrolments)
      .innerJoin(students, eq(students.id, enrolments.studentId))
      .where(and(eq(enrolments.sessionId, sessionId), eq(students.schoolId, schoolId), eq(students.status, "active"))),
    db
      .select({
        all: count(),
        login: sql<number>`count(*) filter (where ${staff.access} <> 'none')`,
        teachers: sql<number>`count(*) filter (where ${staff.access} = 'teacher')`,
      })
      .from(staff)
      .where(and(eq(staff.schoolId, schoolId), eq(staff.status, "active"))),
    db
      .select({ n: count() })
      .from(accounts)
      .innerJoin(students, eq(students.id, accounts.studentId))
      .innerJoin(enrolments, and(eq(enrolments.studentId, students.id), eq(enrolments.sessionId, sessionId)))
      .where(and(eq(students.schoolId, schoolId), eq(students.status, "active"), eq(accounts.status, "active"))),
    // Sections with current students, and whether each has a class teacher.
    db
      .select({ id: sections.id, classId: sections.classId, className: classes.name, classTeacherId: sections.classTeacherId })
      .from(sections)
      .innerJoin(classes, eq(classes.id, sections.classId))
      .where(and(eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId), hasCurrentStudents)),
    db
      .select({ sectionId: attendanceRegisters.sectionId })
      .from(attendanceRegisters)
      .innerJoin(sections, eq(sections.id, attendanceRegisters.sectionId))
      .innerJoin(classes, eq(classes.id, sections.classId))
      .where(and(eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId), eq(attendanceRegisters.date, today))),
    db
      .select({ n: count() })
      .from(notices)
      // Only the office's notices are ever drafts (class notices are posted at once), whoever they are for.
      .where(and(eq(notices.schoolId, schoolId), inArray(notices.status, ["draft", "pending"]))),
    setupProgress(schoolId, sessionId),
  ]);
  const liveSections = new Set(sectionRows.map((s) => s.id));
  const placed = Number(placedRows[0]?.n ?? 0);
  return {
    students: placed,
    studentsUnplaced: Math.max(0, Number(studentRows[0]?.n ?? 0) - placed),
    staff: Number(staffRows[0]?.all ?? 0),
    staffWithLogin: Number(staffRows[0]?.login ?? 0),
    familiesActive: Number(familyRows[0]?.n ?? 0),
    registers: { taken: new Set(registerRows.map((r) => r.sectionId).filter((id) => liveSections.has(id))).size, of: liveSections.size },
    noticesWaiting: Number(noticeRows[0]?.n ?? 0),
    setup: {
      subjects: setup.subjects,
      classesWithoutSubjects: new Set(sectionRows.filter((s) => !PRE_PRIMARY.includes(s.className)).map((s) => s.classId).filter((id) => !setup.classesWithSubjects.has(id))).size,
      teachers: Number(staffRows[0]?.teachers ?? 0),
      sectionsWithoutClassTeacher: sectionRows.filter((s) => !s.classTeacherId).length,
      subjectTeachersMissing: setup.subjectTeachersMissing,
      opening: setup.opening,
      slips: setup.slips,
    },
  };
}

export type OpeningProgress = {
  /** Sections where a current student has a fee line that isn't waived (there may be paper payments to bring forward). */
  needed: Set<string>;
  /** Sections with an opening receipt for a current student this session. */
  saved: Set<string>;
  /** Sections the office marked as having nothing paid on paper: when, and by whom. */
  markedNone: Map<string, { at: Date; by: string | null }>;
};

/**
 * How far the office is with opening balances, class by class (for the
 * Opening balances page and the "Getting started" step). A class is done
 * once opening balances are saved for it, or it is marked as having nothing
 * paid on paper.
 */
export async function openingProgress(schoolId: string, sessionId: string): Promise<OpeningProgress> {
  const db = await getDb();
  const [needed, saved, none] = await Promise.all([
    db
      .selectDistinct({ id: enrolments.sectionId })
      .from(studentCharges)
      .innerJoin(students, eq(students.id, studentCharges.studentId))
      .innerJoin(enrolments, and(eq(enrolments.studentId, studentCharges.studentId), eq(enrolments.sessionId, sessionId)))
      .where(and(eq(studentCharges.schoolId, schoolId), eq(studentCharges.sessionId, sessionId), eq(studentCharges.waived, false), eq(students.status, "active"))),
    db
      .selectDistinct({ id: enrolments.sectionId })
      .from(payments)
      .innerJoin(students, eq(students.id, payments.studentId))
      .innerJoin(enrolments, and(eq(enrolments.studentId, payments.studentId), eq(enrolments.sessionId, sessionId)))
      .where(
        and(eq(payments.schoolId, schoolId), eq(payments.sessionId, sessionId), eq(payments.method, "opening"), eq(payments.status, "completed"), eq(students.status, "active")),
      ),
    db
      .select({ id: auditLog.targetId, at: auditLog.at, by: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.schoolId, schoolId), eq(auditLog.action, OPENING_NONE_ACTION), sql`${auditLog.details}->>'sessionId' = ${sessionId}`))
      .orderBy(desc(auditLog.at)),
  ]);
  const markedNone = new Map<string, { at: Date; by: string | null }>();
  for (const r of none) if (r.id && !markedNone.has(r.id)) markedNone.set(r.id, { at: r.at, by: r.by });
  return { needed: new Set(needed.map((r) => r.id)), saved: new Set(saved.map((r) => r.id)), markedNone };
}

/** Is a section done for opening balances (or has nothing to bring forward)? */
export function openingDone(p: OpeningProgress, sectionId: string): boolean {
  return !p.needed.has(sectionId) || p.saved.has(sectionId) || p.markedNone.has(sectionId);
}

/** The numbers behind the "Getting started" steps (see OfficeOverview.setup). */
async function setupProgress(schoolId: string, sessionId: string) {
  const db = await getDb();
  /** An account that can't be used yet: pending, with no unused, uncancelled slip that is still valid. */
  const waitingForSlip = sql`(${accounts.id} is null or (${accounts.status} = 'pending' and not exists (
    select 1 from ${oneTimeCodes} o where o.account_id = ${accounts.id} and o.used_at is null and o.revoked_at is null and o.expires_at > now())))`;
  const [subjectCount, withSubjects, missingTeachers, opening, familySlips, staffSlips] = await Promise.all([
    db.select({ n: count() }).from(subjects).where(eq(subjects.schoolId, schoolId)),
    db
      .select({ classId: classSubjects.classId })
      .from(classSubjects)
      .innerJoin(classes, eq(classes.id, classSubjects.classId))
      .where(eq(classes.schoolId, schoolId))
      .groupBy(classSubjects.classId),
    // Each subject of a class, in each of its sections with students, that has no teacher there.
    db
      .select({ n: count() })
      .from(sections)
      .innerJoin(classes, eq(classes.id, sections.classId))
      .innerJoin(classSubjects, eq(classSubjects.classId, sections.classId))
      .leftJoin(teachingAssignments, and(eq(teachingAssignments.sectionId, sections.id), eq(teachingAssignments.subjectId, classSubjects.subjectId)))
      .where(and(eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId), isNull(teachingAssignments.staffId), hasCurrentStudents)),
    openingProgress(schoolId, sessionId),
    db
      .select({ n: count() })
      .from(students)
      .leftJoin(accounts, eq(accounts.studentId, students.id))
      .where(and(eq(students.schoolId, schoolId), eq(students.status, "active"), waitingForSlip)),
    db
      .select({ admin: sql<boolean>`${staff.access} in ('principal', 'office_admin')`, n: count() })
      .from(staff)
      .leftJoin(accounts, eq(accounts.staffId, staff.id))
      .where(and(eq(staff.schoolId, schoolId), eq(staff.status, "active"), ne(staff.access, "none"), waitingForSlip))
      .groupBy(sql`1`),
  ]);
  return {
    subjects: Number(subjectCount[0]?.n ?? 0),
    classesWithSubjects: new Set(withSubjects.map((r) => r.classId)),
    subjectTeachersMissing: Number(missingTeachers[0]?.n ?? 0),
    opening: { done: [...opening.needed].filter((id) => openingDone(opening, id)).length, of: opening.needed.size },
    slips: {
      staff: Number(staffSlips.find((r) => !r.admin)?.n ?? 0),
      adminStaff: Number(staffSlips.find((r) => r.admin)?.n ?? 0),
      families: Number(familySlips[0]?.n ?? 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Recent activity                                                     */
/* ------------------------------------------------------------------ */

/** What the office sees in "Recent activity": staff work, not sign-ins or payment-gateway traffic. [one, many] */
const ACTIVITY: Record<string, [string, string]> = {
  "import.completed": ["Imported students and staff from Excel", "Imported from Excel {n} times"],
  "student.created": ["Added a student", "Added {n} students"],
  "student.updated": ["Updated a student’s record", "Updated {n} students’ records"],
  "student.placed": ["Placed a student in a class", "Placed {n} students in classes"],
  "staff.created": ["Added a member of staff", "Added {n} staff"],
  "staff.updated": ["Updated a staff record", "Updated {n} staff records"],
  "staff.subjects": ["Changed a teacher’s subjects", "Changed {n} teachers’ subjects"],
  "section.class_teacher": ["Changed a class teacher", "Changed {n} class teachers"],
  "section.subject_teacher": ["Changed who teaches a subject", "Changed {n} subject teachers"],
  "section.added": ["Added a section", "Added {n} sections"],
  "section.removed": ["Removed a section", "Removed {n} sections"],
  "class.subjects": ["Changed a class’s subjects", "Changed {n} classes’ subjects"],
  "subject.added": ["Added a subject", "Added {n} subjects"],
  "subject.renamed": ["Renamed a subject", "Renamed {n} subjects"],
  "subject.removed": ["Removed a subject", "Removed {n} subjects"],
  "attendance.taken": ["Took a register", "Took {n} registers"],
  "attendance.changed": ["Changed a register", "Changed {n} registers"],
  "homework.created": ["Set homework", "Set {n} homework"],
  "homework.checked": ["Checked homework", "Checked {n} homework"],
  "remark.created": ["Recorded a remark", "Recorded {n} remarks"],
  "notice.created": ["Wrote a notice", "Wrote {n} notices"],
  "notice.published": ["Published a notice", "Published {n} notices"],
  "notice.archived": ["Archived a notice", "Archived {n} notices"],
  "marks.saved": ["Entered marks", "Entered marks"],
  "exam.created": ["Added an exam", "Added {n} exams"],
  "exam.papers_set": ["Set exam papers", "Set exam papers"],
  "exam.results_submitted": ["Sent results to the office", "Sent {n} results to the office"],
  "exam.results_published": ["Published results", "Published {n} results"],
  "exam.results_reopened": ["Reopened results", "Reopened {n} results"],
  "fees.payment": ["Recorded a fee payment", "Recorded {n} fee payments"],
  "fees.online_payment": ["A fee was paid online", "{n} fees were paid online"],
  "fees.opening_batch": ["Recorded fees paid before the portal", "Recorded fees paid before the portal"],
  "fees.payment_reversed": ["Cancelled a payment", "Cancelled {n} payments"],
  "fees.charge_waived": ["Waived a fee", "Waived {n} fees"],
  "fees.plan_split_changed": ["Changed the instalment split", "Changed the instalment split"],
  "account.activation_slip": ["Printed a sign-in slip", "Printed {n} sign-in slips"],
  "account.reset_slip": ["Printed a password reset slip", "Printed {n} reset slips"],
};

/** When one action writes several entries, show the one that says most. */
const PRIORITY = ["import.completed", "fees.opening_batch", "exam.results_published", "student.created", "staff.created"];

export type ActivityItem = {
  at: Date;
  text: string;
  /** Who did it; null for the portal itself, or when several people did the same thing. */
  by: Person | null;
  byLogin: string | null;
  several: boolean;
};

/**
 * The school's latest staff activity, newest first. Entries written together
 * (the same moment and person, e.g. an import) are one line, and a run of the
 * same kind of entry within an hour (say, several online payments) is too.
 */
export async function recentActivity(schoolId: string, limit = 8): Promise<ActivityItem[]> {
  const db = await getDb();
  const rows = await db
    .select({ at: auditLog.at, actorId: auditLog.actorId, actorLogin: auditLog.actorLogin, action: auditLog.action, n: count() })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, schoolId), inArray(auditLog.action, Object.keys(ACTIVITY))))
    .groupBy(auditLog.at, auditLog.actorId, auditLog.actorLogin, auditLog.action)
    .orderBy(desc(auditLog.at))
    .limit(limit * 12);
  // 1. One line per moment and person.
  const groups: { at: Date; actorId: string | null; actorLogin: string | null; actions: { action: string; n: number }[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.at.getTime() === r.at.getTime() && last.actorId === r.actorId) last.actions.push({ action: r.action, n: Number(r.n) });
    else groups.push({ at: r.at, actorId: r.actorId, actorLogin: r.actorLogin, actions: [{ action: r.action, n: Number(r.n) }] });
  }
  // 2. Runs of the same kind of entry within an hour become one line.
  type Line = { at: Date; action: string; n: number; actorIds: Set<string | null>; actorLogin: string | null; oldest: number };
  const lines: Line[] = [];
  for (const g of groups) {
    const main = [...g.actions].sort((a, b) => {
      const pa = PRIORITY.indexOf(a.action);
      const pb = PRIORITY.indexOf(b.action);
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || b.n - a.n;
    })[0];
    const last = lines[lines.length - 1];
    if (last && last.action === main.action && last.oldest - g.at.getTime() < 3600_000) {
      last.n += main.n;
      last.actorIds.add(g.actorId);
      last.oldest = g.at.getTime();
    } else {
      if (lines.length === limit) break;
      lines.push({ at: g.at, action: main.action, n: main.n, actorIds: new Set([g.actorId]), actorLogin: g.actorLogin, oldest: g.at.getTime() });
    }
  }
  const people = await peopleByAccount(lines.flatMap((l) => (l.actorIds.size === 1 ? [...l.actorIds] : [])));
  return lines.map((l) => {
    const [one, many] = ACTIVITY[l.action];
    const single = l.actorIds.size === 1 ? [...l.actorIds][0] : null;
    return {
      at: l.at,
      text: l.n === 1 ? one : many.replace("{n}", l.n.toLocaleString("en-IN")),
      by: single ? (people.get(single) ?? null) : null,
      byLogin: l.actorIds.size === 1 ? l.actorLogin : null,
      several: l.actorIds.size > 1,
    };
  });
}

/* ------------------------------------------------------------------ */
/* A teacher's day                                                     */
/* ------------------------------------------------------------------ */

/** Which of these sections had their register taken on `date`. */
export async function registersTakenOn(sectionIds: string[], date: string): Promise<Set<string>> {
  if (!sectionIds.length) return new Set();
  const db = await getDb();
  const rows = await db
    .select({ sectionId: attendanceRegisters.sectionId })
    .from(attendanceRegisters)
    .where(and(inArray(attendanceRegisters.sectionId, sectionIds), eq(attendanceRegisters.date, date)));
  return new Set(rows.map((r) => r.sectionId));
}

export type HomeworkToCheck = { id: string; title: string; sectionId: string; subjectName: string | null; checked: number };

/**
 * Homework due on `date` that the teacher checks: everything in their
 * class-teacher sections, and their own subjects elsewhere.
 */
export async function homeworkDueOn(scope: { sectionIds: string[]; pairs: { sectionId: string; subjectId: string }[] }, date: string): Promise<HomeworkToCheck[]> {
  const conds = [
    ...(scope.sectionIds.length ? [inArray(homework.sectionId, scope.sectionIds)] : []),
    ...scope.pairs.map((p) => and(eq(homework.sectionId, p.sectionId), eq(homework.subjectId, p.subjectId))!),
  ];
  if (!conds.length) return [];
  const db = await getDb();
  const rows = await db
    .select({ id: homework.id, title: homework.title, sectionId: homework.sectionId, subjectName: subjects.name, checked: count(homeworkChecks.studentId) })
    .from(homework)
    .leftJoin(subjects, eq(subjects.id, homework.subjectId))
    .leftJoin(homeworkChecks, eq(homeworkChecks.homeworkId, homework.id))
    .where(and(eq(homework.dueOn, date), or(...conds)))
    .groupBy(homework.id, homework.title, homework.sectionId, subjects.name, homework.createdAt)
    .orderBy(homework.createdAt)
    .limit(30);
  return rows.map((r) => ({ ...r, checked: Number(r.checked) }));
}
