"use server";

import { refresh } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { enrolments } from "@/lib/db/schema";
import { auditActor, canSeeStudent } from "@/lib/auth/dal";
import { todayIST } from "@/lib/dates";
import { done, fail, messageOf, type FormState } from "@/lib/forms";
import { teacherPage, type TeacherContext } from "@/lib/page";
import { sectionStudents } from "@/lib/queries/school";
import { RecordError } from "@/lib/services/students";
import { createRemark, deleteRemark, remarkForReader, staffRemarkReader, updateRemark, validateRemark } from "@/lib/services/remarks";
import { delayWords } from "@/lib/sms/config";
import { str } from "@/lib/validation";
import { prepareHindi } from "@/lib/translate";

const fieldsFrom = (formData: FormData) => ({
  kind: formData.get("kind"),
  category: formData.get("category"),
  note: formData.get("note"),
  actionTaken: formData.get("actionTaken"),
  visibleToGuardian: formData.get("visibleToGuardian") === "yes",
});

/** The boxes' labels, in the order they appear on the form. */
const LABELS: Record<string, string> = { student: "Student", kind: "Kind of remark", category: "What it is about", note: "Remark" };

/** Each box keeps its own message; the banner above says which boxes need attention. */
function checkBoxes(errors: Record<string, string>): FormState {
  const order = Object.keys(LABELS);
  const place = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  const keys = Object.keys(errors).sort((a, b) => place(a) - place(b));
  if (keys.length <= 1) return fail(errors[keys[0]] ?? "Please check the form and try again.", errors);
  return fail(`Nothing was saved. Please check the ${keys.length} boxes marked below: ${keys.map((k) => LABELS[k] ?? k).join(", ")}.`, errors);
}

export async function createRemarkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await teacherPage();
  const section = ctx.sections.find((s) => s.id === str(formData, "section"));
  if (!section) notFound();
  const studentId = str(formData, "student");
  const student = (await sectionStudents(section.id)).find((s) => s.id === studentId);
  const v = validateRemark(fieldsFrom(formData));
  if (!student) return checkBoxes({ student: "Choose a student from this class.", ...(v.ok ? {} : v.errors) });
  if (!(await canSeeStudent(ctx.actor, student.id))) notFound();
  if (!v.ok) return checkBoxes(v.errors);

  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  const db = await getDb();
  let saved;
  try {
    saved = await db.transaction((tx) => createRemark(tx, { schoolId: ctx.schoolId, studentId: student.id, recordedOn: todayIST(), ...v.fields }, who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  // A family that reads Hindi gets the remark in Hindi: translate it now.
  if (v.fields.visibleToGuardian) await prepareHindi([v.fields.note, v.fields.actionTaken]);
  refresh();
  const kind = v.fields.kind === "appreciation" ? "Appreciation" : "Concern";
  const classTeacher = !ctx.isAdmin && ctx.classTeacherSections.some((s) => s.id === section.id);
  const staffOnly = classTeacher ? "Only you and the school office can see it." : "Only you, the class teacher and the school office can see it.";
  const sms = saved.sms;
  const smsText = sms?.queued
    ? ` They will also get a text message ${delayWords(sms.delaySeconds)} saying there is a new note (not what it says).`
    : sms?.unreachable
      ? " They don’t get text messages (no mobile number, or they asked not to)."
      : "";
  return done(`${kind} saved for ${student.name}. ${v.fields.visibleToGuardian ? `The family can see it.${smsText}` : staffOnly}`);
}

/**
 * The remark named in the form, if this person may change it: class teachers
 * and admins any remark about their class, other teachers their own — and
 * only about a student they still work with.
 */
async function manageableRemark(ctx: TeacherContext, remarkId: string) {
  const r = await remarkForReader(staffRemarkReader(ctx), ctx.schoolId, remarkId);
  if (!r) notFound();
  if (!(await canSeeStudent(ctx.actor, r.studentId))) notFound();
  return r;
}

/** Where to go back to: the student's class, if it is one of this person's. */
async function backTo(ctx: TeacherContext, studentId: string, done: string) {
  const db = await getDb();
  const [e] = await db
    .select({ sectionId: enrolments.sectionId })
    .from(enrolments)
    .where(and(eq(enrolments.studentId, studentId), eq(enrolments.sessionId, ctx.sessionId)));
  const mine = e && ctx.sections.some((s) => s.id === e.sectionId);
  return mine ? `/teach/remarks?section=${e.sectionId}&done=${done}` : `/teach/remarks?done=${done}`;
}

export async function updateRemarkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await teacherPage();
  const r = await manageableRemark(ctx, str(formData, "id"));
  const v = validateRemark(fieldsFrom(formData));
  if (!v.ok) return checkBoxes(v.errors);
  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  const db = await getDb();
  let result;
  try {
    result = await db.transaction((tx) => updateRemark(tx, ctx.schoolId, staffRemarkReader(ctx), r.id, v.fields, who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  if (v.fields.visibleToGuardian && result.changed.length) await prepareHindi([v.fields.note, v.fields.actionTaken]);
  redirect(await backTo(ctx, r.studentId, result.sms?.queued ? "shared" : result.changed.length ? "updated" : "unchanged"));
}

export async function deleteRemarkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await teacherPage();
  const r = await manageableRemark(ctx, str(formData, "id"));
  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  const db = await getDb();
  try {
    await db.transaction((tx) => deleteRemark(tx, ctx.schoolId, staffRemarkReader(ctx), r.id, who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  redirect(await backTo(ctx, r.studentId, "deleted"));
}
