"use server";

import { refresh } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { auditActor, canTeach } from "@/lib/auth/dal";
import { done, fail, messageOf, type FormState } from "@/lib/forms";
import { teacherPage } from "@/lib/page";
import { sectionStudents } from "@/lib/queries/school";
import { RecordError } from "@/lib/services/students";
import {
  createHomework,
  deleteHomework,
  homeworkById,
  isHomeworkCheck,
  saveHomeworkChecks,
  updateHomework,
  validateHomework,
  type HomeworkCheck,
} from "@/lib/services/homework";
import { str } from "@/lib/validation";
import { homeworkAccess, homeworkPairs } from "./scope";
import { prepareHindi } from "@/lib/translate";

const fieldsFrom = (formData: FormData) => ({
  title: formData.get("title"),
  details: formData.get("details"),
  assignedOn: formData.get("assignedOn"),
  dueOn: formData.get("dueOn"),
});

export async function createHomeworkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await teacherPage();
  const pair = (await homeworkPairs(ctx)).find((p) => p.key === str(formData, "pair"));
  const v = validateHomework(fieldsFrom(formData));
  if (!pair) {
    return fail("Choose one of your classes and subjects.", { pair: "Choose a class and subject you teach.", ...(v.ok ? {} : v.errors) });
  }
  if (!(await canTeach(ctx.actor, pair.section.id, pair.subjectId))) notFound();
  if (!v.ok) return fail("Please check the highlighted boxes.", v.errors);

  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  const db = await getDb();
  let id: string;
  try {
    ({ id } = await db.transaction((tx) =>
      createHomework(tx, { schoolId: ctx.schoolId, sectionId: pair.section.id, subjectId: pair.subjectId, ...v.fields }, who),
    ));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  // Families who read Hindi get it in Hindi: translate it now, not when they open the page.
  await prepareHindi([v.fields.title, v.fields.details]);
  redirect(`/teach/homework/${id}?done=created`);
}

/** Load homework by the id in the form and check this person may change it (else "not found"). */
async function editable(formData: FormData, need: "edit" | "view") {
  const ctx = await teacherPage();
  const hw = await homeworkById(str(formData, "id"));
  if (!hw) notFound();
  const access = await homeworkAccess(ctx, hw);
  if (!access.view || (need === "edit" && !access.edit)) notFound();
  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  return { ctx, hw, who };
}

export async function updateHomeworkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, hw, who } = await editable(formData, "edit");
  const v = validateHomework(fieldsFrom(formData));
  if (!v.ok) return fail("Please check the highlighted boxes.", v.errors);
  const db = await getDb();
  let changed: string[];
  try {
    ({ changed } = await db.transaction((tx) => updateHomework(tx, ctx.schoolId, hw.id, v.fields, who)));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  if (changed.length) await prepareHindi([v.fields.title, v.fields.details]);
  redirect(`/teach/homework/${hw.id}?done=${changed.length ? "updated" : "unchanged"}`);
}

export async function deleteHomeworkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, hw, who } = await editable(formData, "edit");
  const db = await getDb();
  try {
    await db.transaction((tx) => deleteHomework(tx, ctx.schoolId, hw.id, who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  redirect(`/teach/homework?done=deleted`);
}

export async function saveChecksAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, hw, who } = await editable(formData, "view");
  // Only students on the section's roll now are read from the form.
  const roll = await sectionStudents(hw.sectionId);
  const marks: { studentId: string; status: HomeworkCheck | null }[] = [];
  for (const s of roll) {
    if (!formData.has(`hw_${s.id}`)) continue; // not on the page when it was opened: leave as it is
    const v = str(formData, `hw_${s.id}`);
    marks.push({ studentId: s.id, status: isHomeworkCheck(v) ? v : null });
  }
  const db = await getDb();
  let result;
  try {
    result = await db.transaction((tx) => saveHomeworkChecks(tx, ctx.schoolId, hw.id, marks, who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  refresh();
  const c = result.counts;
  if (!result.changed) return done("Nothing had changed, so there was nothing to save.");
  return done(
    `Saved ${result.changed} ${result.changed === 1 ? "check" : "checks"}. ${c.done} done, ${c.late} late, ${c.not_done} not done, ${c.excused} excused` +
      (roll.length > c.checked ? `, ${roll.length - c.checked} not checked yet.` : "."),
  );
}
