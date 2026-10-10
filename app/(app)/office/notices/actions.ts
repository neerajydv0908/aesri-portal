"use server";

import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { auditActor } from "@/lib/auth/dal";
import { fail, messageOf, type FormState } from "@/lib/forms";
import { officePage } from "@/lib/page";
import { listSections } from "@/lib/queries/school";
import { RecordError } from "@/lib/services/students";
import { archiveNotice, createOfficeNotice, isOfficeNotice, noticeById, publishNotice, updateNotice, validateNotice, type NoticeTarget } from "@/lib/services/notices";
import { str } from "@/lib/validation";
import { prepareHindi } from "@/lib/translate";

const TABS = ["draft", "published", "archived"] as const;
const tabFrom = (formData: FormData) => {
  const t = str(formData, "back");
  return (TABS as readonly string[]).includes(t) ? t : "published";
};

/**
 * Who the notice is for, from the form: "to" is school, staff or a section
 * of this school; for a section, "scope" is the whole class or the ticked
 * students ("students"). The service checks the students are on its roll.
 */
async function targetFrom(formData: FormData, ctx: { schoolId: string; sessionId: string }): Promise<{ target: NoticeTarget } | { error: string; field: string }> {
  const to = str(formData, "to");
  if (to === "school" || to === "staff") return { target: { audience: to } };
  const section = (await listSections(ctx.schoolId, ctx.sessionId)).find((s) => s.id === to);
  if (!section) return { error: "Choose who the notice is for.", field: "to" };
  if (str(formData, "scope") === "students") {
    const studentIds = formData.getAll("students").filter((v): v is string => typeof v === "string" && !!v);
    if (!studentIds.length) return { error: `Tick the students of ${section.label} the notice is for, or choose “The whole class”.`, field: "students" };
    return { target: { audience: "students", sectionId: section.id, studentIds } };
  }
  return { target: { audience: "section", sectionId: section.id } };
}

/** Create a notice, or change one, as a draft or published — depending on the button pressed. */
export async function saveOfficeNoticeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const id = str(formData, "id");
  const publish = str(formData, "intent") === "publish";
  const v = validateNotice({
    category: formData.get("category"),
    titleEn: formData.get("titleEn"),
    bodyEn: formData.get("bodyEn"),
    titleHi: formData.get("titleHi"),
    bodyHi: formData.get("bodyHi"),
    publishOn: formData.get("publishOn"),
    expiresOn: formData.get("expiresOn"),
  });
  const t = await targetFrom(formData, ctx);
  if (!v.ok || "error" in t) {
    const fields = { ...(v.ok ? {} : v.errors), ...("error" in t ? { [t.field]: t.error } : {}) };
    return fail(Object.keys(fields).length === 1 ? Object.values(fields)[0] : "Please check the highlighted boxes.", fields);
  }
  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  const db = await getDb();
  // Without the office's own Hindi, families who read Hindi get a translation — ready before publishing, so the text message has it too.
  await prepareHindi([v.content.titleHi ? null : v.content.titleEn, v.content.bodyHi ? null : v.content.bodyEn], { wait: publish });

  if (!id) {
    try {
      await db.transaction((tx) => createOfficeNotice(tx, { schoolId: ctx.schoolId, target: t.target, publish, ...v.content }, who));
    } catch (err) {
      return fail(messageOf(err, [RecordError]));
    }
    redirect(publish ? "/office/notices?status=published&done=published" : "/office/notices?status=draft&done=drafted");
  }

  // Only the office's own notices are edited here; teachers' class notices can only be archived.
  const n = await noticeById(id);
  if (!n || n.schoolId !== ctx.schoolId || !isOfficeNotice(n)) notFound();
  let result;
  try {
    result = await db.transaction((tx) => updateNotice(tx, ctx.schoolId, n.id, v.content, who, { publish, target: t.target }));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  if (publish && n.status !== "published") redirect("/office/notices?status=published&done=published");
  redirect(`/office/notices?status=${result.published ? "published" : "draft"}&done=${result.changed.length ? "updated" : "unchanged"}`);
}

async function officeNotice(formData: FormData) {
  const ctx = await officePage();
  const n = await noticeById(str(formData, "id"));
  if (!n || n.schoolId !== ctx.schoolId) notFound();
  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  return { ctx, n, who };
}

export async function publishNoticeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, n, who } = await officeNotice(formData);
  const db = await getDb();
  await prepareHindi([n.titleHi ? null : n.titleEn, n.bodyHi ? null : n.bodyEn], { wait: true });
  try {
    await db.transaction((tx) => publishNotice(tx, ctx.schoolId, n.id, who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  redirect("/office/notices?status=published&done=published");
}

export async function archiveNoticeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, n, who } = await officeNotice(formData);
  const db = await getDb();
  try {
    await db.transaction((tx) => archiveNotice(tx, ctx.schoolId, n.id, who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  redirect(`/office/notices?status=${tabFrom(formData)}&done=archived`);
}
