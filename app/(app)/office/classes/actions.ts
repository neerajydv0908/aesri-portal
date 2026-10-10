"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/lib/db/client";
import { auditActor } from "@/lib/auth/dal";
import { done, fail, messageOf, type FormState } from "@/lib/forms";
import { officePage } from "@/lib/page";
import { str } from "@/lib/validation";
import { RecordError } from "@/lib/services/students";
import {
  addNextSection,
  addSubject,
  assignClassTeacher,
  isUuid,
  removeSection,
  removeSubject,
  renameSubject,
  saveSectionTeachers,
  updateClassSubjects,
  validateSubjectNames,
} from "@/lib/services/classes";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Every action here is for the school office, in the school and session being worked on. */
async function context() {
  const ctx = await officePage();
  return { ctx, db: await getDb(), who: await auditActor(ctx.actor) };
}

export async function setClassTeacherAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, db, who } = await context();
  const staffId = str(formData, "staff") || null;
  if (staffId && !isUuid(staffId)) return fail("Choose a member of staff from the list.");
  try {
    const r = await db.transaction((tx) => assignClassTeacher(tx, ctx.schoolId, ctx.sessionId, str(formData, "section"), staffId, who));
    if (!r.changed) return done(`No change: ${r.label} already has that class teacher.`);
    refresh();
    return done(r.name ? `Saved. ${r.name} is now class teacher of ${r.label}.` : `Saved. ${r.label} has no class teacher now.`);
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
}

export async function addSectionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, db, who } = await context();
  try {
    const r = await db.transaction((tx) => addNextSection(tx, ctx.schoolId, ctx.sessionId, str(formData, "class"), who));
    refresh();
    return done(`Added ${r.label}. Choose its class teacher and subject teachers below.`);
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
}

export async function removeSectionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, db, who } = await context();
  const classId = str(formData, "class");
  try {
    await db.transaction((tx) => removeSection(tx, ctx.schoolId, ctx.sessionId, str(formData, "section"), who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  redirect(`/office/classes?${isUuid(classId) ? `class=${classId}&` : ""}done=section-removed`);
}

export async function saveClassSubjectsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, db, who } = await context();
  const ids = formData.getAll("subject").filter((v): v is string => typeof v === "string");
  try {
    const r = await db.transaction((tx) => updateClassSubjects(tx, ctx.schoolId, ctx.sessionId, str(formData, "class"), ids, who));
    if (!r.added && !r.removed) return done("No change: the subjects were already as ticked.");
    refresh();
    const parts = [r.added ? `${plural(r.added, "subject", "subjects")} added` : null, r.removed ? `${plural(r.removed, "subject", "subjects")} removed` : null].filter(Boolean);
    const teachers = r.teachersRemoved ? ` ${plural(r.teachersRemoved, "teacher assignment was", "teacher assignments were")} removed with them.` : "";
    return done(`Saved for ${r.label}: ${parts.join(", ")}.${teachers}`);
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
}

export async function saveSectionTeachersAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, db, who } = await context();
  const wanted = new Map<string, string | null>();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("teacher:") || typeof value !== "string") continue;
    const subjectId = key.slice("teacher:".length);
    if (!isUuid(subjectId) || (value && !isUuid(value))) return fail("Something on this form wasn't recognised. Reload the page and try again.");
    wanted.set(subjectId, value || null);
  }
  try {
    const r = await db.transaction((tx) => saveSectionTeachers(tx, ctx.schoolId, ctx.sessionId, str(formData, "section"), wanted, who));
    if (!r.changed) return done(`No change for ${r.label}.`);
    refresh();
    return done(`Saved ${plural(r.changed, "change", "changes")} for ${r.label}.`);
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
}

export async function addSubjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, db, who } = await context();
  const v = validateSubjectNames({ name: formData.get("name"), nameHi: formData.get("nameHi") });
  if (!v.ok) return fail("Please check the highlighted boxes.", v.errors);
  try {
    await db.transaction((tx) => addSubject(tx, ctx.schoolId, { name: v.name, nameHi: v.nameHi }, who));
  } catch (err) {
    const msg = messageOf(err, [RecordError]);
    return fail(msg, { name: msg });
  }
  refresh();
  return done(`Added ${v.name}. Now tick it for the classes that are taught it.`);
}

export async function renameSubjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, db, who } = await context();
  const id = str(formData, "subject");
  const v = validateSubjectNames({ name: formData.get("name"), nameHi: formData.get("nameHi") });
  if (!v.ok) return fail(Object.values(v.errors)[0]);
  try {
    const r = await db.transaction((tx) => renameSubject(tx, ctx.schoolId, id, { name: v.name, nameHi: v.nameHi }, who));
    if (!r.changed) return done("No change.");
    refresh();
    return done(r.before === v.name ? `Saved ${v.name}.` : `Renamed ${r.before} to ${v.name}.`);
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
}

export async function removeSubjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, db, who } = await context();
  try {
    await db.transaction((tx) => removeSubject(tx, ctx.schoolId, str(formData, "subject"), who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  redirect("/office/classes?view=subjects&done=subject-removed");
}
