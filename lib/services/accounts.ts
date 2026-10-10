/**
 * Accounts and one-time codes (activation / reset slips).
 *
 * A slip carries the login ID and a one-time code. The code is valid for
 * 14 days and works once. Printing a new slip cancels any earlier code and —
 * for an account that already had a password — the password too, and signs
 * the account out everywhere. It also clears the login ID's wrong-try
 * counters, so a new slip works at once even after a lock. Only a keyed
 * fingerprint of each code is kept.
 *
 * Also here: who may print a slip for whom, turning a family's sign-in off
 * and on, changing one's own password, and AESRI administrator accounts.
 * Writes take the caller's transaction and write an audit entry. Nothing
 * here imports "server-only" code, so scripts can use it too.
 */
import { and, asc, count, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { accounts, authSessions, classes, enrolments, oneTimeCodes, schools, sections, staff, students } from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { codeFingerprint, fingerprintsMatch, hashPassword, newOneTimeCode, normalizeCode, passwordProblem } from "@/lib/auth/crypto";
import { clearLoginId } from "@/lib/auth/throttle";
import { forgetTrustedBrowsers } from "@/lib/auth/trusted";
import { classLabel, sectionLabel } from "@/lib/classes";
import { displayLoginId, staffLoginId, studentLoginId } from "@/lib/ids";

export const CODE_VALID_DAYS = 14;

import type { Role, StaffAccess } from "@/lib/roles";

export type { Role };

export async function ensureStudentAccount(tx: Tx, studentId: string): Promise<{ id: string; loginId: string }> {
  const [existing] = await tx.select({ id: accounts.id, loginId: accounts.loginId }).from(accounts).where(eq(accounts.studentId, studentId));
  if (existing) return existing;
  const [s] = await tx
    .select({ srNo: students.srNo, schoolId: students.schoolId, prefix: schools.loginPrefix })
    .from(students)
    .innerJoin(schools, eq(schools.id, students.schoolId))
    .where(eq(students.id, studentId));
  if (!s) throw new Error("Student not found");
  const loginId = studentLoginId(s.prefix, s.srNo);
  const [created] = await tx
    .insert(accounts)
    .values({ loginId, role: "student", schoolId: s.schoolId, studentId, status: "pending" })
    .returning({ id: accounts.id, loginId: accounts.loginId });
  return created;
}

export async function ensureStaffAccount(tx: Tx, staffId: string, role: "teacher" | "school_admin" | "accounts"): Promise<{ id: string; loginId: string }> {
  const [existing] = await tx.select({ id: accounts.id, loginId: accounts.loginId, role: accounts.role }).from(accounts).where(eq(accounts.staffId, staffId));
  if (existing) {
    if (existing.role !== role) await tx.update(accounts).set({ role }).where(eq(accounts.id, existing.id));
    return existing;
  }
  const [s] = await tx
    .select({ empNo: staff.empNo, schoolId: staff.schoolId, prefix: schools.loginPrefix })
    .from(staff)
    .innerJoin(schools, eq(schools.id, staff.schoolId))
    .where(eq(staff.id, staffId));
  if (!s) throw new Error("Staff member not found");
  const loginId = staffLoginId(s.prefix, s.empNo);
  const [created] = await tx
    .insert(accounts)
    .values({ loginId, role, schoolId: s.schoolId, staffId, status: "pending" })
    .returning({ id: accounts.id, loginId: accounts.loginId });
  return created;
}

export type IssuedCode = { accountId: string; loginId: string; code: string; expiresAt: Date; purpose: "activation" | "reset" };

/**
 * Create a new one-time code for an account. Earlier unused codes are
 * cancelled. If the account already has a password, this is a reset: the
 * password is removed and every session is signed out.
 */
export async function issueCode(tx: Tx, accountId: string, actor: AuditActor, opts: { validHours?: number } = {}): Promise<IssuedCode> {
  const [acc] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
  if (!acc) throw new Error("Account not found");
  if (acc.status === "disabled") throw new Error("This account is disabled.");
  const now = new Date();
  await tx
    .update(oneTimeCodes)
    .set({ revokedAt: now })
    .where(and(eq(oneTimeCodes.accountId, accountId), isNull(oneTimeCodes.usedAt), isNull(oneTimeCodes.revokedAt)));

  const purpose: "activation" | "reset" = acc.passwordHash ? "reset" : "activation";
  if (purpose === "reset") {
    await tx.update(accounts).set({ passwordHash: null, status: "pending", totpEnabled: false, totpSecretEnc: null }).where(eq(accounts.id, accountId));
    await tx.delete(authSessions).where(eq(authSessions.accountId, accountId));
    await forgetTrustedBrowsers(tx, accountId);
  }

  const code = newOneTimeCode();
  const expiresAt = new Date(now.getTime() + (opts.validHours ?? CODE_VALID_DAYS * 24) * 3600_000);
  await tx.insert(oneTimeCodes).values({
    accountId,
    codeHash: codeFingerprint(code, accountId),
    purpose,
    expiresAt,
    createdBy: actor.accountId,
  });
  // Too many wrong tries earlier (maybe that's why they need a slip): the new slip must work straight away.
  await clearLoginId(tx, acc.loginId);
  await audit(tx, actor, purpose === "reset" ? "account.reset_slip" : "account.activation_slip", {
    schoolId: acc.schoolId,
    targetType: "account",
    targetId: accountId,
    details: { loginId: displayLoginId(acc.loginId) },
  });
  return { accountId, loginId: displayLoginId(acc.loginId), code, expiresAt, purpose };
}

export type RedeemResult =
  | { ok: true; accountId: string; role: Role }
  | { ok: false; reason: "invalid" | "weak_password"; problem?: string };

/**
 * Check a login ID + one-time code and set the new password. Returns
 * "invalid" for every kind of mismatch (wrong ID, wrong/used/expired code),
 * so the response doesn't reveal which part was wrong.
 */
export async function redeemCode(tx: Tx, normalizedLoginId: string, code: string, newPassword: string, ip: string): Promise<RedeemResult> {
  const [acc] = await tx.select().from(accounts).where(eq(accounts.loginId, normalizedLoginId));
  if (!acc || acc.status === "disabled") return { ok: false, reason: "invalid" };
  const now = new Date();
  const candidates = await tx
    .select()
    .from(oneTimeCodes)
    .where(and(eq(oneTimeCodes.accountId, acc.id), isNull(oneTimeCodes.usedAt), isNull(oneTimeCodes.revokedAt), gt(oneTimeCodes.expiresAt, now)));
  const fp = codeFingerprint(normalizeCode(code), acc.id);
  const match = candidates.find((c) => fingerprintsMatch(c.codeHash, fp));
  if (!match) return { ok: false, reason: "invalid" };

  const problem = passwordProblem(newPassword, acc.loginId);
  if (problem) return { ok: false, reason: "weak_password", problem };

  // Use the code up only if it is still unused, so the same slip sent twice at once works once.
  const usedUp = await tx
    .update(oneTimeCodes)
    .set({ usedAt: now })
    .where(and(eq(oneTimeCodes.id, match.id), isNull(oneTimeCodes.usedAt), isNull(oneTimeCodes.revokedAt)))
    .returning({ id: oneTimeCodes.id });
  if (usedUp.length !== 1) return { ok: false, reason: "invalid" };
  await tx
    .update(accounts)
    // Activating signs the person in straight away, so it counts as their latest sign-in.
    .set({ passwordHash: await hashPassword(newPassword), status: "active", passwordChangedAt: now, privacyAcceptedAt: now, lastLoginAt: now })
    .where(eq(accounts.id, acc.id));
  await tx.delete(authSessions).where(eq(authSessions.accountId, acc.id));
  await forgetTrustedBrowsers(tx, acc.id);
  await audit(tx, { accountId: acc.id, loginId: displayLoginId(acc.loginId), ip }, "account.activated", {
    schoolId: acc.schoolId,
    targetType: "account",
    targetId: acc.id,
    details: { via: match.purpose },
  });
  return { ok: true, accountId: acc.id, role: acc.role };
}

/* ------------------------------------------------------------------ */
/* Who may print a slip for whom                                       */
/* ------------------------------------------------------------------ */

/** A problem the person can fix, in plain language (the page shows the message). */
export class AccountError extends Error {}

export type AccountStatus = "pending" | "active" | "disabled";

/** An account a slip might be printed for, with the person behind it. */
export type SlipTarget = {
  accountId: string;
  /** Display form: Arya7634, AryaE12, aesri.name */
  loginId: string;
  role: Role;
  schoolId: string | null;
  status: AccountStatus;
  /** A password is set: a new slip resets it (and the authenticator app). */
  hasPassword: boolean;
  totpEnabled: boolean;
  person:
    | { kind: "student"; id: string; name: string; active: boolean; section: string | null; sectionLong: string | null }
    | { kind: "staff"; id: string; name: string; active: boolean; designation: string | null; access: StaffAccess }
    | { kind: "admin"; name: string };
};

/**
 * Load accounts (locked for this transaction) with the student or staff
 * member behind them. `sessionId` picks the class shown for students.
 * Unknown IDs are simply missing from the result.
 */
export async function slipTargets(tx: Tx, accountIds: string[], sessionId: string | null): Promise<SlipTarget[]> {
  const ids = [...new Set(accountIds)];
  if (!ids.length) return [];
  const rows = await tx
    .select({
      id: accounts.id,
      loginId: accounts.loginId,
      role: accounts.role,
      schoolId: accounts.schoolId,
      status: accounts.status,
      passwordHash: accounts.passwordHash,
      totpEnabled: accounts.totpEnabled,
      displayName: accounts.displayName,
      studentId: accounts.studentId,
      staffId: accounts.staffId,
    })
    .from(accounts)
    .where(inArray(accounts.id, ids))
    .for("update");
  const studentIds = rows.map((r) => r.studentId).filter((x): x is string => !!x);
  const staffIds = rows.map((r) => r.staffId).filter((x): x is string => !!x);
  const [studentRows, placements, staffRows] = await Promise.all([
    studentIds.length ? tx.select({ id: students.id, name: students.name, status: students.status }).from(students).where(inArray(students.id, studentIds)) : [],
    studentIds.length && sessionId
      ? tx
          .select({ studentId: enrolments.studentId, className: classes.name, stream: classes.stream, sectionName: sections.name })
          .from(enrolments)
          .innerJoin(sections, eq(sections.id, enrolments.sectionId))
          .innerJoin(classes, eq(classes.id, sections.classId))
          .where(and(inArray(enrolments.studentId, studentIds), eq(enrolments.sessionId, sessionId)))
      : [],
    staffIds.length
      ? tx.select({ id: staff.id, name: staff.name, status: staff.status, designation: staff.designation, access: staff.access }).from(staff).where(inArray(staff.id, staffIds))
      : [],
  ]);
  const studentBy = new Map(studentRows.map((s) => [s.id, s]));
  const placeBy = new Map(placements.map((p) => [p.studentId, p]));
  const staffBy = new Map(staffRows.map((s) => [s.id, s]));
  const out: SlipTarget[] = [];
  for (const r of rows) {
    let person: SlipTarget["person"];
    if (r.studentId) {
      const s = studentBy.get(r.studentId);
      const p = placeBy.get(r.studentId);
      if (!s) continue;
      person = {
        kind: "student",
        id: s.id,
        name: s.name,
        active: s.status === "active",
        section: p ? sectionLabel(p.className, p.sectionName) : null,
        sectionLong: p ? `${classLabel(p.className, p.stream)}, section ${p.sectionName}` : null,
      };
    } else if (r.staffId) {
      const s = staffBy.get(r.staffId);
      if (!s) continue;
      person = { kind: "staff", id: s.id, name: s.name, active: s.status === "active", designation: s.designation, access: s.access };
    } else {
      person = { kind: "admin", name: r.displayName ?? displayLoginId(r.loginId) };
    }
    out.push({
      accountId: r.id,
      loginId: displayLoginId(r.loginId),
      role: r.role,
      schoolId: r.schoolId,
      status: r.status,
      hasPassword: !!r.passwordHash,
      totpEnabled: r.totpEnabled,
      person,
    });
  }
  // Keep the order the IDs were given in (the order of the table, so slips come out in class order).
  const order = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => (order.get(a.accountId) ?? 0) - (order.get(b.accountId) ?? 0));
}

/**
 * Whose slips this person may print. School admins: families, teachers and
 * accounts staff of their own school. The principal's and office admins'
 * slips (role school_admin) and AESRI administrators' slips: AESRI
 * administrators only. The school itself is checked by the caller.
 */
export function mayPrintSlipFor(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "super_admin") return true;
  if (actorRole === "school_admin") return targetRole === "student" || targetRole === "teacher" || targetRole === "accounts";
  return false;
}

export type SlipRefusal = "own" | "admin_only" | "turned_off" | "left";

/** Why a slip can't be printed for this account (null = it can). */
export function slipRefusal(actor: { accountId: string; role: Role }, t: SlipTarget): SlipRefusal | null {
  if (t.accountId === actor.accountId) return "own";
  if (!mayPrintSlipFor(actor.role, t.role)) return "admin_only";
  if (t.status === "disabled") return "turned_off";
  if (t.person.kind !== "admin" && !t.person.active) return "left";
  return null;
}

/**
 * Hours from now until the end of the code's last day in India
 * (CODE_VALID_DAYS after today, 23:59 IST), so "valid until 13 Oct" on a
 * slip means the whole of 13 October. (A minute short of midnight, so the
 * moment issueCode reads the clock a little later can't tip it into the next day.)
 */
export function slipValidHours(now = new Date()): number {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const last = new Date(`${today}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + CODE_VALID_DAYS);
  const end = new Date(`${last.toISOString().slice(0, 10)}T23:59:00+05:30`);
  return (end.getTime() - now.getTime()) / 3600_000;
}

/** How many of these accounts have an unused slip that still works (a new slip cancels it). */
export async function unusedSlipCount(tx: Tx, accountIds: string[]): Promise<number> {
  if (!accountIds.length) return 0;
  const rows = await tx
    .selectDistinct({ accountId: oneTimeCodes.accountId })
    .from(oneTimeCodes)
    .where(and(inArray(oneTimeCodes.accountId, accountIds), isNull(oneTimeCodes.usedAt), isNull(oneTimeCodes.revokedAt), gt(oneTimeCodes.expiresAt, new Date())));
  return rows.length;
}

/** Issue a code for each account in turn (one audit entry each). The caller checks the rules first. */
export async function issueSlips(tx: Tx, accountIds: string[], actor: AuditActor): Promise<IssuedCode[]> {
  const out: IssuedCode[] = [];
  for (const id of accountIds) out.push(await issueCode(tx, id, actor, { validHours: slipValidHours() }));
  return out;
}

/* ------------------------------------------------------------------ */
/* Turning sign-in off and on                                          */
/* ------------------------------------------------------------------ */

/**
 * Turn an account's sign-in off (it can't sign in or use a slip code; it is
 * signed out everywhere and unused codes are cancelled) or on again (back to
 * active if it has a password, otherwise waiting for a new slip).
 * Returns false when the account was already in that state.
 */
export async function setSignInEnabled(tx: Tx, accountId: string, enabled: boolean, actor: AuditActor): Promise<{ changed: boolean; status: AccountStatus }> {
  const [acc] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for("update");
  if (!acc) throw new AccountError("That account was not found. Reload the page and try again.");
  if (enabled) {
    if (acc.status !== "disabled") return { changed: false, status: acc.status };
    const status: AccountStatus = acc.passwordHash ? "active" : "pending";
    await tx.update(accounts).set({ status, failedAttempts: 0, lockedUntil: null }).where(eq(accounts.id, acc.id));
    // Whatever was trusted before it was turned off stays forgotten.
    await forgetTrustedBrowsers(tx, acc.id);
    await audit(tx, actor, "account.enabled", {
      schoolId: acc.schoolId,
      targetType: "account",
      targetId: acc.id,
      details: { loginId: displayLoginId(acc.loginId), status },
    });
    return { changed: true, status };
  }
  if (acc.status === "disabled") return { changed: false, status: "disabled" };
  if (acc.role === "super_admin" && acc.status === "active" && (await activeAesriAdminCount(tx, acc.id)) === 0) {
    throw new AccountError("This is the only active AESRI administrator, so their sign-in can't be turned off.");
  }
  await tx.update(accounts).set({ status: "disabled" }).where(eq(accounts.id, acc.id));
  await tx.delete(authSessions).where(eq(authSessions.accountId, acc.id));
  await forgetTrustedBrowsers(tx, acc.id);
  await tx
    .update(oneTimeCodes)
    .set({ revokedAt: new Date() })
    .where(and(eq(oneTimeCodes.accountId, acc.id), isNull(oneTimeCodes.usedAt), isNull(oneTimeCodes.revokedAt)));
  await audit(tx, actor, "account.disabled", {
    schoolId: acc.schoolId,
    targetType: "account",
    targetId: acc.id,
    details: { loginId: displayLoginId(acc.loginId) },
  });
  return { changed: true, status: "disabled" };
}

/* ------------------------------------------------------------------ */
/* One's own password and sessions                                     */
/* ------------------------------------------------------------------ */

/**
 * Set a new password for a signed-in person (the caller has checked the
 * current one and signs out the other sessions in the same transaction).
 */
export async function setOwnPassword(tx: Tx, accountId: string, newPassword: string, actor: AuditActor, details: Record<string, unknown> = {}): Promise<void> {
  const [acc] = await tx.select({ id: accounts.id, schoolId: accounts.schoolId, status: accounts.status }).from(accounts).where(eq(accounts.id, accountId)).for("update");
  if (!acc || acc.status !== "active") throw new AccountError("Your account is not active. Please sign in again.");
  await tx.update(accounts).set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() }).where(eq(accounts.id, acc.id));
  await audit(tx, actor, "account.password_changed", { schoolId: acc.schoolId, targetType: "account", targetId: acc.id, details });
}

/** How many other unexpired sessions an account has (other browsers or devices). */
export async function otherSessionCount(tx: Tx, accountId: string, exceptSessionId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(authSessions)
    .where(and(eq(authSessions.accountId, accountId), ne(authSessions.id, exceptSessionId), gt(authSessions.expiresAt, new Date())));
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------------------ */
/* AESRI administrators                                                */
/* ------------------------------------------------------------------ */

/** Active AESRI administrator accounts, optionally leaving one out. */
export async function activeAesriAdminCount(tx: Tx, exceptAccountId?: string): Promise<number> {
  const conds = [eq(accounts.role, "super_admin"), eq(accounts.status, "active")];
  if (exceptAccountId) conds.push(ne(accounts.id, exceptAccountId));
  const [row] = await tx.select({ n: count() }).from(accounts).where(and(...conds));
  return Number(row?.n ?? 0);
}

/**
 * What's wrong with a login ID for an AESRI administrator (null = fine).
 * Expects the lower-cased form. Like "aesri.name": 3–40 lower-case letters,
 * digits and dots, starting with a letter; never in a school's login format.
 */
export function aesriLoginIdProblem(loginId: string): string | null {
  if (loginId.length < 3 || loginId.length > 40) return "Use 3 to 40 characters, for example aesri.meena.";
  if (!/^[a-z0-9.]+$/.test(loginId)) return "Use only lower-case letters, numbers and dots, for example aesri.meena.";
  if (!/^[a-z]/.test(loginId)) return "Start with a letter, for example aesri.meena.";
  if (loginId.endsWith(".") || loginId.includes("..")) return "Don't end with a dot or put two dots together.";
  if (/^(arya|aadhar|aadhaar)/.test(loginId)) return "IDs starting with “arya” or “aadhar” belong to the schools’ families and staff. Choose another, for example aesri.meena.";
  return null;
}

/** Add an AESRI administrator account, waiting for its first slip. */
export async function createAesriAdmin(tx: Tx, input: { loginId: string; name: string }, actor: AuditActor): Promise<{ accountId: string; loginId: string }> {
  const loginId = input.loginId.trim().toLowerCase();
  const problem = aesriLoginIdProblem(loginId);
  if (problem) throw new AccountError(problem);
  const [taken] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.loginId, loginId));
  if (taken) throw new AccountError(`The login ID ${loginId} is already in use. Choose another.`);
  const [created] = await tx
    .insert(accounts)
    .values({ loginId, role: "super_admin", displayName: input.name, status: "pending" })
    .returning({ id: accounts.id, loginId: accounts.loginId });
  await audit(tx, actor, "account.admin_created", { schoolId: null, targetType: "account", targetId: created.id, details: { loginId, name: input.name } });
  return { accountId: created.id, loginId: created.loginId };
}

/** AESRI administrator accounts, by name. */
export async function listAesriAdmins(tx: Tx) {
  return tx
    .select({
      id: accounts.id,
      loginId: accounts.loginId,
      name: accounts.displayName,
      status: accounts.status,
      totpEnabled: accounts.totpEnabled,
      lastLoginAt: accounts.lastLoginAt,
      passwordChangedAt: accounts.passwordChangedAt,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(eq(accounts.role, "super_admin"))
    .orderBy(asc(accounts.displayName), asc(accounts.loginId));
}
