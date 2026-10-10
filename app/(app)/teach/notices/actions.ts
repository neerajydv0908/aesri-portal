"use server";

import { refresh } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { auditActor, canManageSection } from "@/lib/auth/dal";
import { todayIST } from "@/lib/dates";
import { done, fail, messageOf, type FormState } from "@/lib/forms";
import { teacherPage, type TeacherContext } from "@/lib/page";
import type { SimpleSmsResult } from "@/lib/sms/outbox";
import { RecordError } from "@/lib/services/students";
import { archiveNotice, createClassNotice, noticeById, updateNotice, validateNotice } from "@/lib/services/notices";
import { str } from "@/lib/validation";
import { prepareHindi } from "@/lib/translate";

const contentFrom = (formData: FormData, publishOn: string) => ({
  category: formData.get("category"),
  titleEn: formData.get("titleEn"),
  bodyEn: formData.get("bodyEn"),
  titleHi: formData.get("titleHi"),
  bodyHi: formData.get("bodyHi"),
  publishOn,
  expiresOn: formData.get("expiresOn"),
});

/** The ticked students when "Chosen students" is picked; null for the whole class. The service checks they are on the class's roll. */
function chosenStudents(formData: FormData): string[] | null {
  if (str(formData, "scope") !== "students") return null;
  return formData.getAll("students").filter((v): v is string => typeof v === "string" && !!v);
}

/** "12 families will get a text message." */
function smsWords(sms: SimpleSmsResult | null): string {
  if (!sms) return "";
  const parts: string[] = [];
  if (sms.queued) parts.push(`${sms.queued} ${sms.queued === 1 ? "family" : "families"} will get a text message too`);
  if (sms.unreachable) parts.push(`${sms.unreachable} ${sms.unreachable === 1 ? "family doesn’t" : "families don’t"} get text messages (no mobile number, or they asked not to)`);
  return parts.length ? ` ${parts.join("; ")}.` : "";
}

export async function postClassNoticeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await teacherPage();
  const section = ctx.classTeacherSections.find((s) => s.id === str(formData, "section"));
  if (!section || !(await canManageSection(ctx.actor, section.id, "class_teacher"))) notFound();
  const today = todayIST();
  const v = validateNotice(contentFrom(formData, today));
  const studentIds = chosenStudents(formData);
  const errors = { ...(v.ok ? {} : v.errors), ...(studentIds && !studentIds.length ? { students: `Tick the students of ${section.label} the notice is for, or choose “The whole class”.` } : {}) };
  if (!v.ok || Object.keys(errors).length) return fail(Object.keys(errors).length === 1 ? Object.values(errors)[0] : "Please check the highlighted boxes.", errors);
  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  const db = await getDb();
  // Families who read Hindi get a translation — ready before posting, so the text message has it too.
  await prepareHindi([v.content.titleHi ? null : v.content.titleEn, v.content.bodyHi ? null : v.content.bodyEn], { wait: true });
  let saved;
  try {
    saved = await db.transaction((tx) => createClassNotice(tx, { schoolId: ctx.schoolId, sectionId: section.id, studentIds, ...v.content }, who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]), undefined);
  }
  refresh();
  const whom = studentIds ? `${studentIds.length} ${studentIds.length === 1 ? "student" : "students"} of ${section.label}` : section.label;
  return done(`Notice posted to ${whom}. ${studentIds ? "Their families" : "The families of the class"} can see it now.${smsWords(saved.sms)}`);
}

/**
 * A class notice this person may change: a notice of their school to a
 * section where they are class teacher (the whole class or chosen students
 * of it; any section, for admins), written by them — or, to archive, by
 * anyone if they are an admin.
 */
async function classNotice(ctx: TeacherContext, id: string, need: "edit" | "archive") {
  const n = await noticeById(id);
  if (!n || n.schoolId !== ctx.schoolId || (n.audience !== "section" && n.audience !== "students") || !n.sectionId) notFound();
  if (!ctx.classTeacherSections.some((s) => s.id === n.sectionId)) notFound();
  const own = n.createdBy === ctx.actor.accountId;
  if (need === "edit" ? !own : !own && !ctx.isAdmin) notFound();
  return n;
}

export async function updateClassNoticeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await teacherPage();
  const n = await classNotice(ctx, str(formData, "id"), "edit");
  const v = validateNotice(contentFrom(formData, n.publishOn));
  const studentIds = chosenStudents(formData);
  const errors = { ...(v.ok ? {} : v.errors), ...(studentIds && !studentIds.length ? { students: `Tick the students of ${n.sectionLabel ?? "the class"} the notice is for, or choose “The whole class”.` } : {}) };
  if (!v.ok || Object.keys(errors).length) return fail(Object.keys(errors).length === 1 ? Object.values(errors)[0] : "Please check the highlighted boxes.", errors);
  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  const db = await getDb();
  let changed: string[];
  try {
    ({ changed } = await db.transaction((tx) =>
      updateNotice(tx, ctx.schoolId, n.id, v.content, who, {
        target: studentIds ? { audience: "students", sectionId: n.sectionId!, studentIds } : { audience: "section", sectionId: n.sectionId! },
      }),
    ));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  if (changed.length) await prepareHindi([v.content.titleHi ? null : v.content.titleEn, v.content.bodyHi ? null : v.content.bodyEn]);
  redirect(`/teach/notices?section=${n.sectionId}&done=${changed.length ? "updated" : "unchanged"}`);
}

export async function archiveClassNoticeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await teacherPage();
  const n = await classNotice(ctx, str(formData, "id"), "archive");
  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  const db = await getDb();
  try {
    await db.transaction((tx) => archiveNotice(tx, ctx.schoolId, n.id, who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  redirect(`/teach/notices?section=${n.sectionId}&done=archived`);
}
