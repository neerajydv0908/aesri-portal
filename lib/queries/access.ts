/**
 * Read queries for sign-in accounts: who has activated, who is waiting for
 * a slip (and whether it is still valid), who is turned off. Used by
 * "Slips & sign-in", the AESRI overview and anyone who wants to show a
 * person's sign-in status next to their record.
 */
import "server-only";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accounts, classes, enrolments, oneTimeCodes, schools, sections, staff, students } from "@/lib/db/schema";
import { lockedLoginIds, type SignInLock } from "@/lib/auth/throttle";
import { classLabel, sectionLabel } from "@/lib/classes";
import { displayLoginId, normalizeLoginId, staffLoginId } from "@/lib/ids";
import type { Role, StaffAccess } from "@/lib/roles";
import { mayPrintSlipFor } from "@/lib/services/accounts";

export type AccountStatus = "pending" | "active" | "disabled";

/** The newest slip that can still be used (or has run out), or none. */
export type SlipState =
  | { kind: "valid" | "expired"; printedAt: Date; expiresAt: Date; reset: boolean }
  | { kind: "none"; /** A slip was printed before but was used up or cancelled. */ hadSlip: boolean };

export type SignIn = {
  accountId: string;
  /** Display form: Arya7634, AryaE12 */
  loginId: string;
  role: Role;
  status: AccountStatus;
  hasPassword: boolean;
  totpEnabled: boolean;
  lastLoginAt: Date | null;
  /** When the current password was chosen (activation or change). */
  passwordChangedAt: Date | null;
  slip: SlipState;
  /** Can't sign in (or only on known devices): too many wrong tries, why and until when (null = not locked). Never set for turned-off accounts. */
  lock: SignInLock | null;
};

/** A student or staff member with their sign-in account (null: staff with no portal access and no account). */
export type AccessPerson = {
  kind: "student" | "staff";
  /** Student or staff ID. */
  id: string;
  name: string;
  /** Display login ID (for staff without an account: the ID they would get). */
  loginId: string;
  /** SR no. or employee no. */
  number: string;
  /** Students: "V-A" (or null when not placed this session). Staff: their designation. */
  detail: string | null;
  /** Students: "Class V, section A". */
  detailLong: string | null;
  sectionId: string | null;
  /** Student still at school / staff member still working here. */
  current: boolean;
  personStatus: string;
  /** Staff only. */
  access: StaffAccess | null;
  signIn: SignIn | null;
  /** For sorting in class order. */
  order: number;
  rollNo: number | null;
};

/* ------------------------------------------------------------------ */
/* Slips                                                               */
/* ------------------------------------------------------------------ */

/** The slip state of each account: the newest unused, uncancelled code (valid or run out). */
export async function slipStates(accountIds: string[], now = new Date()): Promise<Map<string, SlipState>> {
  const out = new Map<string, SlipState>();
  const ids = [...new Set(accountIds)];
  if (!ids.length) return out;
  const db = await getDb();
  const rows = await db
    .select({
      accountId: oneTimeCodes.accountId,
      purpose: oneTimeCodes.purpose,
      createdAt: oneTimeCodes.createdAt,
      expiresAt: oneTimeCodes.expiresAt,
      usedAt: oneTimeCodes.usedAt,
      revokedAt: oneTimeCodes.revokedAt,
    })
    .from(oneTimeCodes)
    .where(inArray(oneTimeCodes.accountId, ids))
    .orderBy(asc(oneTimeCodes.createdAt));
  for (const r of rows) {
    const open = !r.usedAt && !r.revokedAt;
    if (open) {
      out.set(r.accountId, { kind: r.expiresAt > now ? "valid" : "expired", printedAt: r.createdAt, expiresAt: r.expiresAt, reset: r.purpose === "reset" });
    } else if (!out.has(r.accountId) || out.get(r.accountId)!.kind === "none") {
      out.set(r.accountId, { kind: "none", hadSlip: true });
    }
  }
  return out;
}

type AccountRow = {
  id: string;
  loginId: string;
  role: Role;
  status: AccountStatus;
  passwordHash: string | null;
  totpEnabled: boolean;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
};

function toSignIn(a: AccountRow, slips: Map<string, SlipState>, locks: Map<string, SignInLock>): SignIn {
  return {
    accountId: a.id,
    loginId: displayLoginId(a.loginId),
    role: a.role,
    status: a.status,
    hasPassword: !!a.passwordHash,
    totpEnabled: a.totpEnabled,
    lastLoginAt: a.lastLoginAt,
    passwordChangedAt: a.passwordChangedAt,
    slip: slips.get(a.id) ?? { kind: "none", hadSlip: false },
    lock: a.status === "disabled" ? null : (locks.get(a.loginId) ?? null),
  };
}

/** Accounts locked after too many wrong tries, by stored login ID (see lib/auth/throttle.ts). */
async function locksFor(rows: ({ loginId: string } | null | undefined)[]): Promise<Map<string, SignInLock>> {
  const ids = rows.map((r) => r?.loginId).filter((x): x is string => !!x);
  if (!ids.length) return new Map();
  return lockedLoginIds(await getDb(), ids);
}

const accountColumns = {
  id: accounts.id,
  loginId: accounts.loginId,
  role: accounts.role,
  status: accounts.status,
  passwordHash: accounts.passwordHash,
  totpEnabled: accounts.totpEnabled,
  lastLoginAt: accounts.lastLoginAt,
  passwordChangedAt: accounts.passwordChangedAt,
};

/** Sign-in status for some accounts (for showing next to a student's or staff member's record). */
export async function signInFor(accountIds: string[]): Promise<Map<string, SignIn>> {
  const ids = [...new Set(accountIds)];
  if (!ids.length) return new Map();
  const db = await getDb();
  const rows = await db.select(accountColumns).from(accounts).where(inArray(accounts.id, ids));
  const [slips, locks] = await Promise.all([slipStates(rows.map((r) => r.id)), locksFor(rows)]);
  return new Map(rows.map((r) => [r.id, toSignIn(r, slips, locks)]));
}

/* ------------------------------------------------------------------ */
/* Everyone in a school                                                */
/* ------------------------------------------------------------------ */

/** Every student of a school (any status) with this session's class and their account. */
export async function studentAccessPeople(schoolId: string, sessionId: string): Promise<AccessPerson[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: students.id,
      name: students.name,
      srNo: students.srNo,
      status: students.status,
      sectionId: sections.id,
      sectionName: sections.name,
      className: classes.name,
      stream: classes.stream,
      classOrder: classes.sortOrder,
      rollNo: enrolments.rollNo,
      account: accountColumns,
    })
    .from(students)
    .leftJoin(enrolments, and(eq(enrolments.studentId, students.id), eq(enrolments.sessionId, sessionId)))
    .leftJoin(sections, eq(sections.id, enrolments.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(accounts, eq(accounts.studentId, students.id))
    .where(eq(students.schoolId, schoolId));
  const [slips, locks] = await Promise.all([
    slipStates(rows.map((r) => r.account?.id).filter((x): x is string => !!x)),
    locksFor(rows.map((r) => (r.account?.id ? r.account : null))),
  ]);
  const [school] = await db.select({ prefix: schools.loginPrefix }).from(schools).where(eq(schools.id, schoolId));
  return rows
    .map((r): AccessPerson => {
      const placed = r.sectionId && r.className && r.sectionName;
      return {
        kind: "student",
        id: r.id,
        name: r.name,
        loginId: r.account?.id ? displayLoginId(r.account.loginId) : displayLoginId(normalizeLoginId(`${school?.prefix ?? ""}${r.srNo}`)),
        number: r.srNo,
        detail: placed ? sectionLabel(r.className!, r.sectionName!) : null,
        detailLong: placed ? `${classLabel(r.className!, r.stream)}, section ${r.sectionName}` : null,
        sectionId: r.sectionId,
        current: r.status === "active",
        personStatus: r.status,
        access: null,
        signIn: r.account?.id ? toSignIn(r.account as AccountRow, slips, locks) : null,
        order: r.classOrder ?? 9999,
        rollNo: r.rollNo,
      };
    })
    .sort(inClassOrder);
}

/** Students by class, section and roll number (then name); students not placed this session come last. */
export function inClassOrder(a: AccessPerson, b: AccessPerson): number {
  return a.order - b.order || (a.detail ?? "").localeCompare(b.detail ?? "") || (a.rollNo ?? 9999) - (b.rollNo ?? 9999) || a.name.localeCompare(b.name);
}

/** Staff by employee number, counted as numbers (E2 before E10). */
export function byEmployeeNo(a: AccessPerson, b: AccessPerson): number {
  return Number(a.number) - Number(b.number) || a.number.localeCompare(b.number) || a.name.localeCompare(b.name);
}

/** Every staff member of a school (any status) with their account, by name. */
export async function staffAccessPeople(schoolId: string): Promise<AccessPerson[]> {
  const db = await getDb();
  const [school] = await db.select({ prefix: schools.loginPrefix }).from(schools).where(eq(schools.id, schoolId));
  const rows = await db
    .select({
      id: staff.id,
      name: staff.name,
      empNo: staff.empNo,
      designation: staff.designation,
      access: staff.access,
      status: staff.status,
      account: accountColumns,
    })
    .from(staff)
    .leftJoin(accounts, eq(accounts.staffId, staff.id))
    .where(eq(staff.schoolId, schoolId))
    .orderBy(asc(staff.name));
  const [slips, locks] = await Promise.all([
    slipStates(rows.map((r) => r.account?.id).filter((x): x is string => !!x)),
    locksFor(rows.map((r) => (r.account?.id ? r.account : null))),
  ]);
  return rows.map(
    (r): AccessPerson => ({
      kind: "staff",
      id: r.id,
      name: r.name,
      loginId: r.account?.id ? displayLoginId(r.account.loginId) : displayLoginId(staffLoginId(school?.prefix ?? "", r.empNo)),
      number: r.empNo,
      detail: r.designation,
      detailLong: r.designation,
      sectionId: null,
      current: r.status === "active",
      personStatus: r.status,
      access: r.access,
      signIn: r.account?.id ? toSignIn(r.account as AccountRow, slips, locks) : null,
      order: 0,
      rollNo: null,
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

export const STATUS_FILTERS = ["all", "not_activated", "active", "turned_off"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export function isStatusFilter(v: unknown): v is StatusFilter {
  return typeof v === "string" && (STATUS_FILTERS as readonly string[]).includes(v);
}

/**
 * Where a person stands, in the filter's terms. Staff whose portal access is
 * "No login" (drivers, helpers) have no sign-in to turn off, so they are in
 * no group of their own: they count only under "All". A student without an
 * account counts as turned off.
 */
export function statusGroup(p: AccessPerson): Exclude<StatusFilter, "all"> | "no_access" {
  if (p.kind === "staff" && p.access === "none") return "no_access";
  const s = p.signIn?.status;
  if (s === "active") return "active";
  if (s === "pending") return "not_activated";
  return "turned_off";
}

/**
 * Narrow the list: a class section, a search (login ID, name, or SR / employee
 * number), and whether to show people who have left. People who have left
 * are only shown when searched for — unless their sign-in is still on.
 */
export function narrowPeople(people: AccessPerson[], opts: { sectionId?: string | null; q?: string | null }): AccessPerson[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const qId = q ? normalizeLoginId(q) : "";
  const qDigits = /^\d+$/.test(q) ? String(Number(q)) : null;
  return people.filter((p) => {
    if (opts.sectionId && p.sectionId !== opts.sectionId) return false;
    if (!q) return p.current || (p.signIn !== null && p.signIn.status !== "disabled");
    return (
      p.loginId.toLowerCase().startsWith(qId) ||
      p.name.toLowerCase().includes(q) ||
      (qDigits !== null && p.number.startsWith(qDigits))
    );
  });
}

export function countByStatus(people: AccessPerson[]): Record<StatusFilter, number> {
  const out: Record<StatusFilter, number> = { all: people.length, not_activated: 0, active: 0, turned_off: 0 };
  for (const p of people) {
    const g = statusGroup(p);
    if (g !== "no_access") out[g]++;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Slips for many people at once                                       */
/* ------------------------------------------------------------------ */

/**
 * Still waiting to activate: a current student, or a staff member with
 * portal access, whose account has no password yet and isn't turned off.
 */
export function awaitingActivation(p: AccessPerson): boolean {
  const s = p.signIn;
  return !!s && p.current && s.status === "pending" && !s.hasPassword && !(p.kind === "staff" && p.access === "none");
}

export type SlipQueue = {
  /** Who gets a slip, in printing order: staff by employee number, then students by class, section and roll number. */
  people: AccessPerson[];
  /** How many of them hold an unused slip that still works: a new slip cancels it. */
  replaced: number;
  /** Also waiting, but their slips are printed by an AESRI administrator only (principal, office admins). */
  adminOnly: number;
};

/**
 * Everyone among `people` who is waiting to activate and whose slip this
 * person may print (the same rules as ticking rows: never their own; the
 * principal's and office admins' only by an AESRI administrator), in the
 * order the slips come out, so class teachers can hand them out.
 * Never includes anyone who has activated: printing for them would reset
 * their password, which needs its own confirmation.
 */
export function slipQueue(people: AccessPerson[], actor: { accountId: string; role: Role }): SlipQueue {
  const waiting = people.filter((p) => awaitingActivation(p) && p.signIn!.accountId !== actor.accountId);
  const mine = waiting.filter((p) => mayPrintSlipFor(actor.role, p.signIn!.role));
  const ordered = [...mine.filter((p) => p.kind === "staff").sort(byEmployeeNo), ...mine.filter((p) => p.kind === "student").sort(inClassOrder)];
  return { people: ordered, replaced: ordered.filter((p) => p.signIn!.slip.kind === "valid").length, adminOnly: waiting.length - mine.length };
}

/* ------------------------------------------------------------------ */
/* Figures for the AESRI overview                                      */
/* ------------------------------------------------------------------ */

export type SignInFigures = {
  /** Current students with a sign-in that isn't turned off. */
  families: { active: number; total: number };
  /** Current staff with portal access. */
  staff: { active: number; total: number };
};

export async function signInFigures(schoolId: string): Promise<SignInFigures> {
  const db = await getDb();
  const [fam, stf] = await Promise.all([
    db
      .select({ status: accounts.status, n: count() })
      .from(accounts)
      .innerJoin(students, eq(students.id, accounts.studentId))
      .where(and(eq(students.schoolId, schoolId), eq(students.status, "active"), ne(accounts.status, "disabled")))
      .groupBy(accounts.status),
    db
      .select({ status: accounts.status, n: count() })
      .from(accounts)
      .innerJoin(staff, eq(staff.id, accounts.staffId))
      .where(and(eq(staff.schoolId, schoolId), eq(staff.status, "active"), ne(accounts.status, "disabled")))
      .groupBy(accounts.status),
  ]);
  const tally = (rows: { status: AccountStatus; n: number }[]) => ({
    active: Number(rows.find((r) => r.status === "active")?.n ?? 0),
    total: rows.reduce((t, r) => t + Number(r.n), 0),
  });
  return { families: tally(fam), staff: tally(stf) };
}

/** Current students and staff of a school. */
export async function headcounts(schoolId: string): Promise<{ students: number; staff: number }> {
  const db = await getDb();
  const [[s], [t]] = await Promise.all([
    db.select({ n: count() }).from(students).where(and(eq(students.schoolId, schoolId), eq(students.status, "active"))),
    db.select({ n: count() }).from(staff).where(and(eq(staff.schoolId, schoolId), eq(staff.status, "active"))),
  ]);
  return { students: Number(s?.n ?? 0), staff: Number(t?.n ?? 0) };
}

/** Principal, office admins and accountants of each school (for the AESRI administrators page). */
export async function schoolOfficeStaff() {
  const db = await getDb();
  const rows = await db
    .select({
      schoolId: staff.schoolId,
      id: staff.id,
      name: staff.name,
      designation: staff.designation,
      access: staff.access,
      account: accountColumns,
    })
    .from(staff)
    .leftJoin(accounts, eq(accounts.staffId, staff.id))
    .where(and(eq(staff.status, "active"), inArray(staff.access, ["principal", "office_admin", "accounts"])))
    .orderBy(sql`case ${staff.access} when 'principal' then 0 when 'office_admin' then 1 else 2 end`, asc(staff.name));
  const [slips, locks] = await Promise.all([
    slipStates(rows.map((r) => r.account?.id).filter((x): x is string => !!x)),
    locksFor(rows.map((r) => (r.account?.id ? r.account : null))),
  ]);
  return rows.map((r) => ({
    schoolId: r.schoolId,
    id: r.id,
    name: r.name,
    designation: r.designation,
    access: r.access,
    signIn: r.account?.id ? toSignIn(r.account as AccountRow, slips, locks) : null,
  }));
}
