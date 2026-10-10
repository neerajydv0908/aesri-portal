/**
 * Read queries for the records screens: students, staff, a teacher's class
 * lists and a family's own profile. Callers check who is asking first
 * (lib/page.ts); every query here is also filtered by school.
 */
import { lockedLoginIds, type SignInLock } from "@/lib/auth/throttle";
import "server-only";
import { and, asc, count, eq, gte, ilike, inArray, like, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import {
  accounts,
  attendance,
  attendanceRegisters,
  classes,
  enrolments,
  sections,
  staff,
  staffSubjects,
  students,
  subjects,
  teachingAssignments,
} from "@/lib/db/schema";
import { sectionLabel } from "@/lib/classes";
import { displayLoginId, normalizeLoginId } from "@/lib/ids";
import type { StaffAccess } from "@/lib/roles";
import { emptyCounts, sessionBounds, summarise, type AttendanceSummary } from "@/lib/services/attendance";

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

export type StudentStatus = "active" | "left" | "transferred" | "passed_out";
export const STUDENT_STATUSES: readonly StudentStatus[] = ["active", "left", "transferred", "passed_out"];
export const isStudentStatus = (v: unknown): v is StudentStatus => typeof v === "string" && (STUDENT_STATUSES as readonly string[]).includes(v);

/** How a sign-in account stands: not activated yet, working, or turned off ("none": no account at all). */
export type SignInStatus = "pending" | "active" | "disabled" | "none";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** IDs from URLs and forms must look like UUIDs before they reach a query. */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Text typed into a search box, made safe for LIKE (its wildcards are matched literally). */
function likeText(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export type Placement = {
  sectionId: string;
  sectionName: string;
  classId: string;
  className: string;
  stream: string | null;
  rollNo: number | null;
  label: string;
};

export type SignIn = {
  accountId: string;
  loginId: string;
  status: Exclude<SignInStatus, "none">;
  lastLoginAt: Date | null;
  lock: SignInLock | null;
};

/** Whether too many wrong tries have locked this login ID (see lib/auth/throttle.ts): why and until when. */
async function lockFor(loginId: string | null): Promise<SignInLock | null> {
  if (!loginId) return null;
  return (await lockedLoginIds(await getDb(), [loginId])).get(loginId) ?? null;
}

function toSignIn(a: { id: string | null; loginId: string | null; status: "pending" | "active" | "disabled" | null; lastLoginAt: Date | null; lock: SignInLock | null }): SignIn | null {
  if (!a.id || !a.loginId || !a.status) return null;
  return { accountId: a.id, loginId: displayLoginId(a.loginId), status: a.status, lastLoginAt: a.lastLoginAt, lock: a.status === "disabled" ? null : a.lock };
}

/* ------------------------------------------------------------------ */
/* Student list                                                        */
/* ------------------------------------------------------------------ */

export type StudentStatusFilter = StudentStatus | "all";

export type StudentListRow = {
  id: string;
  srNo: string;
  name: string;
  status: StudentStatus;
  rte: boolean;
  fatherName: string | null;
  guardianMobile: string | null;
  placement: Placement | null;
  loginId: string | null;
  signIn: SignInStatus;
};

/**
 * What the search box matches: the student's, father's, mother's or
 * guardian's name (every word typed must match one of them), the SR no.,
 * the family's login ID (Arya7634) or a mobile number (either one on record).
 */
function studentSearch(q: string, loginPrefix: string): SQL | undefined {
  const text = q.trim();
  if (!text) return undefined;
  const any: (SQL | undefined)[] = [];

  const login = /^(arya|aadhar)(\d+)$/.exec(normalizeLoginId(text));
  if (login && login[1] === loginPrefix.toLowerCase()) any.push(eq(students.srNo, login[2]));

  const digits = text.replace(/[\s\-()+.]/g, "");
  if (/^\d+$/.test(digits)) {
    const sr = String(Number(digits));
    any.push(eq(students.srNo, sr));
    if (sr.length >= 3) any.push(like(students.srNo, `${likeText(sr)}%`));
    if (digits.length >= 5) {
      const mobile = digits.replace(/^(0091|91|0)(?=\d{10}$)/, "");
      any.push(like(students.guardianMobile, `%${likeText(mobile)}%`), like(students.mobile2, `%${likeText(mobile)}%`));
    }
  } else {
    const words = text.split(/\s+/).filter(Boolean).slice(0, 6);
    any.push(
      and(
        ...words.map((w) => {
          const p = `%${likeText(w)}%`;
          return or(ilike(students.name, p), ilike(students.fatherName, p), ilike(students.motherName, p), ilike(students.guardianName, p));
        }),
      ),
    );
  }
  return or(...any);
}

export async function listStudentRecords(opts: {
  schoolId: string;
  sessionId: string;
  loginPrefix: string;
  sectionId: string | null;
  status: StudentStatusFilter;
  q: string;
  page: number;
  perPage: number;
}): Promise<{ rows: StudentListRow[]; total: number; page: number; pages: number; schoolTotal: number }> {
  const db = await getDb();
  const where = and(
    eq(students.schoolId, opts.schoolId),
    opts.status === "all" ? undefined : eq(students.status, opts.status),
    opts.sectionId ? eq(enrolments.sectionId, opts.sectionId) : undefined,
    studentSearch(opts.q, opts.loginPrefix),
  );
  const onEnrolment = and(eq(enrolments.studentId, students.id), eq(enrolments.sessionId, opts.sessionId));

  const [[{ n: total }], [{ n: schoolTotal }]] = await Promise.all([
    db.select({ n: count() }).from(students).leftJoin(enrolments, onEnrolment).where(where),
    db.select({ n: count() }).from(students).where(eq(students.schoolId, opts.schoolId)),
  ]);
  const pages = Math.max(1, Math.ceil(total / opts.perPage));
  const page = Math.min(Math.max(1, opts.page), pages);

  const rows = await db
    .select({
      id: students.id,
      srNo: students.srNo,
      name: students.name,
      status: students.status,
      rte: students.rte,
      fatherName: students.fatherName,
      guardianMobile: students.guardianMobile,
      sectionId: sections.id,
      sectionName: sections.name,
      classId: classes.id,
      className: classes.name,
      stream: classes.stream,
      rollNo: enrolments.rollNo,
      accountId: accounts.id,
      loginId: accounts.loginId,
      accountStatus: accounts.status,
    })
    .from(students)
    .leftJoin(enrolments, onEnrolment)
    .leftJoin(sections, eq(sections.id, enrolments.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(accounts, eq(accounts.studentId, students.id))
    .where(where)
    .orderBy(asc(classes.sortOrder), asc(sections.name), asc(enrolments.rollNo), asc(students.name), asc(students.id))
    .limit(opts.perPage)
    .offset((page - 1) * opts.perPage);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      srNo: r.srNo,
      name: r.name,
      status: r.status,
      rte: r.rte,
      fatherName: r.fatherName,
      guardianMobile: r.guardianMobile,
      placement:
        r.sectionId && r.classId && r.className && r.sectionName
          ? {
              sectionId: r.sectionId,
              sectionName: r.sectionName,
              classId: r.classId,
              className: r.className,
              stream: r.stream,
              rollNo: r.rollNo,
              label: sectionLabel(r.className, r.sectionName),
            }
          : null,
      loginId: r.loginId ? displayLoginId(r.loginId) : null,
      signIn: r.accountStatus ?? "none",
    })),
    total: Number(total),
    page,
    pages,
    schoolTotal: Number(schoolTotal),
  };
}

/* ------------------------------------------------------------------ */
/* One student                                                         */
/* ------------------------------------------------------------------ */

export type StudentRecord = typeof students.$inferSelect & { placement: Placement | null; signIn: SignIn | null };

/** A student of this school with this session's class and their family's sign-in (null if not this school's). */
export async function studentRecord(schoolId: string, sessionId: string, studentId: string): Promise<StudentRecord | null> {
  if (!isUuid(studentId)) return null;
  const db = await getDb();
  const [r] = await db
    .select({
      student: students,
      sectionId: sections.id,
      sectionName: sections.name,
      classId: classes.id,
      className: classes.name,
      stream: classes.stream,
      rollNo: enrolments.rollNo,
      accountId: accounts.id,
      loginId: accounts.loginId,
      accountStatus: accounts.status,
      lastLoginAt: accounts.lastLoginAt,
    })
    .from(students)
    .leftJoin(enrolments, and(eq(enrolments.studentId, students.id), eq(enrolments.sessionId, sessionId)))
    .leftJoin(sections, eq(sections.id, enrolments.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(accounts, eq(accounts.studentId, students.id))
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)));
  if (!r) return null;
  return {
    ...r.student,
    placement:
      r.sectionId && r.classId && r.className && r.sectionName
        ? { sectionId: r.sectionId, sectionName: r.sectionName, classId: r.classId, className: r.className, stream: r.stream, rollNo: r.rollNo, label: sectionLabel(r.className, r.sectionName) }
        : null,
    signIn: toSignIn({ id: r.accountId, loginId: r.loginId, status: r.accountStatus, lastLoginAt: r.lastLoginAt, lock: await lockFor(r.loginId) }),
  };
}

/** Other current students of a section who have this roll number. */
export async function sameRollNo(tx: Tx, sectionId: string, rollNo: number, exceptStudentId: string | null): Promise<{ id: string; name: string }[]> {
  return tx
    .select({ id: students.id, name: students.name })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(
      and(
        eq(enrolments.sectionId, sectionId),
        eq(enrolments.rollNo, rollNo),
        eq(students.status, "active"),
        exceptStudentId ? ne(students.id, exceptStudentId) : undefined,
      ),
    )
    .orderBy(asc(students.name));
}

/** The student with this SR no. at the school, if any. */
export async function studentBySrNo(schoolId: string, srNo: string): Promise<{ id: string; name: string } | null> {
  const db = await getDb();
  const [s] = await db
    .select({ id: students.id, name: students.name })
    .from(students)
    .where(and(eq(students.schoolId, schoolId), eq(students.srNo, srNo)));
  return s ?? null;
}

/** The family's own details (for /my/profile). */
export async function familyRecord(studentId: string) {
  const db = await getDb();
  const [s] = await db
    .select({
      name: students.name,
      srNo: students.srNo,
      dob: students.dob,
      fatherName: students.fatherName,
      motherName: students.motherName,
      guardianName: students.guardianName,
      guardianMobile: students.guardianMobile,
      mobile2: students.mobile2,
      address: students.address,
      rte: students.rte,
    })
    .from(students)
    .where(eq(students.id, studentId));
  return s ?? null;
}

/* ------------------------------------------------------------------ */
/* A teacher's class list                                              */
/* ------------------------------------------------------------------ */

export type RosterRow = {
  id: string;
  name: string;
  srNo: string;
  rollNo: number | null;
  /** Only for the class teacher (and admins). */
  contact: { fatherName: string | null; guardianMobile: string | null } | null;
  attendance: AttendanceSummary | null;
};

/**
 * Current students of a section, by roll number then name. With
 * `classTeacher`, also the father's name, the parent's mobile and each
 * student's attendance this session (counted in one grouped query).
 */
export async function sectionRoster(sectionId: string, sessionId: string, classTeacher: boolean): Promise<RosterRow[]> {
  const db = await getDb();
  const roll = await db
    .select({
      id: students.id,
      name: students.name,
      srNo: students.srNo,
      rollNo: enrolments.rollNo,
      fatherName: students.fatherName,
      guardianMobile: students.guardianMobile,
    })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(and(eq(enrolments.sectionId, sectionId), eq(enrolments.sessionId, sessionId), eq(students.status, "active")))
    .orderBy(asc(enrolments.rollNo), asc(students.name));
  if (!classTeacher) return roll.map((r) => ({ id: r.id, name: r.name, srNo: r.srNo, rollNo: r.rollNo, contact: null, attendance: null }));

  const counts = new Map<string, ReturnType<typeof emptyCounts>>();
  if (roll.length) {
    const b = await sessionBounds(sessionId);
    const rows = await db
      .select({ studentId: attendance.studentId, status: attendance.status, n: count() })
      .from(attendance)
      .innerJoin(attendanceRegisters, and(eq(attendanceRegisters.sectionId, attendance.sectionId), eq(attendanceRegisters.date, attendance.date)))
      .where(
        and(
          inArray(
            attendance.studentId,
            roll.map((r) => r.id),
          ),
          gte(attendance.date, b.startsOn),
          lte(attendance.date, b.endsOn),
        ),
      )
      .groupBy(attendance.studentId, attendance.status);
    for (const r of rows) {
      const c = counts.get(r.studentId) ?? emptyCounts();
      c[r.status] += Number(r.n);
      counts.set(r.studentId, c);
    }
  }
  return roll.map((r) => ({
    id: r.id,
    name: r.name,
    srNo: r.srNo,
    rollNo: r.rollNo,
    contact: { fatherName: r.fatherName, guardianMobile: r.guardianMobile },
    attendance: summarise(counts.get(r.id) ?? emptyCounts()),
  }));
}

/* ------------------------------------------------------------------ */
/* Staff                                                               */
/* ------------------------------------------------------------------ */

export type StaffStatusFilter = "active" | "left" | "all";

export type StaffListRow = {
  id: string;
  empNo: string;
  name: string;
  designation: string | null;
  access: StaffAccess;
  status: "active" | "left";
  mobile: string | null;
  loginId: string | null;
  signIn: SignInStatus;
  lastLoginAt: Date | null;
  classTeacherOf: { id: string; label: string }[];
  subjects: string[];
};

/** Employee numbers in number order ("2" before "10"), whatever was typed. */
const byEmpNo = [asc(sql`length(${staff.empNo})`), asc(staff.empNo)];

export async function listStaffRecords(schoolId: string, sessionId: string, filters: { status: StaffStatusFilter; access: StaffAccess | "all" }): Promise<StaffListRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: staff.id,
      empNo: staff.empNo,
      name: staff.name,
      designation: staff.designation,
      access: staff.access,
      status: staff.status,
      mobile: staff.mobile,
      loginId: accounts.loginId,
      accountStatus: accounts.status,
      lastLoginAt: accounts.lastLoginAt,
    })
    .from(staff)
    .leftJoin(accounts, eq(accounts.staffId, staff.id))
    .where(
      and(
        eq(staff.schoolId, schoolId),
        filters.status === "all" ? undefined : eq(staff.status, filters.status),
        filters.access === "all" ? undefined : eq(staff.access, filters.access),
      ),
    )
    .orderBy(...byEmpNo);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [ct, subs] = await Promise.all([
    db
      .select({ staffId: sections.classTeacherId, id: sections.id, name: sections.name, className: classes.name })
      .from(sections)
      .innerJoin(classes, eq(classes.id, sections.classId))
      .where(and(eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId), inArray(sections.classTeacherId, ids)))
      .orderBy(asc(classes.sortOrder), asc(sections.name)),
    db
      .select({ staffId: staffSubjects.staffId, name: subjects.name })
      .from(staffSubjects)
      .innerJoin(subjects, eq(subjects.id, staffSubjects.subjectId))
      .where(inArray(staffSubjects.staffId, ids))
      .orderBy(asc(subjects.sortOrder), asc(subjects.name)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    empNo: r.empNo,
    name: r.name,
    designation: r.designation,
    access: r.access,
    status: r.status,
    mobile: r.mobile,
    loginId: r.loginId ? displayLoginId(r.loginId) : null,
    signIn: r.accountStatus ?? "none",
    lastLoginAt: r.lastLoginAt,
    classTeacherOf: ct.filter((c) => c.staffId === r.id).map((c) => ({ id: c.id, label: sectionLabel(c.className, c.name) })),
    subjects: subs.filter((s) => s.staffId === r.id).map((s) => s.name),
  }));
}

export type StaffRecord = typeof staff.$inferSelect & {
  signIn: SignIn | null;
  /** This session's sections where they are class teacher. */
  classTeacherOf: { id: string; label: string }[];
  /** This session's subject teaching, in class order: "V-A · Hindi". */
  teaching: { sectionId: string; sectionLabel: string; subjectId: string; subjectName: string }[];
  /** Subjects they teach (staffSubjects). */
  subjectIds: string[];
};

/** A staff member of this school with their sign-in and this session's duties (null if not this school's). */
export async function staffRecord(schoolId: string, sessionId: string, staffId: string): Promise<StaffRecord | null> {
  if (!isUuid(staffId)) return null;
  const db = await getDb();
  const [r] = await db
    .select({
      staff,
      accountId: accounts.id,
      loginId: accounts.loginId,
      accountStatus: accounts.status,
      lastLoginAt: accounts.lastLoginAt,
    })
    .from(staff)
    .leftJoin(accounts, eq(accounts.staffId, staff.id))
    .where(and(eq(staff.id, staffId), eq(staff.schoolId, schoolId)));
  if (!r) return null;
  const [ct, teaching, subs] = await Promise.all([
    db
      .select({ id: sections.id, name: sections.name, className: classes.name })
      .from(sections)
      .innerJoin(classes, eq(classes.id, sections.classId))
      .where(and(eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId), eq(sections.classTeacherId, staffId)))
      .orderBy(asc(classes.sortOrder), asc(sections.name)),
    db
      .select({ sectionId: sections.id, sectionName: sections.name, className: classes.name, subjectId: subjects.id, subjectName: subjects.name })
      .from(teachingAssignments)
      .innerJoin(sections, eq(sections.id, teachingAssignments.sectionId))
      .innerJoin(classes, eq(classes.id, sections.classId))
      .innerJoin(subjects, eq(subjects.id, teachingAssignments.subjectId))
      .where(and(eq(teachingAssignments.staffId, staffId), eq(sections.sessionId, sessionId), eq(classes.schoolId, schoolId)))
      .orderBy(asc(classes.sortOrder), asc(sections.name), asc(subjects.sortOrder), asc(subjects.name)),
    db.select({ subjectId: staffSubjects.subjectId }).from(staffSubjects).where(eq(staffSubjects.staffId, staffId)),
  ]);
  return {
    ...r.staff,
    signIn: toSignIn({ id: r.accountId, loginId: r.loginId, status: r.accountStatus, lastLoginAt: r.lastLoginAt, lock: await lockFor(r.loginId) }),
    classTeacherOf: ct.map((c) => ({ id: c.id, label: sectionLabel(c.className, c.name) })),
    teaching: teaching.map((t) => ({ sectionId: t.sectionId, sectionLabel: sectionLabel(t.className, t.sectionName), subjectId: t.subjectId, subjectName: t.subjectName })),
    subjectIds: subs.map((s) => s.subjectId),
  };
}

/** The staff member with this employee number at the school, if any. */
export async function staffByEmpNo(schoolId: string, empNo: string): Promise<{ id: string; name: string } | null> {
  const db = await getDb();
  const [s] = await db
    .select({ id: staff.id, name: staff.name })
    .from(staff)
    .where(and(eq(staff.schoolId, schoolId), eq(staff.empNo, empNo)));
  return s ?? null;
}
