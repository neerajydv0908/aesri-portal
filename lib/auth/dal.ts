/**
 * Data Access Layer: the one place that decides who is signed in and what
 * they may see. Pages and Server Actions call these helpers before reading
 * or changing anything — hiding a button is never the only protection.
 */
import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { academicSessions, classes, enrolments, schools, sections, staff, students, teachingAssignments } from "@/lib/db/schema";
import { displayLoginId } from "@/lib/ids";
import { needsTwoFactor } from "@/lib/roles";
import { clientIp, readSession, type Role } from "./session";

export type { Role };

export type Actor = {
  sessionId: string;
  accountId: string;
  role: Role;
  loginId: string;
  schoolId: string | null;
  studentId: string | null;
  staffId: string | null;
  name: string;
  mfaPassed: boolean;
  totpEnabled: boolean;
};

/** Admin-type accounts must pass two-factor sign-in (see lib/roles.ts). */
export const isAdminRole = (role: Role) => needsTwoFactor(role);

export const getActor = cache(async (): Promise<Actor | null> => actorOf(await readSession()));

/**
 * The signed-in person, for a request the page makes by itself (the menu's
 * counts): the same checks, but the session isn't extended, so a tab left
 * open never keeps someone signed in.
 */
export const peekActor = cache(async (): Promise<Actor | null> => actorOf(await readSession({ touch: false })));

async function actorOf(rec: Awaited<ReturnType<typeof readSession>>): Promise<Actor | null> {
  if (!rec) return null;
  const { account, session } = rec;
  const db = await getDb();
  let name = account.displayName ?? displayLoginId(account.loginId);
  if (account.studentId) {
    const [s] = await db.select({ name: students.name }).from(students).where(eq(students.id, account.studentId));
    if (s) name = s.name;
  } else if (account.staffId) {
    const [s] = await db.select({ name: staff.name }).from(staff).where(eq(staff.id, account.staffId));
    if (s) name = s.name;
  }
  return {
    sessionId: session.id,
    accountId: account.id,
    role: account.role,
    loginId: displayLoginId(account.loginId),
    schoolId: account.schoolId,
    studentId: account.studentId,
    staffId: account.staffId,
    name,
    mfaPassed: session.mfaPassed,
    totpEnabled: account.totpEnabled,
  };
}

/** Signed-in person, fully verified (two-factor done for admins). Redirects otherwise. */
export async function requireActor(roles?: Role[]): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (isAdminRole(actor.role) && !actor.mfaPassed) redirect(actor.totpEnabled ? "/login/2fa" : "/setup-2fa");
  if (roles && !roles.includes(actor.role)) redirect("/home");
  return actor;
}

export async function auditActor(actor: Actor | null) {
  return { accountId: actor?.accountId ?? null, loginId: actor?.loginId ?? null, ip: await clientIp() };
}

/* ------------------------------------------------------------------ */
/* School context                                                      */
/* ------------------------------------------------------------------ */

export const SCHOOL_COOKIE = "aesri_school";

/**
 * The school an office page works on: the admin's own school, or — for an
 * AESRI admin — the school chosen in the switcher.
 */
export async function officeSchoolId(actor: Actor): Promise<string> {
  if (actor.role === "super_admin") {
    const chosen = (await cookies()).get(SCHOOL_COOKIE)?.value;
    const db = await getDb();
    const all = await db.select({ id: schools.id }).from(schools).orderBy(schools.id);
    if (chosen && all.some((s) => s.id === chosen)) return chosen;
    if (all[0]) return all[0].id;
    notFound();
  }
  if (!actor.schoolId) notFound();
  return actor.schoolId;
}

/** 404 unless the actor may work on this school's records. */
export function assertSchool(actor: Actor, schoolId: string | null | undefined): void {
  if (!schoolId) notFound();
  if (actor.role === "super_admin") return;
  if (actor.schoolId !== schoolId) notFound();
}

export const currentSessionId = cache(async (): Promise<string> => {
  const db = await getDb();
  const [s] = await db.select({ id: academicSessions.id }).from(academicSessions).where(eq(academicSessions.isCurrent, true));
  if (!s) throw new Error("No current academic session. Run `npm run setup`.");
  return s.id;
});

/* ------------------------------------------------------------------ */
/* Teacher scope                                                       */
/* ------------------------------------------------------------------ */

export type TeacherScope = {
  /** Sections where the teacher is class teacher (attendance, remarks, homework checks). */
  classTeacherOf: string[];
  /** (section, subject) pairs the teacher teaches (marks, homework). */
  teaches: { sectionId: string; subjectId: string }[];
  /** Every section the teacher works with. */
  sectionIds: string[];
};

export const teacherScope = cache(async (staffId: string): Promise<TeacherScope> => {
  const db = await getDb();
  const sessionId = await currentSessionId();
  const [ct, ta] = await Promise.all([
    db.select({ id: sections.id }).from(sections).where(and(eq(sections.classTeacherId, staffId), eq(sections.sessionId, sessionId))),
    db
      .select({ sectionId: teachingAssignments.sectionId, subjectId: teachingAssignments.subjectId })
      .from(teachingAssignments)
      .innerJoin(sections, eq(sections.id, teachingAssignments.sectionId))
      .where(and(eq(teachingAssignments.staffId, staffId), eq(sections.sessionId, sessionId))),
  ]);
  const classTeacherOf = ct.map((r) => r.id);
  const sectionIds = [...new Set([...classTeacherOf, ...ta.map((t) => t.sectionId)])];
  return { classTeacherOf, teaches: ta, sectionIds };
});

/**
 * May this actor see this student's records?
 *  - the student's own account
 *  - school admins of the student's school (and AESRI admins)
 *  - teachers who teach or are class teacher of the student's current section
 */
export async function canSeeStudent(actor: Actor, studentId: string): Promise<boolean> {
  if (actor.role === "student") return actor.studentId === studentId;
  const db = await getDb();
  const [s] = await db.select({ schoolId: students.schoolId }).from(students).where(eq(students.id, studentId));
  if (!s) return false;
  if (actor.role === "super_admin") return true;
  if (actor.schoolId !== s.schoolId) return false;
  if (actor.role === "school_admin" || actor.role === "accounts") return true;
  if (actor.role === "teacher" && actor.staffId) {
    const scope = await teacherScope(actor.staffId);
    if (!scope.sectionIds.length) return false;
    const sessionId = await currentSessionId();
    const [e] = await db
      .select({ id: enrolments.id })
      .from(enrolments)
      .where(and(eq(enrolments.studentId, studentId), eq(enrolments.sessionId, sessionId), inArray(enrolments.sectionId, scope.sectionIds)));
    return !!e;
  }
  return false;
}

export async function requireStudentAccess(actor: Actor, studentId: string): Promise<void> {
  if (!(await canSeeStudent(actor, studentId))) notFound();
}

/** Is the teacher the class teacher of this section (or, with "any_teacher", teaching in it), or an admin of its school? */
export async function canManageSection(actor: Actor, sectionId: string, mode: "class_teacher" | "any_teacher" = "class_teacher"): Promise<boolean> {
  const sec = await sectionInfo(sectionId);
  if (!sec) return false;
  if (actor.role === "super_admin") return true;
  if (actor.role === "school_admin") return actor.schoolId === sec.schoolId;
  if (actor.role === "teacher" && actor.staffId && actor.schoolId === sec.schoolId) {
    if (sec.classTeacherId === actor.staffId) return true;
    if (mode === "any_teacher") return (await teacherScope(actor.staffId)).sectionIds.includes(sectionId);
  }
  return false;
}

export const sectionInfo = cache(async (sectionId: string) => {
  const db = await getDb();
  const [r] = await db
    .select({ schoolId: classes.schoolId, classTeacherId: sections.classTeacherId, sessionId: sections.sessionId, classId: classes.id })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(eq(sections.id, sectionId));
  return r ?? null;
});

export async function sectionSchoolId(sectionId: string): Promise<string | null> {
  return (await sectionInfo(sectionId))?.schoolId ?? null;
}

/** Can the actor teach this subject in this section (marks entry, homework)? */
export async function canTeach(actor: Actor, sectionId: string, subjectId: string | null): Promise<boolean> {
  if (actor.role === "super_admin") return true;
  if (actor.role === "school_admin") return actor.schoolId === (await sectionSchoolId(sectionId));
  if (actor.role !== "teacher" || !actor.staffId) return false;
  const scope = await teacherScope(actor.staffId);
  // "General" work (no subject) belongs to the class teacher, not to everyone who teaches a subject there.
  if (subjectId === null) return scope.classTeacherOf.includes(sectionId);
  return scope.teaches.some((t) => t.sectionId === sectionId && t.subjectId === subjectId);
}

