/**
 * Staff records, their portal access and their teaching duties.
 *
 * A staff member's "access" decides their sign-in role (lib/roles.ts). Access
 * "none" — or leaving the school — disables the account and signs it out
 * everywhere; the account itself is kept so the activity log stays readable.
 */
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import {
  academicSessions,
  accounts,
  authSessions,
  classSubjects,
  classes,
  oneTimeCodes,
  sections,
  staff,
  staffSubjects,
  subjects,
  teachingAssignments,
} from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { forgetTrustedBrowsers } from "@/lib/auth/trusted";
import { todayIST } from "@/lib/dates";
import { roleForAccess, type Role, type StaffAccess } from "@/lib/roles";
import { ensureStaffAccount } from "./accounts";
import { RecordError } from "./students";

/** Every portal access, in the order the office sees them. */
export const STAFF_ACCESS_VALUES: readonly StaffAccess[] = ["teacher", "principal", "office_admin", "accounts", "none"];
export const isStaffAccess = (v: unknown): v is StaffAccess => typeof v === "string" && (STAFF_ACCESS_VALUES as readonly string[]).includes(v);

/** Can someone with this access take a class (attendance, remarks) in the portal? */
export const accessCanTeach = (access: StaffAccess) => access === "teacher" || access === "principal" || access === "office_admin";

/* ------------------------------------------------------------------ */
/* Principal and office admin access: AESRI administrators only        */
/* ------------------------------------------------------------------ */

/** Principal and office admin: everything in the school (sign-in role school_admin). */
export const isAdminAccess = (access: StaffAccess): boolean => access === "principal" || access === "office_admin";

/**
 * Only AESRI administrators give or take away Principal / Office admin
 * access, add staff with it, or mark such staff as left or current again.
 * Otherwise one school admin could demote the principal, print them a slip
 * (allowed for teachers), sign in as them and promote them back. Slips for
 * these accounts come from AESRI for the same reason (mayPrintSlipFor).
 */
export const mayManageAdminAccess = (actorRole: Role): boolean => actorRole === "super_admin";

/** Does going from `from` (null: a new staff member) to `to` give or take away Principal / Office admin access? */
export function touchesAdminAccess(from: StaffAccess | null, to: StaffAccess): boolean {
  if (from === to) return false;
  return isAdminAccess(to) || (from !== null && isAdminAccess(from));
}

/** What the office is told when one of these changes is refused (and why a control isn't offered). */
export const ADMIN_ACCESS_TEXT = {
  add: "Only the AESRI administrator can give Principal or Office admin access. Choose another access, or ask the AESRI administrator to add this person.",
  change: "Only the AESRI administrator can give or take away Principal or Office admin access. Please ask them.",
  status: "Only the AESRI administrator can mark the principal or an office admin as left, or as current again, because it turns their sign-in off or on. Please ask them.",
  /** Under the access choice, when the two options are offered but can't be chosen. */
  hint: "Principal and Office admin access can only be given by the AESRI administrator.",
  /** On the record of a principal or office admin, in place of the access form. */
  locked: "The principal’s and office admins’ access is given and taken away by the AESRI administrator, so it can’t be changed here.",
  /** On the record of a principal or office admin, in place of the status form. */
  lockedStatus: "Only the AESRI administrator can mark the principal or an office admin as left, because it turns their sign-in off.",
} as const;

/** The section must belong to this school (any session). */
async function sectionOfSchool(tx: Tx, sectionId: string, schoolId: string) {
  const [row] = await tx
    .select({ id: sections.id, classTeacherId: sections.classTeacherId, sessionId: sections.sessionId })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(and(eq(sections.id, sectionId), eq(classes.schoolId, schoolId)));
  if (!row) throw new RecordError("That class section was not found. Reload the page and try again.");
  return row;
}

/** Sections of sessions that haven't ended yet (the current one, and the next if it is already set up). */
function openSessionSections(tx: Tx) {
  const open = tx.select({ id: academicSessions.id }).from(academicSessions).where(gte(academicSessions.endsOn, todayIST()));
  return tx.select({ id: sections.id }).from(sections).where(inArray(sections.sessionId, open));
}

export type StaffFields = {
  empNo: string;
  name: string;
  designation?: string | null;
  access: StaffAccess;
  mobile?: string | null;
  email?: string | null;
  joinedOn?: string | null;
};

/** Make the sign-in account match the staff member's access and status. */
async function syncAccount(tx: Tx, staffId: string): Promise<{ loginId: string } | null> {
  const [s] = await tx.select().from(staff).where(eq(staff.id, staffId));
  if (!s) throw new RecordError("Staff member not found.");
  const role = s.status === "active" ? roleForAccess(s.access) : null;
  const [acc] = await tx.select().from(accounts).where(eq(accounts.staffId, staffId));
  if (role) {
    const a = await ensureStaffAccount(tx, staffId, role);
    // Re-enable an account that was disabled earlier (it goes back to "pending" until a new slip is used).
    if (acc?.status === "disabled") {
      await tx.update(accounts).set({ status: acc.passwordHash ? "active" : "pending" }).where(eq(accounts.id, acc.id));
      // Whatever was trusted before it was turned off stays forgotten.
      await forgetTrustedBrowsers(tx, acc.id);
    }
    if (acc && acc.role !== role) {
      // A change of role signs the person out, so their next session gets the right permissions,
      // and forgets the browsers they trusted for the old role.
      await tx.delete(authSessions).where(eq(authSessions.accountId, acc.id));
      await forgetTrustedBrowsers(tx, acc.id);
      if (role === "school_admin") {
        // Becoming principal or office admin: the password (and any slip) may have come from a slip a
        // school admin printed, so it can't be trusted for an admin account. They start again with a
        // slip that only an AESRI administrator can print, and set up their authenticator then.
        await tx
          .update(accounts)
          .set({ passwordHash: null, status: "pending", totpEnabled: false, totpSecretEnc: null, totpLastStep: null })
          .where(eq(accounts.id, acc.id));
        await tx
          .update(oneTimeCodes)
          .set({ revokedAt: new Date() })
          .where(and(eq(oneTimeCodes.accountId, acc.id), isNull(oneTimeCodes.usedAt), isNull(oneTimeCodes.revokedAt)));
      }
    }
    return { loginId: a.loginId };
  }
  if (acc && acc.status !== "disabled") {
    await tx.update(accounts).set({ status: "disabled" }).where(eq(accounts.id, acc.id));
    await tx.delete(authSessions).where(eq(authSessions.accountId, acc.id));
    await forgetTrustedBrowsers(tx, acc.id);
    await tx
      .update(oneTimeCodes)
      .set({ revokedAt: new Date() })
      .where(and(eq(oneTimeCodes.accountId, acc.id), isNull(oneTimeCodes.usedAt), isNull(oneTimeCodes.revokedAt)));
  }
  return null;
}

export async function createStaff(tx: Tx, schoolId: string, fields: StaffFields, actor: AuditActor): Promise<{ id: string; loginId: string | null }> {
  const [dupe] = await tx.select({ id: staff.id }).from(staff).where(and(eq(staff.schoolId, schoolId), eq(staff.empNo, fields.empNo)));
  if (dupe) throw new RecordError(`Employee number ${fields.empNo} is already used by another staff member at this school.`);
  const [s] = await tx.insert(staff).values({ schoolId, ...fields }).returning({ id: staff.id });
  const acc = await syncAccount(tx, s.id);
  await audit(tx, actor, "staff.created", { schoolId, targetType: "staff", targetId: s.id, details: { empNo: fields.empNo, name: fields.name, access: fields.access } });
  return { id: s.id, loginId: acc?.loginId ?? null };
}

export async function updateStaff(
  tx: Tx,
  schoolId: string,
  staffId: string,
  fields: Partial<Omit<StaffFields, "empNo">> & { empNo?: string; status?: "active" | "left" },
  actor: AuditActor,
): Promise<void> {
  const [cur] = await tx.select().from(staff).where(and(eq(staff.id, staffId), eq(staff.schoolId, schoolId)));
  if (!cur) throw new RecordError("Staff member not found.");
  if (fields.empNo && fields.empNo !== cur.empNo) {
    throw new RecordError("The employee number can't be changed here, because it is the login ID. Ask the AESRI administrator.");
  }
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (k !== "empNo" && v !== undefined && (cur as Record<string, unknown>)[k] !== v) changes[k] = v;
  if (!Object.keys(changes).length) return;
  await tx.update(staff).set(changes).where(eq(staff.id, staffId));
  if (changes.access !== undefined || changes.status !== undefined) await syncAccount(tx, staffId);
  if (changes.access !== undefined) {
    // Any change of access signs the person out, so their next sign-in gets exactly the new permissions.
    const [acc] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.staffId, staffId));
    if (acc) {
      await tx.delete(authSessions).where(eq(authSessions.accountId, acc.id));
      await forgetTrustedBrowsers(tx, acc.id);
    }
  }
  let cleared: { classTeacherOf: number; teaching: number } | null = null;
  if (changes.status === "left") {
    // Someone who has left no longer has classes. Earlier sessions keep their history (report cards name the class teacher).
    const ct = await tx
      .update(sections)
      .set({ classTeacherId: null })
      .where(and(eq(sections.classTeacherId, staffId), inArray(sections.id, openSessionSections(tx))))
      .returning({ id: sections.id });
    const ta = await tx
      .delete(teachingAssignments)
      .where(and(eq(teachingAssignments.staffId, staffId), inArray(teachingAssignments.sectionId, openSessionSections(tx))))
      .returning({ sectionId: teachingAssignments.sectionId });
    cleared = { classTeacherOf: ct.length, teaching: ta.length };
  }
  await audit(tx, actor, "staff.updated", {
    schoolId,
    targetType: "staff",
    targetId: staffId,
    details: {
      fields: Object.keys(changes),
      ...(changes.access !== undefined ? { access: { from: cur.access, to: changes.access } } : {}),
      ...(changes.status !== undefined ? { status: { from: cur.status, to: changes.status } } : {}),
      ...(cleared ? { cleared } : {}),
    },
  });
}

/** Make a teacher the class teacher of a section (or clear it with staffId = null). */
export async function setClassTeacher(tx: Tx, schoolId: string, sectionId: string, staffId: string | null, actor: AuditActor): Promise<void> {
  const sec = await sectionOfSchool(tx, sectionId, schoolId);
  if (staffId) {
    const [s] = await tx.select({ id: staff.id }).from(staff).where(and(eq(staff.id, staffId), eq(staff.schoolId, schoolId), eq(staff.status, "active")));
    if (!s) throw new RecordError("Choose a current staff member of this school.");
  }
  if (sec.classTeacherId === staffId) return;
  await tx.update(sections).set({ classTeacherId: staffId }).where(eq(sections.id, sectionId));
  await audit(tx, actor, "section.class_teacher", { schoolId, targetType: "section", targetId: sectionId, details: { staffId, previous: sec.classTeacherId } });
}

/** Who teaches a subject in a section (staffId = null removes the assignment). */
export async function setTeacherFor(tx: Tx, schoolId: string, sectionId: string, subjectId: string, staffId: string | null, actor: AuditActor): Promise<void> {
  await sectionOfSchool(tx, sectionId, schoolId);
  const [sub] = await tx.select({ id: subjects.id }).from(subjects).where(and(eq(subjects.id, subjectId), eq(subjects.schoolId, schoolId)));
  if (!sub) throw new RecordError("That subject is not in this school's list. Reload the page and try again.");
  await tx.delete(teachingAssignments).where(and(eq(teachingAssignments.sectionId, sectionId), eq(teachingAssignments.subjectId, subjectId)));
  if (staffId) {
    const [s] = await tx.select({ id: staff.id }).from(staff).where(and(eq(staff.id, staffId), eq(staff.schoolId, schoolId), eq(staff.status, "active")));
    if (!s) throw new RecordError("Choose a current staff member of this school.");
    await tx.insert(teachingAssignments).values({ sectionId, subjectId, staffId });
  }
  await audit(tx, actor, "section.subject_teacher", { schoolId, targetType: "section", targetId: sectionId, details: { subjectId, staffId } });
}

/** Subjects taught in a class (replaces the list). Teaching assignments for removed subjects are removed too. */
export async function setClassSubjects(tx: Tx, schoolId: string, classId: string, subjectIds: string[], actor: AuditActor): Promise<void> {
  const [cls] = await tx.select({ id: classes.id }).from(classes).where(and(eq(classes.id, classId), eq(classes.schoolId, schoolId)));
  if (!cls) throw new RecordError("That class was not found. Reload the page and try again.");
  const wanted = [...new Set(subjectIds)];
  if (wanted.length) {
    const known = await tx.select({ id: subjects.id }).from(subjects).where(and(eq(subjects.schoolId, schoolId), inArray(subjects.id, wanted)));
    if (known.length !== wanted.length) throw new RecordError("One of the subjects is not in this school's list. Reload the page and try again.");
  }
  subjectIds = wanted;
  const current = await tx.select({ subjectId: classSubjects.subjectId }).from(classSubjects).where(eq(classSubjects.classId, classId));
  const keep = new Set(subjectIds);
  const removed = current.map((c) => c.subjectId).filter((id) => !keep.has(id));
  if (removed.length) {
    await tx.delete(classSubjects).where(and(eq(classSubjects.classId, classId), inArray(classSubjects.subjectId, removed)));
    const secs = await tx.select({ id: sections.id }).from(sections).where(eq(sections.classId, classId));
    if (secs.length) {
      await tx
        .delete(teachingAssignments)
        .where(and(inArray(teachingAssignments.sectionId, secs.map((s) => s.id)), inArray(teachingAssignments.subjectId, removed)));
    }
  }
  const have = new Set(current.map((c) => c.subjectId));
  const added = subjectIds.filter((id) => !have.has(id));
  if (added.length) await tx.insert(classSubjects).values(added.map((subjectId) => ({ classId, subjectId })));
  await audit(tx, actor, "class.subjects", { schoolId, targetType: "class", targetId: classId, details: { added: added.length, removed: removed.length } });
}

/** The subjects a staff member teaches (replaces the list). Subjects must belong to the same school. */
export async function setStaffSubjects(tx: Tx, schoolId: string, staffId: string, subjectIds: string[], actor: AuditActor): Promise<void> {
  const [s] = await tx.select({ id: staff.id }).from(staff).where(and(eq(staff.id, staffId), eq(staff.schoolId, schoolId)));
  if (!s) throw new RecordError("Staff member not found.");
  const wanted = [...new Set(subjectIds)];
  if (wanted.length) {
    const known = await tx.select({ id: subjects.id }).from(subjects).where(and(eq(subjects.schoolId, schoolId), inArray(subjects.id, wanted)));
    if (known.length !== wanted.length) throw new RecordError("One of the subjects is not in this school's list. Reload the page and try again.");
  }
  const current = await tx.select({ subjectId: staffSubjects.subjectId }).from(staffSubjects).where(eq(staffSubjects.staffId, staffId));
  const have = new Set(current.map((c) => c.subjectId));
  const keep = new Set(wanted);
  const removed = [...have].filter((id) => !keep.has(id));
  const added = wanted.filter((id) => !have.has(id));
  if (!removed.length && !added.length) return;
  if (removed.length) await tx.delete(staffSubjects).where(and(eq(staffSubjects.staffId, staffId), inArray(staffSubjects.subjectId, removed)));
  if (added.length) await tx.insert(staffSubjects).values(added.map((subjectId) => ({ staffId, subjectId })));
  await audit(tx, actor, "staff.subjects", { schoolId, targetType: "staff", targetId: staffId, details: { added: added.length, removed: removed.length } });
}
