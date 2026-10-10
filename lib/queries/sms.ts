/**
 * Read queries for the text message (SMS) screens: the set-up, counts,
 * the office's message list, a family's recent messages and what staff
 * should be told on forms ("families of IV-A get a text message").
 * Callers check who is asking first (lib/page.ts); everything is filtered
 * by school.
 */
import "server-only";
import { and, count, desc, eq, gte, ilike, inArray, like, lt, or, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { classes, enrolments, schools, sections, smsMessages, staff, students } from "@/lib/db/schema";
import { sectionLabel } from "@/lib/classes";
import { addDays } from "@/lib/dates";
import { PROVIDER_LABELS, providerKeySet, senderIdFor, senderIdText, smsMode, smsPortalAddress, smsProviderName, type ProviderName, type SmsMode } from "@/lib/sms/config";
import { eventOn, loadTemplateIds, resolveSmsSettings, templateIdFor, type ResolvedSmsSettings, type SmsKind } from "@/lib/sms/settings";
import { TEMPLATE_KEYS, type SmsLang, type TemplateKey } from "@/lib/sms/templates";

export type SmsStatus = "queued" | "sent" | "failed" | "cancelled" | "skipped";
export const SMS_STATUSES: SmsStatus[] = ["sent", "queued", "failed", "skipped", "cancelled"];
export const isSmsStatus = (v: unknown): v is SmsStatus => typeof v === "string" && (SMS_STATUSES as string[]).includes(v);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Midnight at the start of an Indian day. */
const istStart = (iso: string) => new Date(`${iso}T00:00:00+05:30`);

/* ------------------------------------------------------------------ */
/* Set-up                                                              */
/* ------------------------------------------------------------------ */

export type SmsSetup = {
  mode: SmsMode;
  provider: ProviderName;
  providerLabel: string;
  keySet: boolean;
  /** SMS_SENDER_ID as set: "AESRIS", or "aryavart: ARYAPS · aadharshila: AADHPS" (null: not set). */
  senders: string | null;
  portal: string;
};

export function smsSetup(): SmsSetup {
  const provider = smsProviderName();
  return { mode: smsMode(), provider, providerLabel: PROVIDER_LABELS[provider], keySet: providerKeySet(provider), senders: senderIdText(), portal: smsPortalAddress() };
}

/** A school's resolved SMS settings. */
export async function schoolSmsSettings(schoolId: string): Promise<ResolvedSmsSettings> {
  const db = await getDb();
  const [s] = await db.select({ settings: schools.settings }).from(schools).where(eq(schools.id, schoolId));
  return resolveSmsSettings(s?.settings.sms);
}

/** A school's templates (in one language) that have no template ID at the configured SMS company — their messages are skipped. */
export async function templatesMissing(schoolId: string, lang: SmsLang): Promise<TemplateKey[]> {
  const setup = smsSetup();
  if (setup.mode !== "live") return [];
  const ids = await loadTemplateIds(await getDb());
  return TEMPLATE_KEYS.filter((k) => !templateIdFor(ids, setup.provider, schoolId, k, lang));
}

/**
 * Whether a message from this template would really go out for the school
 * now: an SMS company is connected (or this is a development server, where
 * messages are logged), with the school's sender ID and the template's ID in
 * the school's SMS language — the checks the sender makes before sending.
 * Says nothing about a family's own number.
 */
export async function smsCanSend(schoolId: string, template: TemplateKey): Promise<boolean> {
  const setup = smsSetup();
  if (setup.mode === "off") return false;
  if (setup.mode !== "live") return true;
  if (setup.provider === "fast2sms" && !senderIdFor(schoolId)) return false;
  const { lang } = await schoolSmsSettings(schoolId);
  return !!templateIdFor(await loadTemplateIds(await getDb()), setup.provider, schoolId, template, lang);
}

/* ------------------------------------------------------------------ */
/* What staff are told on forms                                        */
/* ------------------------------------------------------------------ */

export type NoticeSmsInfo = {
  /** Text messages go for this kind of notice. */
  on: Record<"school" | "staff" | "section" | "students", boolean>;
  /** The school switched text messages off altogether. */
  schoolOff: boolean;
  /** No SMS company is set up on this server (production) — nothing is sent. */
  notSetUp: boolean;
};

export async function noticeSmsInfo(schoolId: string): Promise<NoticeSmsInfo> {
  const s = await schoolSmsSettings(schoolId);
  return {
    on: { school: eventOn(s, "notice_school"), staff: eventOn(s, "notice_staff"), section: eventOn(s, "notice_class"), students: eventOn(s, "notice_students") },
    schoolOff: !s.enabled,
    notSetUp: smsMode() === "off",
  };
}

/* ------------------------------------------------------------------ */
/* Counts                                                              */
/* ------------------------------------------------------------------ */

export type StatusCounts = Record<SmsStatus, number>;
export const emptyStatusCounts = (): StatusCounts => ({ queued: 0, sent: 0, failed: 0, cancelled: 0, skipped: 0 });

/** Messages of a school created in [from, to) (dates, IST), by kind and status. */
export async function smsCounts(schoolId: string, fromIso: string, toIsoExclusive: string): Promise<{ byKind: Map<string, StatusCounts>; total: StatusCounts }> {
  const db = await getDb();
  const rows = await db
    .select({ kind: smsMessages.kind, status: smsMessages.status, n: count() })
    .from(smsMessages)
    .where(and(eq(smsMessages.schoolId, schoolId), gte(smsMessages.createdAt, istStart(fromIso)), lt(smsMessages.createdAt, istStart(toIsoExclusive))))
    .groupBy(smsMessages.kind, smsMessages.status);
  const byKind = new Map<string, StatusCounts>();
  const total = emptyStatusCounts();
  for (const r of rows) {
    const c = byKind.get(r.kind) ?? emptyStatusCounts();
    c[r.status] += Number(r.n);
    total[r.status] += Number(r.n);
    byKind.set(r.kind, c);
  }
  return { byKind, total };
}

/** The last 30 days (today included), by kind. */
export async function last30DaysByKind(schoolId: string, today: string) {
  return smsCounts(schoolId, addDays(today, -29), addDays(today, 1));
}

/** Text messages for some notices, by status (for the notice lists). */
export async function noticeSmsCounts(schoolId: string, noticeIds: string[]): Promise<Map<string, StatusCounts>> {
  const out = new Map<string, StatusCounts>();
  if (!noticeIds.length) return out;
  const db = await getDb();
  const rows = await db
    .select({ id: smsMessages.relatedId, status: smsMessages.status, n: count() })
    .from(smsMessages)
    .where(and(eq(smsMessages.schoolId, schoolId), eq(smsMessages.relatedType, "notice"), inArray(smsMessages.relatedId, noticeIds)))
    .groupBy(smsMessages.relatedId, smsMessages.status);
  for (const r of rows) {
    if (!r.id) continue;
    const c = out.get(r.id) ?? emptyStatusCounts();
    c[r.status] += Number(r.n);
    out.set(r.id, c);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The office's message list                                           */
/* ------------------------------------------------------------------ */

export const SMS_PAGE_SIZE = 50;

export type SmsFilter = {
  schoolId: string;
  sessionId: string;
  from: string;
  to: string;
  kind: SmsKind | null;
  status: SmsStatus | null;
  sectionId: string | null;
  q: string;
  page: number;
};

export type SmsListRow = {
  id: string;
  createdAt: Date;
  sentAt: Date | null;
  sendAfter: Date;
  kind: string;
  template: string;
  lang: string;
  status: SmsStatus;
  error: string | null;
  attempts: number;
  provider: string | null;
  toMobile: string;
  body: string;
  studentId: string | null;
  studentName: string | null;
  studentSection: string | null;
  staffId: string | null;
  staffName: string | null;
};

function likeText(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** One page of a school's messages, newest first, with the number matching. */
export async function smsListPage(f: SmsFilter): Promise<{ rows: SmsListRow[]; total: number }> {
  const db = await getDb();
  const conds: (SQL | undefined)[] = [
    eq(smsMessages.schoolId, f.schoolId),
    gte(smsMessages.createdAt, istStart(f.from)),
    lt(smsMessages.createdAt, istStart(addDays(f.to, 1))),
    f.kind ? eq(smsMessages.kind, f.kind) : undefined,
    f.status ? eq(smsMessages.status, f.status) : undefined,
  ];
  if (f.sectionId && UUID.test(f.sectionId)) {
    conds.push(
      inArray(
        smsMessages.studentId,
        db.select({ id: enrolments.studentId }).from(enrolments).where(and(eq(enrolments.sectionId, f.sectionId), eq(enrolments.sessionId, f.sessionId))),
      ),
    );
  }
  const q = f.q.trim().slice(0, 60);
  if (q) {
    const digits = q.replace(/\D/g, "");
    conds.push(
      or(
        ilike(students.name, `%${likeText(q)}%`),
        eq(students.srNo, q),
        ilike(staff.name, `%${likeText(q)}%`),
        digits.length >= 4 ? like(smsMessages.toMobile, `%${digits}`) : undefined,
      ),
    );
  }
  const where = and(...conds);
  const base = db
    .select({
      id: smsMessages.id,
      createdAt: smsMessages.createdAt,
      sentAt: smsMessages.sentAt,
      sendAfter: smsMessages.sendAfter,
      kind: smsMessages.kind,
      template: smsMessages.template,
      lang: smsMessages.lang,
      status: smsMessages.status,
      error: smsMessages.error,
      attempts: smsMessages.attempts,
      provider: smsMessages.provider,
      toMobile: smsMessages.toMobile,
      body: smsMessages.body,
      studentId: smsMessages.studentId,
      studentName: students.name,
      staffId: smsMessages.staffId,
      staffName: staff.name,
      className: classes.name,
      sectionName: sections.name,
    })
    .from(smsMessages)
    .leftJoin(students, eq(students.id, smsMessages.studentId))
    .leftJoin(staff, eq(staff.id, smsMessages.staffId))
    .leftJoin(enrolments, and(eq(enrolments.studentId, smsMessages.studentId), eq(enrolments.sessionId, f.sessionId)))
    .leftJoin(sections, eq(sections.id, enrolments.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId));
  const [[{ n }], rows] = await Promise.all([
    db
      .select({ n: count() })
      .from(smsMessages)
      .leftJoin(students, eq(students.id, smsMessages.studentId))
      .leftJoin(staff, eq(staff.id, smsMessages.staffId))
      .where(where),
    base
      .where(where)
      .orderBy(desc(smsMessages.createdAt), desc(smsMessages.id))
      .limit(SMS_PAGE_SIZE)
      .offset((f.page - 1) * SMS_PAGE_SIZE),
  ]);
  return {
    total: Number(n),
    rows: rows.map(({ className, sectionName, ...r }) => ({ ...r, studentSection: className && sectionName ? sectionLabel(className, sectionName) : null })),
  };
}

/** How many of a school's messages failed recently (they can be tried again). */
export async function recentFailedCount(schoolId: string, since: Date): Promise<number> {
  const db = await getDb();
  const [r] = await db
    .select({ n: count() })
    .from(smsMessages)
    .where(and(eq(smsMessages.schoolId, schoolId), eq(smsMessages.status, "failed"), gte(smsMessages.createdAt, since)));
  return Number(r?.n ?? 0);
}

/** A family's latest messages (the student's record). */
export async function studentSmsHistory(schoolId: string, studentId: string, limit = 10) {
  const db = await getDb();
  return db
    .select({
      id: smsMessages.id,
      createdAt: smsMessages.createdAt,
      sentAt: smsMessages.sentAt,
      kind: smsMessages.kind,
      status: smsMessages.status,
      error: smsMessages.error,
      provider: smsMessages.provider,
      toMobile: smsMessages.toMobile,
      body: smsMessages.body,
      attempts: smsMessages.attempts,
    })
    .from(smsMessages)
    .where(and(eq(smsMessages.schoolId, schoolId), eq(smsMessages.studentId, studentId)))
    .orderBy(desc(smsMessages.createdAt))
    .limit(limit);
}

/** Recent test messages sent from a school (at most a few per ten minutes). */
export async function recentTests(schoolId: string, since: Date): Promise<number> {
  const db = await getDb();
  const [r] = await db
    .select({ n: count() })
    .from(smsMessages)
    .where(and(eq(smsMessages.schoolId, schoolId), eq(smsMessages.kind, "test"), gte(smsMessages.createdAt, since)));
  return Number(r?.n ?? 0);
}


/** A student's text message choice and numbers (the office's student record). */
export async function studentSmsInfo(schoolId: string, studentId: string) {
  const db = await getDb();
  const [s] = await db
    .select({ smsOff: students.smsOff, guardianMobile: students.guardianMobile, mobile2: students.mobile2, status: students.status })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)));
  return s ?? null;
}
