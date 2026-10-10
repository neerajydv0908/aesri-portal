/**
 * The first line of every page and Server Action: who is this, which school
 * and session are we in, and are they allowed here? Each helper redirects
 * (or 404s) when the answer is no, so pages can't forget the check.
 */
import "server-only";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { classes, enrolments, schools, sections, students } from "@/lib/db/schema";
import { currentSessionId, officeSchoolId, requireActor, teacherScope, type Actor } from "@/lib/auth/dal";
import { getLang } from "@/lib/i18n/server";
import { tr, type Lang } from "@/lib/i18n";
import { listSections, type SectionRow } from "@/lib/queries/school";
import { OFFICE_ROLES, type Role } from "@/lib/roles";

export type OfficeContext = { actor: Actor; schoolId: string; sessionId: string };

/** School office pages (default: office admins and AESRI admins). */
export async function officePage(roles: Role[] = OFFICE_ROLES): Promise<OfficeContext> {
  const actor = await requireActor(roles);
  const schoolId = await officeSchoolId(actor);
  const sessionId = await currentSessionId();
  return { actor, schoolId, sessionId };
}

export type TeacherContext = OfficeContext & {
  /** Sections this person may work with: a teacher's own sections, or every section for admins. */
  sections: SectionRow[];
  /** Sections where this person is class teacher (or all, for admins): attendance, and seeing every remark about its students. */
  classTeacherSections: SectionRow[];
  isAdmin: boolean;
};

/**
 * Teaching pages (/teach/*). Teachers see their own sections; school and
 * AESRI admins see every section of the school, so they can cover for an
 * absent teacher.
 */
export async function teacherPage(): Promise<TeacherContext> {
  const actor = await requireActor(["teacher", "school_admin", "super_admin"]);
  const schoolId = await officeSchoolId(actor);
  const sessionId = await currentSessionId();
  const all = await listSections(schoolId, sessionId);
  if (actor.role !== "teacher") return { actor, schoolId, sessionId, sections: all, classTeacherSections: all, isAdmin: true };
  if (!actor.staffId) notFound();
  const scope = await teacherScope(actor.staffId);
  return {
    actor,
    schoolId,
    sessionId,
    sections: all.filter((s) => scope.sectionIds.includes(s.id)),
    classTeacherSections: all.filter((s) => scope.classTeacherOf.includes(s.id)),
    isAdmin: false,
  };
}

export type FamilyContext = {
  actor: Actor;
  lang: Lang;
  t: (en: string, hi: string) => string;
  studentId: string;
  schoolId: string;
  sessionId: string;
  student: { name: string; srNo: string; rte: boolean; status: string };
  school: { name: string; nameHi: string; phone: string | null };
  /** This session's class and section (null if not placed yet). */
  placement: { sectionId: string; sectionName: string; classId: string; className: string; stream: string | null; rollNo: number | null } | null;
};

/** Family pages (/my/*): the signed-in student's own records only. */
export async function familyPage(): Promise<FamilyContext> {
  const actor = await requireActor(["student"]);
  if (!actor.studentId || !actor.schoolId) notFound();
  const lang = await getLang();
  const sessionId = await currentSessionId();
  const db = await getDb();
  const [s] = await db
    .select({ name: students.name, srNo: students.srNo, rte: students.rte, status: students.status, schoolName: schools.name, schoolNameHi: schools.nameHi, phone: schools.phone })
    .from(students)
    .innerJoin(schools, eq(schools.id, students.schoolId))
    .where(eq(students.id, actor.studentId));
  if (!s) notFound();
  const [p] = await db
    .select({ sectionId: sections.id, sectionName: sections.name, classId: classes.id, className: classes.name, stream: classes.stream, rollNo: enrolments.rollNo })
    .from(enrolments)
    .innerJoin(sections, eq(sections.id, enrolments.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(and(eq(enrolments.studentId, actor.studentId), eq(enrolments.sessionId, sessionId)));
  return {
    actor,
    lang,
    t: tr(lang),
    studentId: actor.studentId,
    schoolId: actor.schoolId,
    sessionId,
    student: { name: s.name, srNo: s.srNo, rte: s.rte, status: s.status },
    school: { name: s.schoolName, nameHi: s.schoolNameHi, phone: s.phone },
    placement: p ?? null,
  };
}

/** Pick a section from `?section=` if the person may use it, else the first one they can. */
export function chooseSection(list: SectionRow[], requested: string | undefined | null): SectionRow | null {
  if (requested) {
    const hit = list.find((s) => s.id === requested);
    if (hit) return hit;
  }
  return list[0] ?? null;
}
