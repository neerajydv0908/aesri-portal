"use server";

import { notFound } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/lib/db/client";
import { auditActor, canManageSection, canTeach } from "@/lib/auth/dal";
import { teacherPage } from "@/lib/page";
import { done, fail, messageOf, type FormState } from "@/lib/forms";
import { str } from "@/lib/validation";
import { formatDateTime } from "@/lib/dates";
import { parseMarkInput } from "@/components/exams/rules";
import { RecordError, getExam, isUuid, marksSheet, saveMarks, submitResults, type MarkEntry } from "@/lib/services/exams";

/** Save the marks grid for one section and subject (only the rows that changed). */
export async function saveMarksAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await teacherPage();
  const examId = str(formData, "exam");
  const sectionId = str(formData, "section");
  const subjectId = str(formData, "subject");
  // The section must be one of this person's (and this school's and session's), and they must teach the subject there.
  if (!ctx.sections.some((s) => s.id === sectionId) || !isUuid(subjectId) || !(await canTeach(ctx.actor, sectionId, subjectId))) notFound();
  const exam = await getExam(ctx, examId);
  if (!exam) notFound();
  const sheet = await marksSheet(ctx, exam.id, sectionId, subjectId);
  if (!sheet) return fail(`This subject has no paper in ${exam.name} for this class. Ask the office to set the maximum marks first.`);
  if (sheet.state.status === "published") {
    return fail(`These results were published on ${formatDateTime(sheet.state.publishedAt)}, so marks are locked. Ask the office to reopen them if a correction is needed.`);
  }

  const max = sheet.paper.maxMarks;
  const inGrid = new Set(sheet.rows.map((r) => r.studentId));
  for (const key of formData.keys()) {
    const m = /^[moa]:(.*)$/.exec(key);
    if (m && !inGrid.has(m[1])) return fail("Some rows don't belong to this class any more. Reload the page and try again.");
  }

  const errors: Record<string, string> = {};
  const entries: MarkEntry[] = [];
  for (const row of sheet.rows) {
    const id = row.studentId;
    if (!formData.has(`o:${id}`)) continue; // not in the grid that was saved (e.g. joined since)
    const raw = str(formData, `m:${id}`);
    const absent = formData.get(`a:${id}`) === "on";
    const before = str(formData, `o:${id}`);
    if ((absent ? "AB" : raw) === before) continue; // unchanged
    const p = parseMarkInput(raw, absent, max);
    if (!p.ok) {
      errors[`m:${id}`] = p.error;
      continue;
    }
    entries.push({ studentId: id, tenths: p.tenths, absent: p.absent });
  }
  const bad = Object.keys(errors).length;
  if (bad) return fail(`Nothing was saved. ${bad === 1 ? "One entry needs" : `${bad} entries need`} fixing — ${bad === 1 ? "it is" : "they are"} marked below.`, errors);
  if (!entries.length) return done("No changes to save.");

  let result;
  try {
    const db = await getDb();
    const actor = await auditActor(ctx.actor);
    result = await db.transaction((tx) => saveMarks(tx, ctx, { examId: exam.id, sectionId, subjectId }, entries, actor));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  refresh();
  const left = result.students - result.done;
  return done(`Saved ${sheet.paper.name} marks. ${result.done} of ${result.students} students done${left ? `, ${left} still to enter` : " — this list is complete"}.`);
}

/** The class teacher (or an admin) sends the section's results to the office. */
export async function sendToOfficeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await teacherPage();
  const examId = str(formData, "exam");
  const sectionId = str(formData, "section");
  if (!ctx.sections.some((s) => s.id === sectionId) || !(await canManageSection(ctx.actor, sectionId, "class_teacher"))) notFound();
  const exam = await getExam(ctx, examId);
  if (!exam) notFound();
  let state;
  try {
    const db = await getDb();
    const actor = await auditActor(ctx.actor);
    state = await db.transaction((tx) => submitResults(tx, ctx, exam.id, sectionId, actor));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  refresh();
  return done(
    state.missing
      ? `Sent to the office, with ${state.missing} ${state.missing === 1 ? "mark" : "marks"} still missing (${state.subjectsMissing.map((s) => s.subject).join(", ")}). Teachers can still fill them in until the results are published.`
      : "Sent to the office. They will check and publish the results to families.",
  );
}
