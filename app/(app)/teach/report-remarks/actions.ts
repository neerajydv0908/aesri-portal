"use server";

import { notFound } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/lib/db/client";
import { auditActor, canManageSection } from "@/lib/auth/dal";
import { done, fail, messageOf, type FormState } from "@/lib/forms";
import { teacherPage, type TeacherContext } from "@/lib/page";
import { getExam, isUuid } from "@/lib/services/exams";
import { REPORT_REMARK_MAX, cleanRemark, saveReportRemarks, type ReportRemarkEntry } from "@/lib/services/report-remarks";
import { RecordError } from "@/lib/services/students";
import { prepareHindi } from "@/lib/translate";

/** The section, if this person writes its report-card remarks: its class teacher, or an admin. */
async function remarksSection(ctx: TeacherContext, sectionId: string) {
  const allowed = ctx.isAdmin ? ctx.sections : ctx.classTeacherSections;
  const section = allowed.find((s) => s.id === sectionId);
  if (!section || !(await canManageSection(ctx.actor, section.id, "class_teacher"))) notFound();
  return section;
}

/** Save the remarks the teacher changed (an empty box removes that student's remark). */
export async function saveReportRemarksAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await teacherPage();
  const section = await remarksSection(ctx, String(fd.get("section") ?? ""));
  const exam = await getExam(ctx, String(fd.get("exam") ?? ""));
  if (!exam) notFound();

  const entries: ReportRemarkEntry[] = [];
  const errors: Record<string, string> = {};
  for (const [key, value] of fd.entries()) {
    const m = /^r:(.+)$/.exec(key);
    if (!m || typeof value !== "string") continue;
    const studentId = m[1];
    if (!isUuid(studentId)) return fail("Some rows don't belong to this class any more. Reload the page and try again.");
    const remark = cleanRemark(value);
    if (remark && remark.length > REPORT_REMARK_MAX) errors[`r:${studentId}`] = `Shorten this remark to ${REPORT_REMARK_MAX} characters (now ${remark.length}) so it fits on the report card.`;
    entries.push({ studentId, remark });
  }
  const bad = Object.keys(errors).length;
  if (bad) return fail(`Nothing was saved. ${bad === 1 ? "One remark is" : `${bad} remarks are`} too long — see below.`, errors);
  if (!entries.length) return done("No changes to save.");

  let result;
  try {
    const db = await getDb();
    const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
    result = await db.transaction((tx) => saveReportRemarks(tx, ctx, { examId: exam.id, sectionId: section.id }, entries, who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  refresh();
  if (!result.written && !result.cleared) return done("No changes to save.");
  // Families who read Hindi see the remark in Hindi beside their report card: translate it now.
  await prepareHindi(entries.map((e) => e.remark));
  const left = result.students - result.withRemark;
  return done(
    `Saved. ${result.withRemark} of ${result.students} students in ${section.label} have a remark for ${exam.name}${left ? `; ${left} still to write` : " — every student has one"}. Families see them on the report card once the results are published.`,
  );
}
