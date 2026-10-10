/**
 * Notices: from the school office to everyone ("school"), to staff only
 * ("staff"), to one class ("section") or to chosen students of one class
 * ("students"); and from class teachers to their own section, or to chosen
 * students of it.
 *
 *  - Office notices start as drafts; publishing records who approved them
 *    and when. Class notices are published as soon as they are posted.
 *  - A notice shows from `publishOn` to `expiresOn` (inclusive; no expiry =
 *    until archived). Archived notices are kept but never shown.
 *  - "students" notices keep their section, and the chosen students in
 *    notice_recipients; only those families see them.
 *  - Editing a published notice increases its version; the audit entry
 *    keeps what the changed fields said before.
 *  - When a notice starts showing (published for today or earlier — or, for
 *    a later date, on that date, see lib/sms/worker.ts), its readers get a
 *    text message with its title. Editing never sends it again; archiving
 *    withdraws messages that haven't gone.
 *
 * Who may do what is decided by the pages; these functions keep records
 * inside the school (a chosen student must be on the chosen section's roll)
 * and audit every change.
 */
import { and, asc, count, desc, eq, exists, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import { accounts, classes, enrolments, noticeRecipients, notices, sections, students } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import { sectionLabel } from "@/lib/classes";
import { isValidIsoDate, todayIST } from "@/lib/dates";
import type { Lang } from "@/lib/i18n";
import type { FamilyTextLookup, FamilyTextValue } from "@/lib/translate";
import { queueNotice, withdrawNotice, type SimpleSmsResult } from "@/lib/sms/outbox";
import { cleanLongText, isUuid, peopleByAccount, sectionOf, type Person, type Writer } from "./attendance";
import { RecordError } from "./students";

export type NoticeAudience = "school" | "staff" | "section" | "students";
export type NoticeStatus = "draft" | "pending" | "published" | "archived";

/** Who a notice is for, as chosen on a form. */
export type NoticeTarget =
  | { audience: "school" }
  | { audience: "staff" }
  | { audience: "section"; sectionId: string }
  | { audience: "students"; sectionId: string; studentIds: string[] };

/** At most this many students can be chosen for one notice (more: send it to the class). */
export const MAX_NOTICE_STUDENTS = 80;

export const NOTICE_CATEGORIES = [
  { key: "academic", en: "Academic", hi: "पढ़ाई-लिखाई" },
  { key: "admissions", en: "Admissions", hi: "प्रवेश" },
  { key: "events", en: "Events", hi: "कार्यक्रम" },
  { key: "fees", en: "Fees", hi: "फ़ीस" },
  { key: "general", en: "General", hi: "सामान्य" },
  { key: "holiday", en: "Holiday", hi: "छुट्टी" },
  { key: "transport", en: "Transport", hi: "वाहन सुविधा" },
] as const;
export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number]["key"];

export function isNoticeCategory(v: unknown): v is NoticeCategory {
  return NOTICE_CATEGORIES.some((c) => c.key === v);
}

export function noticeCategoryLabel(key: string, lang: Lang = "en"): string {
  const c = NOTICE_CATEGORIES.find((x) => x.key === key);
  return c ? c[lang] : key;
}

export const NOTICE_LIMITS = { title: 150, body: 4000 };

export type NoticeContent = {
  category: NoticeCategory;
  titleEn: string;
  bodyEn: string;
  titleHi: string | null;
  bodyHi: string | null;
  publishOn: string;
  expiresOn: string | null;
};

/** Check typed values; returns clean content or a message per field. */
export function validateNotice(raw: {
  category: unknown;
  titleEn: unknown;
  bodyEn: unknown;
  titleHi: unknown;
  bodyHi: unknown;
  publishOn: unknown;
  expiresOn: unknown;
}): { ok: true; content: NoticeContent } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const oneLine = (v: unknown) => cleanLongText(v, NOTICE_LIMITS.title)?.replace(/\s+/g, " ") ?? null;
  const titleEn = oneLine(raw.titleEn);
  const titleHi = oneLine(raw.titleHi);
  const bodyEn = cleanLongText(raw.bodyEn, NOTICE_LIMITS.body);
  const bodyHi = cleanLongText(raw.bodyHi, NOTICE_LIMITS.body);
  const publishOn = typeof raw.publishOn === "string" ? raw.publishOn.trim() : "";
  const expiresOn = typeof raw.expiresOn === "string" && raw.expiresOn.trim() ? raw.expiresOn.trim() : null;
  if (!isNoticeCategory(raw.category)) errors.category = "Choose a category.";
  if (!titleEn) errors.titleEn = "Write a title.";
  if (!bodyEn) errors.bodyEn = "Write the notice.";
  if (titleHi && !bodyHi) errors.bodyHi = "Add the Hindi text too, or leave both Hindi boxes empty.";
  if (bodyHi && !titleHi) errors.titleHi = "Add a Hindi title too, or leave both Hindi boxes empty.";
  if (!isValidIsoDate(publishOn)) errors.publishOn = "Choose the date to show it from.";
  if (expiresOn !== null) {
    if (!isValidIsoDate(expiresOn)) errors.expiresOn = "Choose a valid date, or leave it empty.";
    else if (isValidIsoDate(publishOn) && expiresOn < publishOn) errors.expiresOn = "The last day can't be before the first day.";
  }
  if (Object.keys(errors).length || !titleEn || !bodyEn || !isNoticeCategory(raw.category)) return { ok: false, errors };
  return { ok: true, content: { category: raw.category, titleEn, bodyEn, titleHi, bodyHi, publishOn, expiresOn } };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

async function loadNotice(tx: Tx, schoolId: string, noticeId: string) {
  const [n] = isUuid(noticeId) ? await tx.select().from(notices).where(eq(notices.id, noticeId)).for("update") : [];
  if (!n || n.schoolId !== schoolId) throw new RecordError("That notice was not found.");
  return n;
}

type CheckedTarget = { audience: NoticeAudience; sectionId: string | null; section: { id: string; label: string } | null; studentIds: string[] };

/**
 * Check who a notice is for: the section must be one of this school's, and
 * every chosen student must be a current student on that section's roll.
 */
async function checkTarget(tx: Tx, schoolId: string, target: NoticeTarget): Promise<CheckedTarget> {
  if (target.audience === "school" || target.audience === "staff") return { audience: target.audience, sectionId: null, section: null, studentIds: [] };
  const sec = await sectionOf(tx, target.sectionId);
  if (!sec || sec.schoolId !== schoolId) throw new RecordError("Choose a class of this school.");
  if (target.audience === "section") return { audience: "section", sectionId: sec.id, section: { id: sec.id, label: sec.label }, studentIds: [] };
  const wanted = [...new Set(target.studentIds)];
  if (!wanted.length) throw new RecordError(`Tick the students of ${sec.label} the notice is for, or send it to the whole class.`);
  if (wanted.length > MAX_NOTICE_STUDENTS) throw new RecordError(`Choose at most ${MAX_NOTICE_STUDENTS} students, or send the notice to the whole class.`);
  if (!wanted.every(isUuid)) throw new RecordError(`Some of the chosen students are not in ${sec.label}. Reload the page and choose again.`);
  const onRoll = await tx
    .select({ id: students.id })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(and(eq(enrolments.sectionId, sec.id), eq(students.schoolId, schoolId), eq(students.status, "active"), inArray(students.id, wanted)));
  if (onRoll.length !== wanted.length) throw new RecordError(`Some of the chosen students are not in ${sec.label}. Reload the page and choose again.`);
  return { audience: "students", sectionId: sec.id, section: { id: sec.id, label: sec.label }, studentIds: wanted };
}

async function setRecipients(tx: Tx, noticeId: string, studentIds: string[]) {
  await tx.delete(noticeRecipients).where(eq(noticeRecipients.noticeId, noticeId));
  if (studentIds.length) await tx.insert(noticeRecipients).values(studentIds.map((studentId) => ({ noticeId, studentId })));
}

/** What the audit entry says about who a notice is for. */
const targetDetails = (t: CheckedTarget) => ({
  audience: t.audience,
  ...(t.section ? { section: t.section.label, sectionId: t.section.id } : {}),
  ...(t.audience === "students" ? { recipients: t.studentIds.length, studentIds: t.studentIds } : {}),
});

/** A notice has just started showing: queue its text messages (once). */
async function tellReaders(tx: Tx, n: { id: string; schoolId: string; audience: NoticeAudience; sectionId: string | null; titleEn: string; titleHi: string | null; createdAt?: Date }, actor: Writer) {
  return queueNotice(tx, { id: n.id, schoolId: n.schoolId, audience: n.audience, sectionId: n.sectionId, titleEn: n.titleEn, titleHi: n.titleHi, createdAt: n.createdAt }, actor.accountId);
}

export type NoticeSaved = {
  id: string;
  /** Text messages queued now (null: none, because the notice isn't showing yet). */
  sms: SimpleSmsResult | null;
};

/** An office notice (whole school, staff, a class or chosen students of a class), as a draft or published at once. */
export async function createOfficeNotice(
  tx: Tx,
  input: { schoolId: string; target: NoticeTarget; publish: boolean } & NoticeContent,
  actor: Writer,
): Promise<NoticeSaved> {
  const { schoolId, target, publish, ...content } = input;
  const t = await checkTarget(tx, schoolId, target);
  const now = new Date();
  const [row] = await tx
    .insert(notices)
    .values({
      schoolId,
      audience: t.audience,
      sectionId: t.sectionId,
      ...content,
      status: publish ? "published" : "draft",
      createdBy: actor.accountId,
      approvedBy: publish ? actor.accountId : null,
      approvedAt: publish ? now : null,
      updatedAt: now,
    })
    .returning({ id: notices.id, createdAt: notices.createdAt });
  await setRecipients(tx, row.id, t.studentIds);
  await audit(tx, actor, "notice.created", {
    schoolId,
    targetType: "notice",
    targetId: row.id,
    details: { ...targetDetails(t), category: content.category, title: content.titleEn, status: publish ? "published" : "draft", publishOn: content.publishOn },
  });
  const sms =
    publish && content.publishOn <= todayIST(now)
      ? await tellReaders(tx, { id: row.id, schoolId, audience: t.audience, sectionId: t.sectionId, titleEn: content.titleEn, titleHi: content.titleHi, createdAt: row.createdAt }, actor)
      : null;
  return { id: row.id, sms };
}

/**
 * A class teacher's notice to their section — or to chosen students of it
 * (`studentIds`): published straight away, from today.
 */
export async function createClassNotice(
  tx: Tx,
  input: { schoolId: string; sectionId: string; studentIds?: string[] | null } & NoticeContent,
  actor: Writer,
): Promise<NoticeSaved> {
  const { schoolId, sectionId, studentIds, ...content } = input;
  const target: NoticeTarget = studentIds ? { audience: "students", sectionId, studentIds } : { audience: "section", sectionId };
  const t = await checkTarget(tx, schoolId, target).catch((err) => {
    if (err instanceof RecordError && err.message === "Choose a class of this school.") throw new RecordError("Choose one of your classes.");
    throw err;
  });
  const now = new Date();
  const [row] = await tx
    .insert(notices)
    .values({
      schoolId,
      audience: t.audience,
      sectionId: t.sectionId,
      ...content,
      status: "published",
      createdBy: actor.accountId,
      approvedBy: actor.accountId,
      approvedAt: now,
      updatedAt: now,
    })
    .returning({ id: notices.id, createdAt: notices.createdAt });
  await setRecipients(tx, row.id, t.studentIds);
  await audit(tx, actor, "notice.created", {
    schoolId,
    targetType: "notice",
    targetId: row.id,
    details: { ...targetDetails(t), category: content.category, title: content.titleEn, status: "published" },
  });
  const sms =
    content.publishOn <= todayIST(now)
      ? await tellReaders(tx, { id: row.id, schoolId, audience: t.audience, sectionId: t.sectionId, titleEn: content.titleEn, titleHi: content.titleHi, createdAt: row.createdAt }, actor)
      : null;
  return { id: row.id, sms };
}

/**
 * Change a notice's content (any audience). Archived notices can't be
 * changed. A published notice gets version + 1. With `publish`, a draft is
 * published in the same step. `target` changes who it is for (the office:
 * any audience; a class teacher: the whole class or chosen students of the
 * same class — the pages decide).
 *
 * Text messages go only when the notice starts showing with this change (a
 * draft published for today or earlier, or a scheduled notice moved to
 * today): editing a notice that is already showing never sends it again.
 */
export async function updateNotice(
  tx: Tx,
  schoolId: string,
  noticeId: string,
  content: NoticeContent,
  actor: Writer,
  opts: { publish?: boolean; target?: NoticeTarget } = {},
): Promise<{ version: number; changed: string[]; published: boolean; sms: SimpleSmsResult | null }> {
  const cur = await loadNotice(tx, schoolId, noticeId);
  if (cur.status === "archived") throw new RecordError("This notice is archived, so it can't be changed.");
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of ["category", "titleEn", "bodyEn", "titleHi", "bodyHi", "publishOn", "expiresOn"] as const) {
    if ((cur[k] ?? null) !== (content[k] ?? null)) {
      before[k] = cur[k];
      after[k] = content[k];
    }
  }
  let recipients: string[] | null = null;
  if (opts.target) {
    const t = await checkTarget(tx, schoolId, opts.target);
    const was =
      cur.audience === "students"
        ? (await tx.select({ id: noticeRecipients.studentId }).from(noticeRecipients).where(eq(noticeRecipients.noticeId, cur.id))).map((r) => r.id).sort()
        : [];
    if (t.audience !== cur.audience) {
      before.audience = cur.audience;
      after.audience = t.audience;
    }
    if ((t.sectionId ?? null) !== (cur.sectionId ?? null)) {
      before.sectionId = cur.sectionId;
      after.sectionId = t.sectionId;
    }
    const now = [...t.studentIds].sort();
    if (now.join(",") !== was.join(",")) {
      before.recipients = was.length;
      after.recipients = now.length;
      recipients = now;
    }
  }
  const changed = Object.keys(after);
  const publishNow = !!opts.publish && (cur.status === "draft" || cur.status === "pending");
  if (!changed.length && !publishNow) return { version: cur.version, changed, published: cur.status === "published", sms: null };
  const now = new Date();
  const version = cur.status === "published" && changed.length ? cur.version + 1 : cur.version;
  const { recipients: _r, ...columns } = after;
  await tx
    .update(notices)
    .set({
      ...columns,
      version,
      updatedAt: now,
      ...(publishNow ? { status: "published" as const, approvedBy: actor.accountId, approvedAt: now } : {}),
    })
    .where(eq(notices.id, cur.id));
  if (recipients) await setRecipients(tx, cur.id, recipients);
  if (changed.length) {
    await audit(tx, actor, "notice.updated", {
      schoolId,
      targetType: "notice",
      targetId: cur.id,
      details: { version, before, after: recipients ? { ...after, studentIds: recipients } : after },
    });
  }
  if (publishNow) {
    await audit(tx, actor, "notice.published", { schoolId, targetType: "notice", targetId: cur.id, details: { title: content.titleEn, version } });
  }
  const today = todayIST(now);
  const wasShowing = cur.status === "published" && cur.publishOn <= today;
  const showsNow = (publishNow || cur.status === "published") && content.publishOn <= today;
  const sms =
    !wasShowing && showsNow
      ? await tellReaders(
          tx,
          {
            id: cur.id,
            schoolId,
            audience: (after.audience as NoticeAudience | undefined) ?? cur.audience,
            sectionId: "sectionId" in after ? (after.sectionId as string | null) : cur.sectionId,
            titleEn: content.titleEn,
            titleHi: content.titleHi,
            createdAt: cur.createdAt,
          },
          actor,
        )
      : null;
  return { version, changed, published: publishNow || cur.status === "published", sms };
}

/** Publish a draft: families (or staff) see it from its publish date — and get a text message then. */
export async function publishNotice(tx: Tx, schoolId: string, noticeId: string, actor: Writer): Promise<{ sms: SimpleSmsResult | null }> {
  const cur = await loadNotice(tx, schoolId, noticeId);
  if (cur.status !== "draft" && cur.status !== "pending") throw new RecordError("Only drafts can be published.");
  const now = new Date();
  await tx.update(notices).set({ status: "published", approvedBy: actor.accountId, approvedAt: now, updatedAt: now }).where(eq(notices.id, cur.id));
  await audit(tx, actor, "notice.published", {
    schoolId,
    targetType: "notice",
    targetId: cur.id,
    details: { title: cur.titleEn, audience: cur.audience, version: cur.version },
  });
  return { sms: cur.publishOn <= todayIST(now) ? await tellReaders(tx, cur, actor) : null };
}

/** Archive a notice: it stops showing everywhere but is kept for the record. Text messages not sent yet are withdrawn. */
export async function archiveNotice(tx: Tx, schoolId: string, noticeId: string, actor: Writer): Promise<void> {
  const cur = await loadNotice(tx, schoolId, noticeId);
  if (cur.status === "archived") return;
  await tx.update(notices).set({ status: "archived", updatedAt: new Date() }).where(eq(notices.id, cur.id));
  await withdrawNotice(tx, cur.id);
  await audit(tx, actor, "notice.archived", {
    schoolId,
    targetType: "notice",
    targetId: cur.id,
    details: { title: cur.titleEn, audience: cur.audience, sectionId: cur.sectionId, previousStatus: cur.status },
  });
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export type NoticeRow = {
  id: string;
  audience: NoticeAudience;
  sectionId: string | null;
  /** "V-A" for class notices and notices to chosen students. */
  sectionLabel: string | null;
  /** How many students were chosen ("students" notices; 0 for the others). */
  recipientCount: number;
  category: string;
  titleEn: string;
  titleHi: string | null;
  bodyEn: string;
  bodyHi: string | null;
  status: NoticeStatus;
  publishOn: string;
  expiresOn: string | null;
  version: number;
  createdBy: string;
  createdByPerson: Person | null;
  /** The writer's sign-in role: notices written by the office (school or AESRI admins) can be edited by the office. */
  createdByRole: string | null;
  approvedBy: string | null;
  approvedByPerson: Person | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const noticeColumns = {
  id: notices.id,
  audience: notices.audience,
  sectionId: notices.sectionId,
  className: classes.name,
  sectionName: sections.name,
  category: notices.category,
  titleEn: notices.titleEn,
  titleHi: notices.titleHi,
  bodyEn: notices.bodyEn,
  bodyHi: notices.bodyHi,
  status: notices.status,
  publishOn: notices.publishOn,
  expiresOn: notices.expiresOn,
  version: notices.version,
  createdBy: notices.createdBy,
  approvedBy: notices.approvedBy,
  approvedAt: notices.approvedAt,
  createdAt: notices.createdAt,
  updatedAt: notices.updatedAt,
  createdByRole: accounts.role,
  recipientCount: sql<number>`(select count(*) from ${noticeRecipients} where ${noticeRecipients.noticeId} = ${notices.id})`.mapWith(Number),
};

async function selectNotices(where: SQL | undefined, order: "newest" | "publish", limit = 200): Promise<NoticeRow[]> {
  const db = await getDb();
  const rows = await db
    .select(noticeColumns)
    .from(notices)
    .leftJoin(sections, eq(sections.id, notices.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(accounts, eq(accounts.id, notices.createdBy))
    .where(where)
    .orderBy(...(order === "publish" ? [desc(notices.publishOn), desc(notices.updatedAt)] : [desc(notices.updatedAt)]))
    .limit(limit);
  const people = await peopleByAccount(rows.flatMap((r) => [r.createdBy, r.approvedBy]));
  return rows.map(({ className, sectionName, ...r }) => ({
    ...r,
    sectionLabel: className && sectionName ? sectionLabel(className, sectionName) : null,
    createdByPerson: people.get(r.createdBy) ?? null,
    approvedByPerson: r.approvedBy ? (people.get(r.approvedBy) ?? null) : null,
  }));
}

/** Shown on `today`: published, started, not past its last day. */
function activeOn(today: string): SQL {
  return and(eq(notices.status, "published"), lte(notices.publishOn, today), or(isNull(notices.expiresOn), gte(notices.expiresOn, today)))!;
}

/** Is a published notice showing today, waiting for its start date, or past its last day? */
export function noticeTiming(n: { status: NoticeStatus; publishOn: string; expiresOn: string | null }, today: string): "live" | "scheduled" | "expired" | null {
  if (n.status !== "published") return null;
  if (n.publishOn > today) return "scheduled";
  if (n.expiresOn && n.expiresOn < today) return "expired";
  return "live";
}

/** Office list: a school's notices with the given statuses (all audiences), newest change first. */
export async function listNotices(
  schoolId: string,
  statuses: NoticeStatus[],
  opts: { audiences?: NoticeAudience[]; limit?: number } = {},
): Promise<NoticeRow[]> {
  const conds: SQL[] = [eq(notices.schoolId, schoolId), inArray(notices.status, statuses)];
  if (opts.audiences) conds.push(inArray(notices.audience, opts.audiences));
  return selectNotices(and(...conds), "newest", opts.limit);
}

/** How many notices a school has in each status. */
export async function noticeStatusCounts(schoolId: string): Promise<Record<NoticeStatus, number>> {
  const db = await getDb();
  const rows = await db.select({ status: notices.status, n: count() }).from(notices).where(eq(notices.schoolId, schoolId)).groupBy(notices.status);
  const out: Record<NoticeStatus, number> = { draft: 0, pending: 0, published: 0, archived: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

/** Notices to some sections — the whole class or chosen students of it (published and archived), newest first. */
export async function listClassNotices(schoolId: string, sectionIds: string[], limit = 50): Promise<NoticeRow[]> {
  if (!sectionIds.length) return [];
  return selectNotices(
    and(eq(notices.schoolId, schoolId), inArray(notices.audience, ["section", "students"]), inArray(notices.sectionId, sectionIds), inArray(notices.status, ["published", "archived"])),
    "newest",
    limit,
  );
}

/** Is this a notice the office wrote (to anyone), rather than a teacher's notice to their class? The office edits its own notices. */
export function isOfficeNotice(n: Pick<NoticeRow, "audience" | "createdByRole">): boolean {
  return n.audience === "school" || n.audience === "staff" || n.createdByRole === "school_admin" || n.createdByRole === "super_admin";
}

/** "Whole school", "Staff only", "Class IV-A", "3 students of IV-A". */
export function noticeAudienceText(n: Pick<NoticeRow, "audience" | "sectionLabel" | "recipientCount">): string {
  if (n.audience === "school") return "Whole school";
  if (n.audience === "staff") return "Staff only";
  if (n.audience === "section") return `Class ${n.sectionLabel ?? ""}`.trim();
  return `${n.recipientCount} ${n.recipientCount === 1 ? "student" : "students"} of ${n.sectionLabel ?? "a class"}`;
}

/** The students a "students" notice was sent to, by roll number then name (for its edit form). */
export async function noticeRecipientsOf(noticeId: string): Promise<{ id: string; name: string; rollNo: number | null }[]> {
  if (!isUuid(noticeId)) return [];
  const db = await getDb();
  return db
    .select({ id: students.id, name: students.name, rollNo: enrolments.rollNo })
    .from(noticeRecipients)
    .innerJoin(notices, eq(notices.id, noticeRecipients.noticeId))
    .innerJoin(students, eq(students.id, noticeRecipients.studentId))
    .leftJoin(enrolments, and(eq(enrolments.studentId, students.id), eq(enrolments.sectionId, notices.sectionId)))
    .where(eq(noticeRecipients.noticeId, noticeId))
    .orderBy(asc(enrolments.rollNo), asc(students.name));
}

/** One notice, or null. The caller checks access. */
export async function noticeById(noticeId: string): Promise<(NoticeRow & { schoolId: string }) | null> {
  if (!isUuid(noticeId)) return null;
  const db = await getDb();
  const [n] = await db.select({ schoolId: notices.schoolId }).from(notices).where(eq(notices.id, noticeId));
  if (!n) return null;
  const [row] = await selectNotices(eq(notices.id, noticeId), "newest", 1);
  return row ? { ...row, schoolId: n.schoolId } : null;
}

/**
 * What staff see "from the office": published school-wide and staff-only
 * notices showing on `today`, newest first.
 */
export async function activeNoticesForStaff(schoolId: string, today: string): Promise<NoticeRow[]> {
  return selectNotices(and(eq(notices.schoolId, schoolId), inArray(notices.audience, ["school", "staff"]), activeOn(today)), "publish", 50);
}

/**
 * What a family sees on `today`: published notices for the whole school,
 * for the child's own section, and those sent to the child by name (chosen
 * students), newest first. The section is only used if the child is
 * enrolled in it (otherwise only school notices and the child's own are
 * returned).
 */
export async function activeNoticesForFamily(studentId: string, schoolId: string, sectionId: string | null, today: string): Promise<NoticeRow[]> {
  if (!isUuid(studentId)) return [];
  const db = await getDb();
  let ownSection: string | null = null;
  if (sectionId && isUuid(sectionId)) {
    const [e] = await db
      .select({ id: enrolments.id })
      .from(enrolments)
      .where(and(eq(enrolments.studentId, studentId), eq(enrolments.sectionId, sectionId)));
    if (e) ownSection = sectionId;
  }
  const chosen = and(
    eq(notices.audience, "students"),
    exists(
      db
        .select({ one: sql`1` })
        .from(noticeRecipients)
        .where(and(eq(noticeRecipients.noticeId, notices.id), eq(noticeRecipients.studentId, studentId))),
    ),
  );
  const audience = ownSection
    ? or(eq(notices.audience, "school"), and(eq(notices.audience, "section"), eq(notices.sectionId, ownSection)), chosen)
    : or(eq(notices.audience, "school"), chosen);
  return selectNotices(and(eq(notices.schoolId, schoolId), audience, activeOn(today)), "publish", 50);
}

/** The Hindi or English title and text of a notice for a reader (falls back to English). */
export function noticeText(
  n: { titleEn: string; bodyEn: string; titleHi: string | null; bodyHi: string | null },
  lang: Lang,
): { title: string; body: string; lang: Lang } {
  if (lang === "hi" && n.titleHi && n.bodyHi) return { title: n.titleHi, body: n.bodyHi, lang: "hi" };
  return { title: n.titleEn, body: n.bodyEn, lang: "en" };
}

/**
 * A notice's title and body as a family reads them: in Hindi, the school's
 * own Hindi where it was written, otherwise the translation from `say`
 * (lib/translate familyTexts, given titleEn and bodyEn); in English, as written.
 */
export function familyNoticeText(
  n: { titleEn: string; bodyEn: string; titleHi: string | null; bodyHi: string | null },
  lang: Lang,
  say: FamilyTextLookup,
): { title: FamilyTextValue | null; body: FamilyTextValue | null } {
  if (lang !== "hi") return { title: say(n.titleEn), body: say(n.bodyEn) };
  return {
    title: n.titleHi?.trim() ? { text: n.titleHi, lang: "hi" } : say(n.titleEn),
    body: n.bodyHi?.trim() ? { text: n.bodyHi, lang: "hi" } : say(n.bodyEn),
  };
}

/** The English texts of these notices a Hindi reader needs translated (those without the school's own Hindi). */
export const noticeTextsToTranslate = (rows: { titleEn: string; bodyEn: string; titleHi: string | null; bodyHi: string | null }[]) =>
  rows.flatMap((n) => [n.titleHi?.trim() ? null : n.titleEn, n.bodyHi?.trim() ? null : n.bodyEn]);
