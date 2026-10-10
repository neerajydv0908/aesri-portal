/**
 * The activity log: a school's audit entries, filtered by date, area and
 * person, with each entry told as a plain sentence ("Printed an activation
 * slip for Arya7634") and a link to the record where a page exists.
 *
 * Areas are found by the action's prefix ("fees.payment" → Fees), so
 * actions added later land in the right area and still read sensibly.
 */
import "server-only";
import { and, count, desc, eq, gte, inArray, isNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accounts, auditLog, classes, exams, notices, sections, staff, students, subjects } from "@/lib/db/schema";
import { classLabel, sectionLabel } from "@/lib/classes";
import { addDays, formatDate, isValidIsoDate, todayIST } from "@/lib/dates";
import { displayLoginId, isStaffLoginId, normalizeLoginId } from "@/lib/ids";
import { ACCESS_LABELS, type StaffAccess } from "@/lib/roles";
import { peopleByAccount, type Person } from "@/lib/services/attendance";
import { rupees } from "@/lib/services/fees";
import { PROVIDER_LABELS } from "@/lib/sms/config";
import { smsSettingName } from "@/lib/sms/settings";

/* ------------------------------------------------------------------ */
/* Areas                                                               */
/* ------------------------------------------------------------------ */

export const LOG_AREAS = [
  { key: "signin", label: "Sign-in", prefixes: ["auth."] },
  { key: "accounts", label: "Slips & accounts", prefixes: ["account."] },
  { key: "students", label: "Students", prefixes: ["student."] },
  { key: "staff", label: "Staff", prefixes: ["staff."] },
  { key: "classes", label: "Classes", prefixes: ["class.", "section.", "subject."] },
  { key: "attendance", label: "Attendance", prefixes: ["attendance."] },
  { key: "homework", label: "Homework", prefixes: ["homework."] },
  { key: "remarks", label: "Remarks", prefixes: ["remark."] },
  { key: "notices", label: "Notices", prefixes: ["notice."] },
  { key: "exams", label: "Exams & marks", prefixes: ["exam.", "marks.", "report_remarks."] },
  { key: "fees", label: "Fees", prefixes: ["fees."] },
  { key: "import", label: "Import", prefixes: ["import."] },
  { key: "settings", label: "Settings", prefixes: ["settings."] },
  { key: "sms", label: "Text messages", prefixes: ["sms."] },
  { key: "ai", label: "Old AI assistant", prefixes: ["ai."] },
] as const;

export type LogAreaKey = (typeof LOG_AREAS)[number]["key"];

export function isLogArea(v: unknown): v is LogAreaKey {
  return LOG_AREAS.some((a) => a.key === v);
}

export function areaOf(action: string) {
  return LOG_AREAS.find((a) => a.prefixes.some((p) => action.startsWith(p))) ?? null;
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

export const LOG_PAGE_SIZE = 50;

/** Someone to follow in the log: what they did, and what was done to their account or record. */
export type PersonMatch = { input: string; login: string; accountId: string | null; studentId: string | null; staffId: string | null };

/** Find the account behind a login ID (in this school, or an AESRI administrator when schoolId is null). */
export async function resolvePerson(schoolId: string | null, input: string): Promise<PersonMatch | null> {
  const login = normalizeLoginId(input);
  if (!login) return null;
  const db = await getDb();
  const [acc] = await db
    .select({ id: accounts.id, schoolId: accounts.schoolId, studentId: accounts.studentId, staffId: accounts.staffId })
    .from(accounts)
    .where(eq(accounts.loginId, login));
  const mine = acc && (schoolId ? acc.schoolId === schoolId : acc.schoolId === null);
  return { input, login, accountId: mine ? acc.id : null, studentId: mine ? acc.studentId : null, staffId: mine ? acc.staffId : null };
}

export type LogFilter = {
  /** null: AESRI-level entries (not tied to a school). */
  schoolId: string | null;
  from: string;
  to: string;
  area: LogAreaKey | null;
  person: PersonMatch | null;
  page: number;
};

/** Midnight at the start of an IST day. */
const istStart = (iso: string) => new Date(`${iso}T00:00:00+05:30`);

function whereOf(f: LogFilter): SQL {
  const conds: (SQL | undefined)[] = [
    f.schoolId ? eq(auditLog.schoolId, f.schoolId) : isNull(auditLog.schoolId),
    gte(auditLog.at, istStart(f.from)),
    lt(auditLog.at, istStart(addDays(f.to, 1))),
  ];
  const area = f.area ? LOG_AREAS.find((a) => a.key === f.area) : null;
  if (area) conds.push(or(...area.prefixes.map((p) => like(auditLog.action, `${p}%`))));
  const p = f.person;
  if (p) {
    conds.push(
      or(
        sql`lower(${auditLog.actorLogin}) = ${p.login}`,
        p.accountId ? eq(auditLog.actorId, p.accountId) : undefined,
        p.accountId ? and(eq(auditLog.targetType, "account"), eq(auditLog.targetId, p.accountId)) : undefined,
        p.studentId ? and(eq(auditLog.targetType, "student"), eq(auditLog.targetId, p.studentId)) : undefined,
        p.studentId ? sql`${auditLog.details}->>'studentId' = ${p.studentId}` : undefined,
        p.staffId ? and(eq(auditLog.targetType, "staff"), eq(auditLog.targetId, p.staffId)) : undefined,
        p.staffId ? sql`${auditLog.details}->>'staffId' = ${p.staffId}` : undefined,
      ),
    );
  }
  return and(...conds)!;
}

/* ------------------------------------------------------------------ */
/* Entries                                                             */
/* ------------------------------------------------------------------ */

export type LogEntry = {
  id: number;
  at: Date;
  action: string;
  areaLabel: string | null;
  who: { name: string | null; loginId: string | null };
  text: string;
  link: { href: string; label: string } | null;
  ip: string | null;
  /** Recorded details worth showing (no internal IDs), as label → value. */
  facts: [string, string][];
};

type Row = typeof auditLog.$inferSelect;

type Lookups = {
  people: Map<string, Person & { studentId: string | null; staffId: string | null; role: string }>;
  students: Map<string, { name: string; srNo: string }>;
  staff: Map<string, string>;
  sections: Map<string, string>;
  notices: Map<string, { title: string; audience: string }>;
  exams: Map<string, string>;
  subjects: Map<string, string>;
  classes: Map<string, string>;
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (xs: unknown[]) => [...new Set(xs.filter((x): x is string => typeof x === "string" && UUID.test(x)))];

async function lookups(rows: Row[], schoolId: string | null): Promise<Lookups> {
  const d = (r: Row) => r.details ?? {};
  const by = (type: string) => rows.filter((r) => r.targetType === type).map((r) => r.targetId);
  const accountIds = ids([...rows.map((r) => r.actorId), ...by("account")]);
  const studentIds = ids([...by("student"), ...rows.map((r) => d(r).studentId)]);
  const staffIds = ids([...by("staff"), ...rows.map((r) => d(r).staffId)]);
  const resultTargets = by("exam_result").map((t) => (t ?? "").split(":"));
  const sectionIds = ids([...by("section"), ...rows.flatMap((r) => [d(r).sectionId, d(r).from]), ...resultTargets.map((t) => t[1])]);
  const noticeIds = ids(by("notice"));
  const examIds = ids([...by("exam"), ...resultTargets.map((t) => t[0])]);
  const subjectIds = ids(rows.map((r) => d(r).subjectId));
  const classIds = ids([...by("class"), ...rows.map((r) => d(r).classId)]);

  const db = await getDb();
  const [people, accountRows, studentRows, staffRows, sectionRows, noticeRows, examRows, subjectRows, classRows] = await Promise.all([
    peopleByAccount(accountIds),
    accountIds.length ? db.select({ id: accounts.id, studentId: accounts.studentId, staffId: accounts.staffId, role: accounts.role }).from(accounts).where(inArray(accounts.id, accountIds)) : [],
    studentIds.length && schoolId
      ? db.select({ id: students.id, name: students.name, srNo: students.srNo }).from(students).where(and(inArray(students.id, studentIds), eq(students.schoolId, schoolId)))
      : [],
    staffIds.length && schoolId ? db.select({ id: staff.id, name: staff.name }).from(staff).where(and(inArray(staff.id, staffIds), eq(staff.schoolId, schoolId))) : [],
    sectionIds.length && schoolId
      ? db
          .select({ id: sections.id, name: sections.name, className: classes.name })
          .from(sections)
          .innerJoin(classes, eq(classes.id, sections.classId))
          .where(and(inArray(sections.id, sectionIds), eq(classes.schoolId, schoolId)))
      : [],
    noticeIds.length && schoolId
      ? db.select({ id: notices.id, title: notices.titleEn, audience: notices.audience }).from(notices).where(and(inArray(notices.id, noticeIds), eq(notices.schoolId, schoolId)))
      : [],
    examIds.length && schoolId ? db.select({ id: exams.id, name: exams.name }).from(exams).where(and(inArray(exams.id, examIds), eq(exams.schoolId, schoolId))) : [],
    subjectIds.length && schoolId ? db.select({ id: subjects.id, name: subjects.name }).from(subjects).where(and(inArray(subjects.id, subjectIds), eq(subjects.schoolId, schoolId))) : [],
    classIds.length && schoolId
      ? db.select({ id: classes.id, name: classes.name, stream: classes.stream }).from(classes).where(and(inArray(classes.id, classIds), eq(classes.schoolId, schoolId)))
      : [],
  ]);
  const accBy = new Map(accountRows.map((a) => [a.id, a]));
  const peopleFull = new Map<string, Person & { studentId: string | null; staffId: string | null; role: string }>();
  for (const [id, p] of people) {
    const a = accBy.get(id);
    peopleFull.set(id, { ...p, studentId: a?.studentId ?? null, staffId: a?.staffId ?? null, role: a?.role ?? "" });
  }
  return {
    people: peopleFull,
    students: new Map(studentRows.map((s) => [s.id, { name: s.name, srNo: s.srNo }])),
    staff: new Map(staffRows.map((s) => [s.id, s.name])),
    sections: new Map(sectionRows.map((s) => [s.id, sectionLabel(s.className, s.name)])),
    notices: new Map(noticeRows.map((n) => [n.id, { title: n.title, audience: n.audience }])),
    exams: new Map(examRows.map((x) => [x.id, x.name])),
    subjects: new Map(subjectRows.map((s) => [s.id, s.name])),
    classes: new Map(classRows.map((c) => [c.id, classLabel(c.name, c.stream)])),
  };
}

/* ------------------------------------------------------------------ */
/* Sentences                                                           */
/* ------------------------------------------------------------------ */

const STUDENT_FIELDS: Record<string, string> = {
  name: "name",
  dob: "date of birth",
  gender: "gender",
  fatherName: "father’s name",
  motherName: "mother’s name",
  guardianName: "guardian’s name",
  guardianMobile: "parent’s mobile",
  mobile2: "second mobile",
  address: "address",
  admittedOn: "admission date",
  rte: "RTE seat",
  status: "status",
  leftOn: "date of leaving",
};
const STAFF_FIELDS: Record<string, string> = {
  name: "name",
  designation: "designation",
  access: "portal access",
  mobile: "mobile",
  email: "email",
  joinedOn: "joining date",
  status: "status",
};
const SETTING_NAMES: Record<string, string> = { passPercent: "pass mark", attendanceWarnPercent: "attendance warning", phone: "office phone", email: "office email" };
const REASONS: Record<string, string> = {
  student_left: "the student left the school",
  student_transferred: "the student was transferred",
  student_passed_out: "the student passed out",
  student_current: "the student is at school again",
};

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function fieldWords(v: unknown, names: Record<string, string>): string {
  const fields = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return fields.length ? ` (${list(fields.map((f) => names[f] ?? f))})` : "";
}

const quote = (s: string | null) => (s ? `“${s}”` : "");
const SUPPORT_RULE_NAMES: Record<string, string> = {
  riskRedPercent: "retired model threshold",
  attendanceRedPercent: "attendance below",
  concernsRed: "concerns",
  concernDays: "in the last",
};
const TASK_WORDS: Record<string, string> = {
  lesson_plan: "a lesson plan draft",
  worksheet: "a worksheet or quiz draft",
  question_paper: "a question paper draft",
  report_remarks: "report-card remark drafts",
  support: "support suggestions",
};
const money = (v: unknown) => (num(v) !== null ? rupees(num(v)!) : null);
const dateText = (v: unknown) => (typeof v === "string" && isValidIsoDate(v) ? formatDate(v) : null);
/** A stored timestamp (ISO text) as its day in India: "2 Nov 2026". */
const dayOf = (v: unknown) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? formatDate(todayIST(new Date(t))) : null;
};

type Described = { text: string; link: { href: string; label: string } | null };

function describe(r: Row, L: Lookups): Described {
  const d = (r.details ?? {}) as Record<string, unknown>;
  const [verbArea] = r.action.split(".");
  const target = r.targetId ?? "";
  const student = (id: unknown) => (typeof id === "string" ? L.students.get(id)?.name : undefined) ?? null;
  const studentLink = (id: unknown, label = "Student record") =>
    typeof id === "string" && L.students.has(id) ? { href: `/office/students/${id}`, label } : null;
  const staffName = (id: unknown) => (typeof id === "string" ? L.staff.get(id) : undefined) ?? null;
  const section = (id: unknown, fallback?: unknown) => (typeof id === "string" ? L.sections.get(id) : undefined) ?? str(fallback) ?? "a class";
  const accountLink = (): Described["link"] => {
    const p = L.people.get(target);
    const loginId = p?.loginId ?? str(d.loginId);
    if (!loginId) return null;
    if (p?.role === "super_admin" || (!p && !/^(arya|aadhar)/i.test(loginId))) return { href: "/aesri/admins", label: "AESRI administrators" };
    const staffId = isStaffLoginId(normalizeLoginId(loginId));
    return { href: `/office/access?${staffId ? "tab=staff&" : ""}q=${encodeURIComponent(loginId)}`, label: "Slips & sign-in" };
  };
  const loginOf = () => str(d.loginId) ?? L.people.get(target)?.loginId ?? "an account";
  /** Slips & sign-in, found by the entry's own account (sign-in entries have no target). */
  const accountSelfLink = (): Described["link"] => {
    const p = r.actorId ? L.people.get(r.actorId) : undefined;
    const loginId = p?.loginId ?? (r.actorLogin ? displayLoginId(r.actorLogin) : null);
    if (!loginId || p?.role === "super_admin" || !/^(arya|aadhar)/i.test(loginId)) return null;
    return { href: `/office/access?${isStaffLoginId(normalizeLoginId(loginId)) ? "tab=staff&" : ""}q=${encodeURIComponent(loginId)}`, label: "Slips & sign-in" };
  };

  switch (r.action) {
    /* Sign-in */
    case "auth.login":
      return { text: "Signed in", link: null };
    case "auth.login_failed":
      return { text: "Someone tried to sign in to this account with a wrong password", link: null };
    case "auth.login_refused":
      // The person signing in is told only that the login ID or password is not right.
      return d.reason === "not_activated"
        ? { text: "Someone tried to sign in, but this account hasn’t been activated with its slip yet", link: accountSelfLink() }
        : { text: "Someone tried to sign in, but sign-in is turned off for this account", link: accountSelfLink() };
    case "auth.2fa_failed":
      return { text: "Entered a wrong authenticator code", link: null };
    case "auth.locked":
      return d.reason === "codes"
        ? { text: "Two-step sign-in was locked after 20 wrong authenticator codes in a row: it stays locked until someone unlocks it", link: accountSelfLink() ?? accountLink() }
        : d.reason === "day"
          ? { text: "100 wrong passwords in a day: until the day is over or someone unlocks it, phones and computers that never signed in to this account get one try every 10 minutes", link: accountSelfLink() ?? accountLink() }
          : { text: "Sign-in was locked for 15 minutes after 20 wrong passwords from different places", link: accountSelfLink() ?? accountLink() };
    case "auth.logout":
      return { text: "Signed out", link: null };
    case "auth.2fa_passed":
      return { text: "Entered the authenticator code", link: null };
    case "auth.2fa_enabled":
      return { text: "Set up the authenticator app", link: null };
    case "auth.browser_trusted":
      return { text: `Trusted this browser${str(d.browser) ? ` (${str(d.browser)})` : ""}${dayOf(d.until) ? ` until ${dayOf(d.until)}` : ""}: signing in on it needs only the password until then`, link: null };
    case "auth.2fa_trusted_browser":
      return { text: `Signed in on a trusted browser${str(d.browser) ? ` (${str(d.browser)})` : ""}, so no authenticator code was asked for`, link: null };

    /* Slips & accounts */
    case "account.activation_slip":
      return { text: `Printed an activation slip for ${loginOf()}`, link: accountLink() };
    case "account.reset_slip":
      return { text: `Printed a new slip for ${loginOf()} (password reset)`, link: accountLink() };
    case "account.activated":
      return { text: d.via === "reset" ? "Chose a new password with a slip" : "Activated their account with a slip", link: null };
    case "account.unlocked":
      return { text: `Unlocked sign-in for ${loginOf()} after too many wrong tries`, link: accountLink() };
    case "account.enabled": {
      const why = str(d.reason) ? REASONS[str(d.reason)!] : null;
      return { text: `Turned sign-in on for ${loginOf()}${why ? ` (${why})` : ""}`, link: accountLink() };
    }
    case "account.disabled": {
      const why = str(d.reason) ? REASONS[str(d.reason)!] : null;
      return { text: `Turned sign-in off for ${loginOf()}${why ? ` (${why})` : ""}`, link: accountLink() };
    }
    case "account.password_changed": {
      const n = num(d.signedOutElsewhere) ?? 0;
      const b = num(d.trustedBrowsersForgotten) ?? 0;
      return {
        text: `Changed their password${n ? ` and was signed out on ${n === 1 ? "1 other device" : `${n} other devices`}` : ""}${b ? `; ${b === 1 ? "1 trusted browser was" : `${b} trusted browsers were`} forgotten` : ""}`,
        link: null,
      };
    }
    case "account.password_change_failed":
      return { text: "Tried to change their password: the current password was wrong", link: null };
    case "account.signed_out_elsewhere": {
      const n = num(d.sessions) ?? 0;
      const b = num(d.trustedBrowsers) ?? 0;
      return { text: `Signed out on all other devices${n ? ` (${n})` : ""}${b ? ` and forgot ${b === 1 ? "1 trusted browser" : `${b} trusted browsers`} there` : ""}`, link: null };
    }
    case "account.trusted_browsers_forgotten": {
      const n = num(d.count) ?? 0;
      return d.scope === "one"
        ? { text: `Forgot a trusted browser${str(d.browser) ? ` (${str(d.browser)})` : ""}: signing in there asks for the authenticator code again`, link: null }
        : { text: `Forgot all trusted browsers${n ? ` (${n})` : ""}: every sign-in asks for the authenticator code again`, link: null };
    }
    case "account.admin_created":
      return { text: `Added the AESRI administrator ${str(d.loginId) ?? ""}${str(d.name) ? ` (${str(d.name)})` : ""}`, link: { href: "/aesri/admins", label: "AESRI administrators" } };

    /* Students */
    case "student.created":
      return { text: `Added the student ${str(d.name) ?? student(target) ?? ""}${str(d.srNo) ? ` (SR ${str(d.srNo)})` : ""}`, link: studentLink(target) };
    case "student.updated":
      return { text: `Updated ${student(target) ? `${student(target)}’s` : "a student’s"} record${fieldWords(d.fields, STUDENT_FIELDS)}`, link: studentLink(target) };
    case "student.placed": {
      const who = student(target) ?? "a student";
      const to = section(d.sectionId);
      return { text: str(d.from) && d.from !== d.sectionId ? `Moved ${who} from ${section(d.from)} to ${to}` : `Placed ${who} in ${to}`, link: studentLink(target) };
    }

    /* Staff */
    case "staff.created": {
      const access = str(d.access) as StaffAccess | null;
      return { text: `Added the staff member ${str(d.name) ?? staffName(target) ?? ""}${access && ACCESS_LABELS[access] ? ` (portal access: ${ACCESS_LABELS[access]})` : ""}`, link: { href: `/office/staff/${target}`, label: "Staff record" } };
    }
    case "staff.updated":
      return { text: `Updated ${staffName(target) ? `${staffName(target)}’s` : "a staff member’s"} record${fieldWords(d.fields, STAFF_FIELDS)}`, link: { href: `/office/staff/${target}`, label: "Staff record" } };
    case "staff.subjects":
      return { text: `Changed the subjects ${staffName(target) ?? "a staff member"} teaches`, link: { href: `/office/staff/${target}`, label: "Staff record" } };

    /* Classes */
    case "section.class_teacher":
      return {
        text: str(d.staffId) ? `Made ${staffName(d.staffId) ?? "a teacher"} the class teacher of ${section(target)}` : `Removed the class teacher of ${section(target)}`,
        link: { href: "/office/classes", label: "Classes & subjects" },
      };
    case "section.subject_teacher": {
      const subject = (typeof d.subjectId === "string" && L.subjects.get(d.subjectId)) || "a subject";
      return {
        text: str(d.staffId) ? `Set ${staffName(d.staffId) ?? "a teacher"} to teach ${subject} in ${section(target)}` : `Removed the ${subject} teacher of ${section(target)}`,
        link: { href: "/office/classes", label: "Classes & subjects" },
      };
    }
    case "section.added":
      return { text: `Added the section ${section(target, d.section)}`, link: { href: "/office/classes", label: "Classes & subjects" } };
    case "section.removed":
      return { text: `Removed the section ${str(d.section) ?? section(target)}`, link: { href: "/office/classes", label: "Classes & subjects" } };
    case "class.subjects": {
      const cls = L.classes.get(target) ?? "a class";
      const added = num(d.added) ?? 0;
      const removed = num(d.removed) ?? 0;
      const parts = [added ? `${added} added` : "", removed ? `${removed} removed` : ""].filter(Boolean);
      return { text: `Changed the subjects taught in ${cls}${parts.length ? ` (${parts.join(", ")})` : ""}`, link: { href: "/office/classes", label: "Classes & subjects" } };
    }
    case "subject.added":
      return {
        text: `Added the subject ${str(d.name) ?? ""}${d.via === "import" ? " (from an Excel import)" : ""}`,
        link: { href: "/office/classes", label: "Classes & subjects" },
      };
    case "subject.renamed": {
      const before = (d.before ?? {}) as Record<string, unknown>;
      const after = (d.after ?? {}) as Record<string, unknown>;
      return { text: `Renamed the subject ${str(before.name) ?? ""} to ${str(after.name) ?? ""}`, link: { href: "/office/classes", label: "Classes & subjects" } };
    }
    case "subject.removed":
      return { text: `Removed the subject ${str(d.name) ?? ""}`, link: { href: "/office/classes", label: "Classes & subjects" } };

    /* Attendance */
    case "attendance.taken":
    case "attendance.changed": {
      const day = dateText(d.date);
      return {
        text: `${r.action === "attendance.taken" ? "Took" : "Changed"} attendance for ${section(target, d.section)}${day ? ` on ${day}` : ""}`,
        link: str(d.date) ? { href: `/office/attendance?date=${str(d.date)}`, label: "Attendance" } : null,
      };
    }

    /* Homework */
    case "homework.created":
      return { text: `Set the homework ${quote(str(d.title))} for ${section(d.sectionId, d.section)}`, link: { href: `/teach/homework/${target}`, label: "Homework" } };
    case "homework.updated":
      return { text: `Changed homework for ${str(d.section) ?? "a class"}`, link: { href: `/teach/homework/${target}`, label: "Homework" } };
    case "homework.deleted":
      return { text: `Deleted the homework ${quote(str(d.title))} for ${section(d.sectionId, d.section)}`, link: null };
    case "homework.checked":
      return { text: `Checked the homework ${quote(str(d.title))} in ${str(d.section) ?? "a class"}`, link: { href: `/teach/homework/${target}`, label: "Homework" } };

    /* Remarks */
    case "remark.created":
      return {
        text: `Wrote ${d.kind === "concern" ? "a concern" : "a word of appreciation"} about ${student(d.studentId) ?? "a student"}`,
        link: studentLink(d.studentId),
      };
    case "remark.updated":
      return { text: `Changed a remark about ${student(d.studentId) ?? "a student"}`, link: studentLink(d.studentId) };
    case "remark.deleted":
      return { text: `Deleted a remark about ${student(d.studentId) ?? "a student"}`, link: studentLink(d.studentId) };

    /* Notices */
    case "notice.created":
    case "notice.updated":
    case "notice.published":
    case "notice.archived": {
      const n = L.notices.get(target);
      const title = str(d.title) ?? n?.title ?? null;
      const link = n
        ? n.audience === "school" || n.audience === "staff"
          ? { href: `/office/notices/${target}`, label: "Notice" }
          : { href: "/office/notices?status=published", label: "Notices" }
        : null;
      if (r.action === "notice.created") {
        if (d.audience === "section") return { text: `Posted the class notice ${quote(title)} to ${str(d.section) ?? section(d.sectionId)}`, link };
        if (d.audience === "students") {
          const k = num(d.recipients) ?? 0;
          return { text: `Posted the notice ${quote(title)} to ${k} ${k === 1 ? "student" : "students"} of ${str(d.section) ?? section(d.sectionId)}`, link };
        }
        return { text: `${d.status === "published" ? "Wrote and published" : "Drafted"} the notice ${quote(title)}`, link };
      }
      if (r.action === "notice.updated") return { text: `Changed the notice ${quote(title)}${num(d.version) ? ` (now version ${num(d.version)})` : ""}`, link };
      if (r.action === "notice.published") return { text: `Published the notice ${quote(title)}`, link };
      return { text: `Archived the notice ${quote(title)}`, link };
    }

    /* Exams & marks */
    case "exam.created":
      return { text: `Added the exam ${quote(str(d.name) ?? L.exams.get(target) ?? null)}`, link: { href: `/office/exams/${target}`, label: "Exam" } };
    case "exam.updated":
      return {
        text:
          str(d.previousName) && d.previousName !== d.name
            ? `Renamed the exam ${quote(str(d.previousName))} to ${quote(str(d.name))}`
            : `Changed the order of the exam ${quote(str(d.name))}`,
        link: { href: `/office/exams/${target}`, label: "Exam" },
      };
    case "exam.deleted":
      return { text: `Deleted the exam ${quote(str(d.name))}`, link: null };
    case "exam.papers_set":
      return {
        text: `Set the maximum marks for ${str(d.className) ? classLabel(str(d.className)!) : "a class"} in ${quote(str(d.exam))}`,
        link: { href: `/office/exams/${target}`, label: "Exam" },
      };
    case "marks.saved":
    case "exam.results_submitted":
    case "exam.results_published":
    case "exam.results_reopened": {
      const [examId, sectionId] = target.split(":");
      const exam = quote(str(d.exam) ?? L.exams.get(examId) ?? null);
      const sec = str(d.section) ?? section(sectionId);
      const link = examId && UUID.test(examId) ? { href: `/office/exams/${examId}`, label: "Exam" } : null;
      if (r.action === "marks.saved") return { text: `Saved ${str(d.subject) ?? "subject"} marks for ${sec} in ${exam}`, link };
      if (r.action === "exam.results_submitted") return { text: `Sent the ${exam} results of ${sec} to the office`, link };
      if (r.action === "exam.results_published") return { text: `Published the ${exam} results of ${sec}`, link };
      return { text: `Reopened the ${exam} results of ${sec}${str(d.reason) ? `: ${str(d.reason)}` : ""}`, link };
    }

    /* Fees */
    case "fees.payment":
    case "fees.online_payment":
    case "fees.opening_balance": {
      const amount = money(d.amount) ?? "a payment";
      const who = student(d.studentId);
      const receipt = str(d.receiptNo) ? ` (receipt ${str(d.receiptNo)})` : "";
      const link = { href: `/office/fees/receipts/${target}`, label: "Receipt" };
      if (r.action === "fees.online_payment") return { text: `Received an online payment of ${amount}${who ? ` for ${who}` : ""}${receipt}`, link };
      if (r.action === "fees.opening_balance") return { text: `Recorded ${amount} paid before the portal${who ? ` for ${who}` : ""}${receipt}`, link };
      return { text: `Recorded a payment of ${amount}${who ? ` for ${who}` : ""}${receipt}`, link };
    }
    case "fees.payment_reversed":
      return {
        text: `Cancelled receipt ${str(d.receiptNo) ?? ""}${money(d.amount) ? ` (${money(d.amount)})` : ""}${str(d.reason) ? `: ${str(d.reason)}` : ""}`,
        link: { href: `/office/fees/receipts/${target}`, label: "Receipt" },
      };
    case "fees.opening_batch":
      return {
        text: `Saved opening balances: ${num(d.receipts) ?? 0} ${num(d.receipts) === 1 ? "receipt" : "receipts"}${money(d.total) ? `, ${money(d.total)} in all` : ""}`,
        link: { href: "/office/fees/opening", label: "Opening balances" },
      };
    case "fees.opening_none":
      return {
        text: `Marked that nobody in ${str(d.section) ?? "a class"} paid fees on paper before the portal`,
        link: { href: "/office/fees/opening", label: "Opening balances" },
      };
    case "fees.charge_waived":
      return { text: `Waived ${quote(str(d.label))}${money(d.waived) ? ` (${money(d.waived)})` : ""} for ${student(d.studentId) ?? "a student"}`, link: feesLink(d.studentId, L) };
    case "fees.charge_restored":
      return { text: `Restored ${quote(str(d.label))} for ${student(d.studentId) ?? "a student"}`, link: feesLink(d.studentId, L) };
    case "fees.admission_fee_added":
      return { text: `Added the admission fee for ${student(d.studentId) ?? "a student"}`, link: feesLink(d.studentId, L) };
    case "fees.rte_waived":
      return { text: `Waived this session’s fees for ${student(target) ?? "a student"} (RTE seat)`, link: feesLink(target, L) };
    case "fees.rte_restored":
      return { text: `Restored this session’s fees for ${student(target) ?? "a student"} (no longer an RTE seat)`, link: feesLink(target, L) };
    case "fees.charges_repriced":
      return { text: `Changed ${student(target) ? `${student(target)}’s` : "a student’s"} fees to the ${str(d.className) ? classLabel(str(d.className)!) : "new class’s"} fee`, link: feesLink(target, L) };
    case "fees.plan_split_changed":
      return { text: "Changed the instalment split of the fee plan", link: { href: "/office/fees/plan", label: "Fee plan" } };
    case "fees.collections_exported":
      return { text: `Downloaded the collections list${dateText(d.from) && dateText(d.to) ? ` for ${dateText(d.from)} to ${dateText(d.to)}` : ""}`, link: { href: "/office/fees/collections", label: "Collections" } };
    case "fees.online_order_created":
      return { text: `Started an online payment of ${money(d.amount) ?? "fees"}${student(d.studentId) ? ` for ${student(d.studentId)}` : ""}`, link: feesLink(d.studentId, L) };
    case "fees.online_order_started":
      return { text: "Opened an online payment at the payment gateway", link: null };
    case "fees.online_order_cancelled":
      return { text: `Online payment cancelled${money(d.amount) ? ` (${money(d.amount)})` : ""}`, link: null };
    case "fees.online_order_failed":
      return { text: `Online payment failed${str(d.reason) ? `: ${str(d.reason)}` : ""}`, link: null };
    case "fees.online_order_expired":
      return { text: "Unfinished online payments expired", link: target && L.students.has(target) ? feesLink(target, L) : null };
    case "fees.online_excess":
      return { text: `An online payment was more than the fees due: refund ${money(d.excess) ?? "the extra"}${str(d.receiptNo) ? ` (receipt ${str(d.receiptNo)})` : ""}`, link: { href: `/office/fees/receipts/${target}`, label: "Receipt" } };
    case "fees.online_duplicate_payment":
      return {
        text: `A second online payment${money(d.amount) ? ` of ${money(d.amount)}` : ""}${student(d.studentId) ? ` for ${student(d.studentId)}` : ""} arrived for fees already paid online: no second receipt was issued — refund it in the Razorpay Dashboard${str(d.providerPaymentId) ? ` (${str(d.providerPaymentId)})` : ""}`,
        link: feesLink(d.studentId, L),
      };
    case "fees.online_amount_mismatch":
      return {
        text: `An online payment${money(d.amount) ? ` of ${money(d.amount)}` : ""}${student(d.studentId) ? ` for ${student(d.studentId)}` : ""} didn’t match the fees chosen${money(d.expected) ? ` (${money(d.expected)})` : ""}: no receipt was issued — refund it in the Razorpay Dashboard${str(d.providerPaymentId) ? ` (${str(d.providerPaymentId)})` : ""}`,
        link: feesLink(d.studentId, L),
      };
    case "fees.online_payment_conflict":
      return {
        text: `An online payment${str(d.providerPaymentId) ? ` (${str(d.providerPaymentId)})` : ""} arrived for a second order${student(d.studentId) ? ` of ${student(d.studentId)}` : ""}, but it is already on receipt ${str(d.receiptNo) ?? "for another order"}: no second receipt was issued`,
        link: feesLink(d.studentId, L),
      };
    case "fees.online_signature_invalid":
      return {
        text: `A payment confirmation from a browser${student(d.studentId) ? ` for ${student(d.studentId)}` : ""} couldn’t be verified, so no receipt was issued from it (if money was taken, the webhook or the Razorpay check records it)`,
        link: feesLink(d.studentId, L),
      };
    case "fees.online_attempt_failed":
      return {
        text: `An online payment attempt${student(d.studentId) ? ` for ${student(d.studentId)}` : ""} failed at the gateway${str(d.error) ? `: ${str(d.error)}` : ""} (no money was taken)`,
        link: feesLink(d.studentId, L),
      };
    case "fees.online_refunded_at_gateway":
      return {
        text: `An online payment${money(d.amount) ? ` of ${money(d.amount)}` : ""}${student(d.studentId) ? ` for ${student(d.studentId)}` : ""} was found at Razorpay already refunded in full: nothing was recorded`,
        link: feesLink(d.studentId, L),
      };
    case "fees.online_checked": {
      const recorded = num(d.recorded) ?? 0;
      return {
        text: `Checked ${student(d.studentId) ? `${student(d.studentId)}’s` : "a student’s"} unfinished online payments with Razorpay${recorded ? `: ${recorded === 1 ? "1 payment" : `${recorded} payments`} without a receipt recorded` : ""}`,
        link: feesLink(d.studentId, L),
      };
    }
    case "fees.refund": {
      const how = str(d.method) === "online" ? "through Razorpay" : str(d.method) === "bank" ? "by bank transfer" : str(d.method) ? `by ${str(d.method)}` : "";
      return {
        text: `Refunded ${money(d.amount) ?? "money"} on receipt ${str(d.receiptNo) ?? ""}${student(d.studentId) ? ` for ${student(d.studentId)}` : ""}${how ? ` ${how}` : ""}${str(d.voucherNo) ? ` (voucher ${str(d.voucherNo)})` : ""}`,
        link: { href: `/office/fees/receipts/${target}`, label: "Receipt" },
      };
    }
    case "fees.refund_cancelled":
      return {
        text: `Cancelled refund ${str(d.voucherNo) ?? ""}${money(d.amount) ? ` (${money(d.amount)})` : ""} on receipt ${str(d.receiptNo) ?? ""}${student(d.studentId) ? ` for ${student(d.studentId)}` : ""}${str(d.reason) ? `: ${str(d.reason)}` : ""}`,
        link: { href: `/office/fees/receipts/${target}`, label: "Receipt" },
      };
    case "fees.refund_not_recorded":
      return {
        text: `A refund made in Razorpay${money(d.amount) ? ` (${money(d.amount)})` : ""} couldn’t be recorded${str(d.reason) ? `: ${str(d.reason)}` : ""}`,
        link: { href: `/office/fees/receipts/${target}`, label: "Receipt" },
      };

    /* Import */
    case "import.previewed": {
      const errors = num(d.errors) ?? 0;
      return {
        text: `Checked the Excel file ${quote(str(d.fileName))}: ${num(d.students) ?? 0} students, ${num(d.staff) ?? 0} staff${errors ? `, ${errors} ${errors === 1 ? "problem" : "problems"} to fix` : ""}`,
        link: { href: "/office/import", label: "Import" },
      };
    }
    case "import.completed": {
      const parts = [
        num(d.studentsNew) ? `${num(d.studentsNew)} new students` : "",
        num(d.studentsUpdated) ? `${num(d.studentsUpdated)} students updated` : "",
        num(d.staffNew) ? `${num(d.staffNew)} new staff` : "",
        num(d.staffUpdated) ? `${num(d.staffUpdated)} staff updated` : "",
      ].filter(Boolean);
      return { text: `Imported the Excel file ${quote(str(d.fileName))}${parts.length ? ` (${parts.join(", ")})` : ""}`, link: { href: "/office/import", label: "Import" } };
    }
    case "import.discarded":
      return {
        text: `Discarded the Excel import ${quote(str(d.fileName))}${d.reason === "replaced" ? " (a newer file replaced it)" : d.reason === "expired" ? " (it wasn’t confirmed in time)" : ""}`,
        link: null,
      };

    case "report_remarks.saved": {
      const [examId, sectionId] = target.split(":");
      const exam = quote(str(d.exam) ?? L.exams.get(examId) ?? null);
      const sec = str(d.section) ?? section(sectionId);
      const written = num(d.written) ?? 0;
      const fromAi = num(d.fromAi) ?? 0; // entries from before the old AI assistant was removed
      const cleared = num(d.cleared) ?? 0;
      const parts = [
        written ? `${written} written or changed${fromAi ? `, ${fromAi} of them from the old AI assistant's drafts` : ""}` : "",
        cleared ? `${cleared} removed` : "",
      ].filter(Boolean);
      return {
        text: `Saved report-card remarks for ${sec} in ${exam}${parts.length ? ` (${parts.join("; ")})` : ""}`,
        link: examId && UUID.test(examId) && sectionId && UUID.test(sectionId) ? { href: `/teach/report-remarks?exam=${examId}&section=${sectionId}`, label: "Report-card remarks" } : null,
      };
    }

    /* The old AI assistant (removed on 1 October 2026; its entries stay in the log): what was asked for, never what was written */
    case "ai.draft": {
      const task = TASK_WORDS[str(d.task) ?? ""] ?? "a draft";
      const about = [str(d.class) ? classLabel(str(d.class)!) : null, str(d.subject)].filter(Boolean).join(", ");
      return { text: `Asked the old AI assistant for ${task}${about ? ` (${about})` : ""}`, link: null };
    }
    case "ai.saved":
    case "ai.draft_deleted": {
      const kind = ({ lesson_plan: "lesson plan", worksheet: "worksheet or quiz", question_paper: "question paper" } as Record<string, string>)[str(d.task) ?? ""] ?? "teaching";
      const about = [str(d.class) ? classLabel(str(d.class)!) : null, str(d.subject)].filter(Boolean).join(", ");
      const what = r.action === "ai.saved" ? `Saved an AI ${kind} draft to their drafts` : `Deleted a saved AI ${kind} draft`;
      // Saved drafts are private to their author: no link, and never their content.
      return { text: `${what}${about ? ` (${about})` : ""}`, link: null };
    }
    case "ai.remarks_drafted": {
      const [examId, sectionId] = target.split(":");
      const exam = quote(str(d.exam) ?? L.exams.get(examId) ?? null);
      const sec = str(d.section) ?? section(sectionId);
      const n = num(d.students) ?? 0;
      const drafted = num(d.drafted) ?? 0;
      return {
        text: `Asked the old AI assistant to draft report-card remarks for ${sec} in ${exam} (${drafted} of ${n} drafted, not yet saved)`,
        link: examId && UUID.test(examId) && sectionId && UUID.test(sectionId) ? { href: `/teach/report-remarks?exam=${examId}&section=${sectionId}`, label: "Report-card remarks" } : null,
      };
    }
    case "ai.support_requested":
      return {
        text: `Asked the old AI assistant for support suggestions about ${student(target) ?? "a student"}`,
        link: L.students.has(target) ? { href: `/teach/support/${target}`, label: "Needs support" } : null,
      };

    /* Settings */
    case "settings.ai_updated": {
      const after = (d.after ?? {}) as Record<string, unknown>;
      return { text: `Switched the old AI assistant ${after.enabled === false ? "off" : "on"} for the school’s teachers`, link: null };
    }
    case "settings.support_updated": {
      const before = (d.before ?? {}) as Record<string, unknown>;
      const after = (d.after ?? {}) as Record<string, unknown>;
      const parts = Object.keys(after).map((k) => {
        const unit = k === "riskRedPercent" || k === "attendanceRedPercent" ? "%" : k === "concernDays" ? " days" : "";
        return `${SUPPORT_RULE_NAMES[k] ?? k} ${before[k] ?? "default"}${unit} → ${after[k]}${unit}`;
      });
      return { text: `Changed the “Needs support” colour rule${parts.length ? `: ${parts.join("; ")}` : ""}`, link: { href: "/office/settings#support", label: "Settings" } };
    }
    case "settings.updated": {
      const before = (d.before ?? {}) as Record<string, unknown>;
      const after = (d.after ?? {}) as Record<string, unknown>;
      const parts = Object.keys(after).map((k) => {
        const pct = k === "passPercent" || k === "attendanceWarnPercent";
        const show = (v: unknown) => (v === null || v === undefined || v === "" ? "empty" : pct ? `${v}%` : String(v));
        return `${SETTING_NAMES[k] ?? k} ${show(before[k])} → ${show(after[k])}`;
      });
      return { text: `Changed the school settings${parts.length ? `: ${parts.join("; ")}` : ""}`, link: { href: "/office/settings", label: "Settings" } };
    }
  }

  /* Text messages */
  switch (r.action) {
    case "sms.settings_updated": {
      const before = (d.before ?? {}) as Record<string, unknown>;
      const after = (d.after ?? {}) as Record<string, unknown>;
      const parts = Object.keys(after).map((k) => `${smsSettingName(k)} ${str(before[k]) ?? "—"} → ${str(after[k]) ?? "—"}`);
      return { text: `Changed the text message settings${parts.length ? `: ${parts.join("; ")}` : ""}`, link: { href: "/office/settings", label: "Settings" } };
    }
    case "sms.family_off":
      return { text: `Stopped text messages to ${student(target) ? `${student(target)}’s` : "a student’s"} family (at their request)`, link: studentLink(target) };
    case "sms.family_on":
      return { text: `Started text messages to ${student(target) ? `${student(target)}’s` : "a student’s"} family again`, link: studentLink(target) };
    case "sms.retried": {
      const n = num(d.count) ?? 1;
      return { text: `Tried ${n === 1 ? "a failed text message" : `${n} failed text messages`} again`, link: { href: "/office/sms", label: "Text messages" } };
    }
    case "sms.cancelled": {
      const n = num(d.count) ?? 1;
      return { text: `Cancelled ${n === 1 ? "a text message" : `${n} text messages`} waiting to be sent`, link: { href: "/office/sms", label: "Text messages" } };
    }
    case "sms.test_sent":
      return { text: `Sent a test text message${str(d.to) ? ` to ${str(d.to)}` : ""}${d.lang === "en" ? " (English)" : d.lang === "hi" ? " (Hindi)" : ""}`, link: { href: "/office/sms", label: "Text messages" } };
    case "sms.templates_updated": {
      const provider = str(d.provider);
      const n = Array.isArray(d.changed) ? d.changed.length : 0;
      const school = str(d.school);
      return {
        text: `Changed ${n === 1 ? "an SMS template ID" : `${n} SMS template IDs`}${str(d.schoolName) ? ` for ${str(d.schoolName)}` : ""}${
          provider && provider in PROVIDER_LABELS ? ` at ${PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS]}` : ""
        }`,
        link: { href: school && /^[a-z]{1,40}$/.test(school) ? `/aesri/sms?school=${school}#wordings` : "/aesri/sms", label: "Text messages (AESRI)" },
      };
    }
  }

  if (r.action.startsWith("demo.")) return { text: "Added fictional demo data (for trying the portal)", link: null };

  // An action this page doesn't know yet: say which area and what, readably.
  const area = areaOf(r.action);
  const verb = r.action.slice(verbArea.length + 1).replace(/[_.]/g, " ");
  const about =
    r.targetType === "student"
      ? student(target)
      : r.targetType === "staff"
        ? staffName(target)
        : r.targetType === "account"
          ? loginOf()
          : null;
  const link =
    r.targetType === "student" && L.students.has(target)
      ? studentLink(target)
      : r.targetType === "staff" && L.staff.has(target)
        ? { href: `/office/staff/${target}`, label: "Staff record" }
        : r.targetType === "payment"
          ? { href: `/office/fees/receipts/${target}`, label: "Receipt" }
          : null;
  return { text: `${area?.label ?? verbArea}: ${verb}${about ? ` — ${about}` : ""}`, link };
}

function feesLink(studentId: unknown, L: Lookups): Described["link"] {
  return typeof studentId === "string" && L.students.has(studentId) ? { href: `/office/fees/students/${studentId}`, label: "Fees" } : null;
}

/** Details worth showing in the entry's disclosure: plain values, no internal IDs. */
function factsOf(details: Record<string, unknown> | null): [string, string][] {
  if (!details) return [];
  const out: [string, string][] = [];
  const show = (v: unknown): string => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v);
  };
  for (const [k, v] of Object.entries(details)) {
    if (/(^id$|Id$|Ids$|^orders$)/.test(k)) continue;
    const text = show(v);
    out.push([k, text.length > 300 ? `${text.slice(0, 300)}…` : text]);
  }
  return out;
}

/** One page of the log, newest first, with the total number of matching entries. */
export async function logPage(f: LogFilter): Promise<{ entries: LogEntry[]; total: number }> {
  const db = await getDb();
  const where = whereOf(f);
  const [[{ n }], rows] = await Promise.all([
    db.select({ n: count() }).from(auditLog).where(where),
    db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(LOG_PAGE_SIZE)
      .offset((f.page - 1) * LOG_PAGE_SIZE),
  ]);
  const L = await lookups(rows, f.schoolId);
  const entries = rows.map((r): LogEntry => {
    const person = r.actorId ? L.people.get(r.actorId) : undefined;
    const { text, link } = describe(r, L);
    return {
      id: r.id,
      at: r.at,
      action: r.action,
      areaLabel: areaOf(r.action)?.label ?? null,
      who: { name: person?.name ?? null, loginId: person?.loginId ?? (r.actorLogin ? displayLoginId(r.actorLogin) : null) },
      text,
      link,
      ip: r.ip,
      facts: factsOf(r.details),
    };
  });
  return { entries, total: Number(n) };
}

/** The newest entry of one action in a school (e.g. when the settings were last changed). */
export async function lastEntry(schoolId: string, action: string): Promise<{ at: Date; who: string | null } | null> {
  const db = await getDb();
  const [r] = await db
    .select({ at: auditLog.at, actorId: auditLog.actorId, actorLogin: auditLog.actorLogin })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, schoolId), eq(auditLog.action, action)))
    .orderBy(desc(auditLog.at))
    .limit(1);
  if (!r) return null;
  const people = await peopleByAccount([r.actorId]);
  const p = r.actorId ? people.get(r.actorId) : undefined;
  return { at: r.at, who: p ? `${p.name} (${p.loginId})` : r.actorLogin };
}
