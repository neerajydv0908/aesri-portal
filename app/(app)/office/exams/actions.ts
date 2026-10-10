"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/lib/db/client";
import { auditActor } from "@/lib/auth/dal";
import { officePage } from "@/lib/page";
import { done, fail, messageOf, type FormState } from "@/lib/forms";
import { cleanText, str } from "@/lib/validation";
import { ExamFieldError, RecordError, createExam, deleteExam, getExam, updateExam } from "@/lib/services/exams";

function readExamFields(formData: FormData) {
  const name = cleanText(str(formData, "name"), 80) ?? "";
  const orderText = str(formData, "order");
  const order = /^\d{1,2}$/.test(orderText) ? Number(orderText) : NaN;
  const fields: Record<string, string> = {};
  if (name.length < 2 || name.length > 60) fields.name = "Type a name of 2 to 60 characters, such as “Unit Test 1” or “Half-yearly”.";
  if (!(order >= 1 && order <= 99)) fields.order = "Use a whole number from 1 to 99 (1 = first exam of the year).";
  return { name, order, fields };
}

/** Problems with the boxes: each message goes next to its box; one problem is also repeated at the top. */
function checkBoxes(fields: Record<string, string>): FormState {
  const messages = Object.values(fields);
  return fail(messages.length === 1 ? messages[0] : "Please check the highlighted boxes.", fields);
}

/** An error from the service, next to the box it is about (a name already in use, for example). */
function failFrom(err: unknown): FormState {
  if (err instanceof ExamFieldError) return fail(err.message, { [err.field]: err.message });
  return fail(messageOf(err, [RecordError]));
}

/** Add an exam, then go straight to setting its papers. */
export async function createExamAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const { name, order, fields } = readExamFields(formData);
  if (Object.keys(fields).length) return checkBoxes(fields);
  let id: string;
  try {
    const db = await getDb();
    const actor = await auditActor(ctx.actor);
    ({ id } = await db.transaction((tx) => createExam(tx, ctx, { name, sortOrder: order }, actor)));
  } catch (err) {
    return failFrom(err);
  }
  redirect(`/office/exams/${id}?tab=papers&added=1`);
}

export async function updateExamAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const exam = await getExam(ctx, str(formData, "exam"));
  if (!exam) return fail("That exam was not found. Reload the page and try again.");
  const { name, order, fields } = readExamFields(formData);
  if (Object.keys(fields).length) return checkBoxes(fields);
  try {
    const db = await getDb();
    const actor = await auditActor(ctx.actor);
    await db.transaction((tx) => updateExam(tx, ctx, exam.id, { name, sortOrder: order }, actor));
  } catch (err) {
    return failFrom(err);
  }
  refresh();
  return done(exam.name === name ? `Saved “${name}”.` : `Renamed “${exam.name}” to “${name}”.`);
}

export async function deleteExamAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const exam = await getExam(ctx, str(formData, "exam"));
  if (!exam) return fail("That exam was not found. Reload the page and try again.");
  try {
    const db = await getDb();
    const actor = await auditActor(ctx.actor);
    await db.transaction((tx) => deleteExam(tx, ctx, exam.id, actor));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  refresh();
  return done(`Deleted “${exam.name}”.`);
}
