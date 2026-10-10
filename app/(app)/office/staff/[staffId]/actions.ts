"use server";

import { refresh } from "next/cache";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { auditActor } from "@/lib/auth/dal";
import { done, fail, type FormState } from "@/lib/forms";
import { officePage } from "@/lib/page";
import { todayIST } from "@/lib/dates";
import { displayLoginId } from "@/lib/ids";
import { ACCESS_LABELS, needsTwoFactor, roleForAccess } from "@/lib/roles";
import { str } from "@/lib/validation";
import { listSections, listSubjects } from "@/lib/queries/school";
import { staffRecord } from "@/lib/queries/records";
import {
  accessCanTeach,
  ADMIN_ACCESS_TEXT,
  isAdminAccess,
  isStaffAccess,
  mayManageAdminAccess,
  setClassTeacher,
  setStaffSubjects,
  touchesAdminAccess,
  updateStaff,
} from "@/lib/services/staff";
import { RecordError } from "@/lib/services/students";
import type { Tx } from "@/lib/db/client";
import { failFields, failWith, listText, plural } from "@/components/records/form-state";
import { readStaffDetails } from "../form-data";

/** The staff member (of the office's school) the form is about, or "not found". */
async function load(staffId: string) {
  const ctx = await officePage();
  const st = await staffRecord(ctx.schoolId, ctx.sessionId, staffId);
  if (!st) notFound();
  // No locking yourself out: a school admin can't change their own access or status.
  const self = ctx.actor.role === "school_admin" && !!ctx.actor.staffId && ctx.actor.staffId === st.id;
  return { ...ctx, st, self, adminsLocked: !mayManageAdminAccess(ctx.actor.role), who: await auditActor(ctx.actor) };
}

const SELF = "You can’t change your own portal access or status. Please ask the AESRI administrator.";

async function accountAfter(tx: Tx, staffId: string) {
  const [acc] = await tx
    .select({ status: accounts.status, totpEnabled: accounts.totpEnabled, loginId: accounts.loginId })
    .from(accounts)
    .where(eq(accounts.staffId, staffId));
  return acc ?? null;
}

export async function saveStaffDetailsAction(staffId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { schoolId, st, who } = await load(staffId);
  // A mobile number is needed for everyone who signs in (not for "No login" staff such as drivers).
  const { fields, errors } = readStaffDetails(formData, todayIST(), { mobileNeeded: !!roleForAccess(st.access) });
  if (Object.keys(errors).length) return failFields(formData, errors);
  const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => st[k] !== fields[k]);
  if (!changed.length) return done("Nothing had changed, so there was nothing to save.");
  const db = await getDb();
  try {
    await db.transaction((tx) => updateStaff(tx, schoolId, st.id, fields, who));
  } catch (err) {
    if (err instanceof RecordError) return failWith(formData, err.message);
    throw err;
  }
  refresh();
  return done("The details were saved.");
}

/** What they can do in the portal. Any change signs them out; "No login" turns their sign-in off. */
export async function accessAction(staffId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { schoolId, st, self, adminsLocked, who } = await load(staffId);
  if (self) return fail(SELF);
  const access = str(formData, "access");
  if (!isStaffAccess(access)) return failWith(formData, "Choose what they can do in the portal.", { access: "Choose one of the options." });
  if (access === st.access) return done(`Their access is already ${ACCESS_LABELS[access]}. Nothing changed.`);
  // Principal and Office admin access is given and taken away by AESRI administrators only.
  if (adminsLocked && touchesAdminAccess(st.access, access)) return failWith(formData, ADMIN_ACCESS_TEXT.change, { access: ADMIN_ACCESS_TEXT.hint });
  if (roleForAccess(access) && !st.mobile) {
    const msg = "Add their mobile number first (under “Edit details”): everyone who signs in needs one on record.";
    return failWith(formData, msg, { access: msg });
  }
  const db = await getDb();
  let after;
  try {
    after = await db.transaction(async (tx) => {
      await updateStaff(tx, schoolId, st.id, { access }, who);
      return accountAfter(tx, st.id);
    });
  } catch (err) {
    if (err instanceof RecordError) return failWith(formData, err.message);
    throw err;
  }
  refresh();

  let msg = `Portal access changed to ${ACCESS_LABELS[access]}.`;
  const role = roleForAccess(access);
  if (!role) msg += " Their sign-in is turned off and they have been signed out everywhere.";
  else if (st.status !== "active") msg += " They can’t sign in while they are marked as left.";
  else if (!after || after.status === "pending") {
    msg += ` Print an activation slip so they can sign in${after ? ` (login ID ${displayLoginId(after.loginId)})` : ""}.`;
    if (needsTwoFactor(role)) msg += " They will also set up an authenticator app.";
  } else {
    msg += " They have been signed out; when they sign in again they get the new access.";
    if (needsTwoFactor(role) && !after.totpEnabled) msg += " They will set up an authenticator app first.";
  }
  if (st.classTeacherOf.length && !accessCanTeach(access)) {
    msg += ` They are still class teacher of ${listText(st.classTeacherOf.map((c) => c.label))} but can’t take the register with this access: please choose another class teacher.`;
  }
  return done(msg);
}

/** Left the school (their classes this session are taken off them), or back again. */
export async function staffStatusAction(staffId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { schoolId, st, self, adminsLocked, who } = await load(staffId);
  if (self) return fail(SELF);
  const status = str(formData, "status");
  if (status !== "left" && status !== "active") return fail("Reload the page and try again.");
  if (status === st.status) return done("Nothing had changed.");
  // Marking the principal or an office admin as left (or back) turns their sign-in off (or on): AESRI administrators only.
  if (adminsLocked && isAdminAccess(st.access)) return fail(ADMIN_ACCESS_TEXT.status);
  const db = await getDb();
  let after;
  try {
    after = await db.transaction(async (tx) => {
      await updateStaff(tx, schoolId, st.id, { status }, who);
      return accountAfter(tx, st.id);
    });
  } catch (err) {
    if (err instanceof RecordError) return fail(err.message);
    throw err;
  }
  refresh();

  if (status === "left") {
    const sections = new Set(st.teaching.map((t) => t.sectionId)).size;
    const lost = [
      st.classTeacherOf.length ? `class teacher of ${listText(st.classTeacherOf.map((c) => c.label))}` : null,
      sections ? `teaching subjects in ${plural(sections, "section", "sections")}` : null,
    ].filter(Boolean);
    return done(
      `${st.name} is now marked as left.` +
        (roleForAccess(st.access) ? " Their sign-in is turned off and they have been signed out." : "") +
        (lost.length ? ` They are no longer ${lost.join(" or ")}: please choose new teachers on Classes & subjects.` : ""),
    );
  }
  return done(
    `${st.name} is a current staff member again.` +
      (!roleForAccess(st.access)
        ? ""
        : after?.status === "active"
          ? " They can sign in with their password again."
          : " Print an activation slip so they can sign in.") +
      " Give them their classes on Classes & subjects.",
  );
}

/** The subjects they teach (used to suggest teachers). */
export async function subjectsAction(staffId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { schoolId, st, who } = await load(staffId);
  const list = await listSubjects(schoolId);
  const known = new Map(list.map((s) => [s.id, s.name]));
  const ids = [...new Set(formData.getAll("subjects").filter((v): v is string => typeof v === "string"))];
  if (ids.some((id) => !known.has(id))) return failWith(formData, "One of the subjects is no longer in the list. Reload the page and tick them again.");
  const before = new Set(st.subjectIds);
  if (ids.length === before.size && ids.every((id) => before.has(id))) return done("Nothing had changed, so there was nothing to save.");
  const db = await getDb();
  try {
    await db.transaction((tx) => setStaffSubjects(tx, schoolId, st.id, ids, who));
  } catch (err) {
    if (err instanceof RecordError) return failWith(formData, err.message);
    throw err;
  }
  refresh();
  const names = list.filter((s) => ids.includes(s.id)).map((s) => s.name);
  return done(names.length ? `Saved. ${st.name} teaches ${listText(names)}.` : `Saved. No subjects are recorded for ${st.name}.`);
}

/** Make them class teacher of a section (replacing whoever it was), or take a section off them ("remove"). */
export async function classTeacherAction(staffId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { schoolId, sessionId, st, who } = await load(staffId);
  const sectionList = await listSections(schoolId, sessionId);
  const db = await getDb();

  const removeId = str(formData, "remove");
  if (removeId) {
    const sec = sectionList.find((s) => s.id === removeId);
    if (!sec || sec.classTeacherId !== st.id) return fail("They are no longer class teacher of that section. Reload the page to see the latest.");
    try {
      await db.transaction((tx) => setClassTeacher(tx, schoolId, sec.id, null, who));
    } catch (err) {
      if (err instanceof RecordError) return fail(err.message);
      throw err;
    }
    refresh();
    return done(`${st.name} is no longer class teacher of ${sec.label}. ${sec.label} has no class teacher now: choose one here or on Classes & subjects.`);
  }

  if (st.status !== "active") return fail("Staff who have left can’t be class teachers.");
  if (!accessCanTeach(st.access)) {
    return fail(`With ${ACCESS_LABELS[st.access]} access they can’t take a class register. Give them Teacher, Principal or Office admin access first.`);
  }
  const sec = sectionList.find((s) => s.id === str(formData, "sectionId"));
  if (!sec) return failWith(formData, "Choose the section they will be class teacher of.", { sectionId: "Choose a section." });
  if (sec.classTeacherId === st.id) return done(`${st.name} is already class teacher of ${sec.label}.`);
  try {
    await db.transaction((tx) => setClassTeacher(tx, schoolId, sec.id, st.id, who));
  } catch (err) {
    if (err instanceof RecordError) return fail(err.message);
    throw err;
  }
  refresh();
  return done(`${st.name} is now class teacher of ${sec.label}${sec.classTeacherName ? `, in place of ${sec.classTeacherName}` : ""}.`);
}
