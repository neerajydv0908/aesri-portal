/**
 * Which homework a person may set, see and change. Used by the homework
 * pages and their Server Actions, so the rules are the same everywhere.
 *
 *  - Subject teachers: the (section, subject) pairs they teach.
 *  - Class teachers: also "General" homework (no subject) for their own
 *    sections, and they can see and check all homework in those sections.
 *  - School and AESRI admins: every section and subject of the school.
 */
import "server-only";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { classSubjects, subjects } from "@/lib/db/schema";
import { canManageSection, canTeach, sectionSchoolId } from "@/lib/auth/dal";
import type { TeacherContext } from "@/lib/page";
import { teachingFor, type SectionRow } from "@/lib/queries/school";
import type { HomeworkRow } from "@/lib/services/homework";

export type HomeworkPair = {
  /** "sectionId|subjectId" or "sectionId|general" — the value used in forms. */
  key: string;
  section: SectionRow;
  subjectId: string | null;
  subjectName: string;
};

/** The (section, subject) pairs this person may set homework for, in class and subject order. */
export async function homeworkPairs(ctx: TeacherContext): Promise<HomeworkPair[]> {
  const general = (section: SectionRow): HomeworkPair => ({ key: `${section.id}|general`, section, subjectId: null, subjectName: "General (class teacher)" });
  if (ctx.isAdmin) {
    const db = await getDb();
    const rows = await db
      .select({ classId: classSubjects.classId, subjectId: subjects.id, name: subjects.name })
      .from(classSubjects)
      .innerJoin(subjects, eq(subjects.id, classSubjects.subjectId))
      .where(eq(subjects.schoolId, ctx.schoolId))
      .orderBy(asc(subjects.sortOrder), asc(subjects.name));
    return ctx.sections.flatMap((section) => [
      ...rows
        .filter((r) => r.classId === section.classId)
        .map((r) => ({ key: `${section.id}|${r.subjectId}`, section, subjectId: r.subjectId, subjectName: r.name })),
      general(section),
    ]);
  }
  const mine = (await teachingFor(ctx.sections.map((s) => s.id))).filter((t) => t.staffId === ctx.actor.staffId);
  const classTeacherOf = new Set(ctx.classTeacherSections.map((s) => s.id));
  return ctx.sections.flatMap((section) => [
    ...mine
      .filter((t) => t.sectionId === section.id)
      .sort((a, b) => a.subjectName.localeCompare(b.subjectName))
      .map((t) => ({ key: `${section.id}|${t.subjectId}`, section, subjectId: t.subjectId, subjectName: t.subjectName })),
    ...(classTeacherOf.has(section.id) ? [general(section)] : []),
  ]);
}

/** What the homework list shows: whole sections (class teachers, admins) plus the pairs someone teaches. */
export async function homeworkListScope(ctx: TeacherContext, pairs: HomeworkPair[]) {
  const sectionIds = ctx.isAdmin ? ctx.sections.map((s) => s.id) : ctx.classTeacherSections.map((s) => s.id);
  const subjectPairs = pairs
    .filter((p) => p.subjectId && !sectionIds.includes(p.section.id))
    .map((p) => ({ sectionId: p.section.id, subjectId: p.subjectId! }));
  const visibleSections = ctx.sections.filter((s) => sectionIds.includes(s.id) || subjectPairs.some((p) => p.sectionId === s.id));
  return { scope: { sectionIds, pairs: subjectPairs }, sections: visibleSections };
}

/**
 * May this person see (and check) this homework, and may they edit or
 * delete it? Everything is re-checked from the database.
 */
export async function homeworkAccess(
  ctx: TeacherContext,
  hw: Pick<HomeworkRow, "sectionId" | "subjectId" | "createdBy">,
): Promise<{ view: boolean; edit: boolean }> {
  if ((await sectionSchoolId(hw.sectionId)) !== ctx.schoolId) return { view: false, edit: false };
  if (ctx.isAdmin) return { view: true, edit: true };
  // Only this session's sections (a class someone taught last year is no longer theirs).
  if (!ctx.sections.some((s) => s.id === hw.sectionId)) return { view: false, edit: false };
  const teaches = await canTeach(ctx.actor, hw.sectionId, hw.subjectId);
  const view = teaches || (await canManageSection(ctx.actor, hw.sectionId, "class_teacher"));
  return { view, edit: view && teaches && hw.createdBy === ctx.actor.accountId };
}
