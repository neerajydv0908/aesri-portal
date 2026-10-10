/** The student behind a "Needs support" page, with the access checks (server only). */
import "server-only";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { enrolments } from "@/lib/db/schema";
import { canManageSection, canSeeStudent } from "@/lib/auth/dal";
import { todayIST } from "@/lib/dates";
import type { TeacherContext } from "@/lib/page";
import { isUuid } from "@/lib/services/exams";
import { staffRemarkReader } from "@/lib/services/remarks";
import { schoolSupportRule, schoolThresholds, sectionFigures } from "@/lib/queries/student-figures";
import { sectionEstimates, supportContext } from "@/lib/studai/estimates";
import { supportStatus } from "@/lib/support/rules";

/**
 * A student this person may see in "Needs support": on the roll of a section
 * they are class teacher of (admins: any section of the school). Anyone else
 * is "not found".
 */
export async function supportStudent(ctx: TeacherContext, studentId: string) {
  if (!isUuid(studentId)) notFound();
  const db = await getDb();
  const [enr] = await db
    .select({ sectionId: enrolments.sectionId })
    .from(enrolments)
    .where(and(eq(enrolments.studentId, studentId), eq(enrolments.sessionId, ctx.sessionId)));
  const allowed = ctx.isAdmin ? ctx.sections : ctx.classTeacherSections;
  const section = enr ? allowed.find((s) => s.id === enr.sectionId) : undefined;
  if (!section || !(await canManageSection(ctx.actor, section.id, "class_teacher")) || !(await canSeeStudent(ctx.actor, studentId))) notFound();
  const [thresholds, rule] = await Promise.all([schoolThresholds(ctx.schoolId), schoolSupportRule(ctx.schoolId)]);
  const today = todayIST();
  const [{ students, figures }, estimates] = await Promise.all([
    sectionFigures(ctx, section, { today, reader: staffRemarkReader(ctx), passPercent: thresholds.passPercent, studentIds: [studentId], concernDays: rule.concernDays }),
    sectionEstimates(ctx, section, { today, studentIds: [studentId] }),
  ]);
  const student = students[0];
  if (!student) notFound();
  const f = figures.get(student.id)!;
  const mine = estimates.byStudent.get(student.id) ?? { subjects: [], inputs: [], outdated: false };
  return {
    section,
    student,
    figures: f,
    estimates: mine,
    estimatesStatus: estimates.status,
    status: supportStatus(f, mine.subjects, rule, thresholds.passPercent, supportContext(mine, estimates.status, estimates.trained)),
    thresholds,
    rule,
  };
}
