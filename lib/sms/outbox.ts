/**
 * The outbox: every text message starts here.
 *
 * Services call these functions inside the transaction that makes the
 * change, so a change that is rolled back queues nothing. The sender
 * (lib/sms/worker.ts) later sends what is due. Each function:
 *
 *  - checks the school's settings (master switch and the event's switch);
 *  - finds who to tell (see familyInfo / staffInfo): the family's parent
 *    mobile, plus the second mobile when the school turned that on;
 *    families who asked not to get messages, students no longer at the
 *    school and records without a valid mobile get a "skipped" row saying
 *    why, instead of a message;
 *  - never sends the same thing twice to the same number: a queued
 *    message with the same dedupe key is merged (replaced) or kept, and
 *    numbers that were already sent the message are left out.
 *
 * Messages are written in the school's chosen language, with every
 * variable cleaned and shortened for DLT (lib/sms/templates.ts).
 *
 * Queueing never stops the change it is about: it runs in a savepoint, and
 * an unexpected error there is logged and the change goes ahead without
 * the message. The demo data (lib/demo) is added inside withoutSms(), so
 * its made-up history sends nothing.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, gte, inArray, like, ne, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { academicSessions, classes, enrolments, noticeRecipients, sections, smsMessages, staff, students } from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { sectionLabel } from "@/lib/classes";
import { addDays, todayIST } from "@/lib/dates";
import { attendanceDelaySeconds, paymentDelaySeconds, remarkDelaySeconds, smsPortalAddress } from "./config";
import { eventOn, schoolForSms, schoolNameIn, type ResolvedSmsSettings, type SchoolForSms, type SmsEvent, type SmsKind } from "./settings";
import { cachedHindi } from "@/lib/translate/cache";
import { renderSms, SMS_REMARK_WORDS, SMS_STATUS_WORDS, smsAmount, smsDate, validMobile, type SmsLang, type TemplateKey, type VarName } from "./templates";

/* ------------------------------------------------------------------ */
/* Turning messages off for a block of work (demo data)                */
/* ------------------------------------------------------------------ */

const quiet = new AsyncLocalStorage<boolean>();

/** Run `fn` without queueing any text messages (the demo's made-up history). */
export function withoutSms<T>(fn: () => Promise<T>): Promise<T> {
  return quiet.run(true, fn);
}

const suppressed = () => quiet.getStore() === true;

/**
 * Run a queueing step in a savepoint: if it fails unexpectedly, only the
 * messages are lost — the change it belongs to is still saved.
 */
async function safely<T>(tx: Tx, what: string, fallback: T, fn: (sp: Tx) => Promise<T>): Promise<T> {
  if (suppressed()) return fallback;
  try {
    return await tx.transaction((sp) => fn(sp as Tx));
  } catch (err) {
    console.error(`[sms] Could not queue text messages for ${what}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Recipients                                                          */
/* ------------------------------------------------------------------ */

export const SKIP_REASONS = {
  optedOut: "The family asked not to get text messages.",
  notCurrent: "The student is no longer at the school.",
  noMobile: "No valid mobile number on record.",
  staffNoMobile: "No valid mobile number on the staff record.",
} as const;

export type FamilyInfo = {
  studentId: string;
  name: string;
  /** "IV-A" this session, or null when not placed in a class. */
  sectionLabel: string | null;
  /** Where messages go: the parent's mobile, and the second mobile when the school sends to both. */
  mobiles: string[];
  /** Why no message can be sent (null: it can). */
  skip: string | null;
  /** The number a skipped row records (the parent's mobile if it is valid). */
  recordMobile: string;
};

/**
 * Who to tell about each student, and whether they can be told. Pure, so
 * the rules can be tested: parent's mobile first; the second mobile too if
 * the school chose that and it is a different, valid number.
 */
export function familyRecipient(
  s: { id: string; name: string; status: string; smsOff: boolean; guardianMobile: string | null; mobile2: string | null; sectionLabel: string | null },
  settings: Pick<ResolvedSmsSettings, "alsoSecondMobile">,
): FamilyInfo {
  const first = validMobile(s.guardianMobile);
  const second = settings.alsoSecondMobile ? validMobile(s.mobile2) : null;
  const mobiles = [first, second].filter((m, i, all): m is string => !!m && all.indexOf(m) === i);
  const skip = s.smsOff ? SKIP_REASONS.optedOut : s.status !== "active" ? SKIP_REASONS.notCurrent : !first ? SKIP_REASONS.noMobile : null;
  return { studentId: s.id, name: s.name, sectionLabel: s.sectionLabel, mobiles: skip ? [] : mobiles, skip, recordMobile: first ?? "" };
}

async function currentSessionOf(tx: Tx): Promise<string | null> {
  const [s] = await tx.select({ id: academicSessions.id }).from(academicSessions).where(eq(academicSessions.isCurrent, true));
  return s?.id ?? null;
}

/** The families of some students of one school (students of other schools are ignored). */
export async function familyInfo(tx: Tx, schoolId: string, studentIds: string[], settings: ResolvedSmsSettings): Promise<Map<string, FamilyInfo>> {
  const ids = [...new Set(studentIds)];
  const out = new Map<string, FamilyInfo>();
  if (!ids.length) return out;
  const sessionId = (await currentSessionOf(tx)) ?? "";
  const rows = await tx
    .select({
      id: students.id,
      name: students.name,
      status: students.status,
      smsOff: students.smsOff,
      guardianMobile: students.guardianMobile,
      mobile2: students.mobile2,
      className: classes.name,
      sectionName: sections.name,
    })
    .from(students)
    .leftJoin(enrolments, and(eq(enrolments.studentId, students.id), eq(enrolments.sessionId, sessionId)))
    .leftJoin(sections, eq(sections.id, enrolments.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId))
    .where(and(inArray(students.id, ids), eq(students.schoolId, schoolId)));
  for (const r of rows) {
    out.set(r.id, familyRecipient({ ...r, sectionLabel: r.className && r.sectionName ? sectionLabel(r.className, r.sectionName) : null }, settings));
  }
  return out;
}

/** Current students of a section (on its roll now). */
async function sectionStudentIds(tx: Tx, sectionId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: students.id })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(and(eq(enrolments.sectionId, sectionId), eq(students.status, "active")));
  return rows.map((r) => r.id);
}

/* ------------------------------------------------------------------ */
/* Writing rows                                                        */
/* ------------------------------------------------------------------ */

type NewRow = typeof smsMessages.$inferInsert;

type Draft = {
  kind: SmsKind;
  template: TemplateKey;
  values: Partial<Record<VarName, string>>;
  studentId?: string | null;
  staffId?: string | null;
  toMobile: string;
  sendAfter: Date;
  dedupeKey?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
  createdBy: string | null;
  /** "skipped" rows record a message that could not be sent, with the reason. */
  skip?: string | null;
};

function toRow(school: SchoolForSms, d: Draft): NewRow {
  const lang = school.settings.lang;
  const { vars, body } = renderSms(d.template, lang, d.values, { school: schoolNameIn(school, lang), portal: smsPortalAddress() });
  return {
    schoolId: school.id,
    kind: d.kind,
    template: d.template,
    lang,
    studentId: d.studentId ?? null,
    staffId: d.staffId ?? null,
    toMobile: d.toMobile,
    vars,
    body,
    status: d.skip ? "skipped" : "queued",
    error: d.skip ?? null,
    sendAfter: d.sendAfter,
    dedupeKey: d.skip ? null : (d.dedupeKey ?? null),
    relatedType: d.relatedType ?? null,
    relatedId: d.relatedId ?? null,
    createdBy: d.createdBy,
  };
}

/** Rows with the same dedupe key in one statement would clash: keep the last. */
function lastPerKey(rows: NewRow[]): NewRow[] {
  const byKey = new Map<string, NewRow>();
  const plain: NewRow[] = [];
  for (const r of rows) (r.dedupeKey ? byKey.set(r.dedupeKey, r) : plain.push(r));
  return [...plain, ...byKey.values()];
}

/**
 * Queue messages. A queued message with the same dedupe key is replaced
 * ("replace": the newer message wins, e.g. a corrected register) or left
 * alone ("keep": it is already on its way).
 */
async function put(tx: Tx, rows: NewRow[], onConflict: "replace" | "keep"): Promise<number> {
  const list = lastPerKey(rows);
  let n = 0;
  for (let i = 0; i < list.length; i += INSERT_CHUNK) n += await putChunk(tx, list.slice(i, i + INSERT_CHUNK), onConflict);
  return n;
}

/**
 * Rows per INSERT. Each row is about 16 parameters and PostgreSQL takes at
 * most 65,535 in one statement, so a whole-school notice is inserted in parts.
 */
const INSERT_CHUNK = 1_000;

/** Insert rows that are recorded as they are (skipped messages), in parts. */
async function insertRows(tx: Tx, rows: NewRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) await tx.insert(smsMessages).values(rows.slice(i, i + INSERT_CHUNK));
}

async function putChunk(tx: Tx, list: NewRow[], onConflict: "replace" | "keep"): Promise<number> {
  if (!list.length) return 0;
  const q = tx.insert(smsMessages).values(list);
  const done =
    onConflict === "keep"
      ? await q.onConflictDoNothing({ target: smsMessages.dedupeKey, where: sql`status = 'queued'` }).returning({ id: smsMessages.id })
      : await q
          .onConflictDoUpdate({
            target: smsMessages.dedupeKey,
            targetWhere: sql`status = 'queued'`,
            set: {
              kind: sql`excluded.kind`,
              template: sql`excluded.template`,
              lang: sql`excluded.lang`,
              studentId: sql`excluded.student_id`,
              staffId: sql`excluded.staff_id`,
              toMobile: sql`excluded.to_mobile`,
              vars: sql`excluded.vars`,
              body: sql`excluded.body`,
              sendAfter: sql`excluded.send_after`,
              relatedType: sql`excluded.related_type`,
              relatedId: sql`excluded.related_id`,
              createdBy: sql`excluded.created_by`,
              attempts: 0,
              error: null,
            },
          })
          .returning({ id: smsMessages.id });
  return done.length;
}

/** Cancel queued messages matching `where`; returns how many. */
async function cancelWhere(tx: Tx, where: SQL | undefined, reason: string): Promise<number> {
  const rows = await tx
    .update(smsMessages)
    .set({ status: "cancelled", error: reason })
    .where(and(eq(smsMessages.status, "queued"), where))
    .returning({ id: smsMessages.id });
  return rows.length;
}

const after = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

/* ------------------------------------------------------------------ */
/* Attendance                                                          */
/* ------------------------------------------------------------------ */

export type AttendanceStatusKey = "present" | "absent" | "late" | "leave";

export type AttendanceSmsResult = {
  /** Families that will get a message, by the mark they are told about. */
  queued: Record<AttendanceStatusKey, number>;
  /** Families that will get a correction (they had already been told something else). */
  corrections: number;
  /** Queued messages withdrawn because the mark changed before they were sent. */
  withdrawn: number;
  /** Families who would have got a message but can't (opted out, no mobile). */
  unreachable: number;
  /** Seconds before the messages go (so a quick correction replaces them). */
  delaySeconds: number;
};

const emptyAttendanceResult = (): AttendanceSmsResult => ({ queued: { present: 0, absent: 0, late: 0, leave: 0 }, corrections: 0, withdrawn: 0, unreachable: 0, delaySeconds: attendanceDelaySeconds() });

const attendanceEvent = (status: AttendanceStatusKey): SmsEvent => `attendance_${status}`;

/** The mark a sent or queued attendance message is about ("2026-09-30:absent" → "absent"). */
function markOf(relatedId: string | null): AttendanceStatusKey | null {
  const m = /:(present|absent|late|leave)$/.exec(relatedId ?? "");
  return m ? (m[1] as AttendanceStatusKey) : null;
}

/**
 * After a register is saved: tell each family whose child's mark is new or
 * changed — only for today's and yesterday's registers.
 *
 *  - Nothing sent yet for that child and day: queue the message for the
 *    new mark (if that mark's messages are on), sent after a delay
 *    (SMS_ATTENDANCE_DELAY_SECONDS, default 10 minutes). Saving again
 *    within the delay replaces it, so the family gets one message. If the
 *    new mark's messages are off, a queued one is withdrawn.
 *  - The family was already told a different mark: queue a short
 *    correction (even if the new mark's messages are off). Changed back to
 *    what they were told: a queued correction is withdrawn.
 */
export async function queueAttendance(
  tx: Tx,
  input: { schoolId: string; date: string; sectionLabel: string; changes: { studentId: string; status: AttendanceStatusKey }[]; createdBy: string | null },
  now = new Date(),
): Promise<AttendanceSmsResult> {
  const today = todayIST(now);
  if (!input.changes.length || (input.date !== today && input.date !== addDays(today, -1))) return emptyAttendanceResult();
  return safely(tx, `attendance of ${input.sectionLabel} on ${input.date}`, emptyAttendanceResult(), async (sp) => {
    const out = emptyAttendanceResult();
    const school = await schoolForSms(sp, input.schoolId);
    const s = school.settings;
    if (!s.enabled) return out;
    const lang = s.lang;
    const ids = [...new Set(input.changes.map((c) => c.studentId))];
    const fams = await familyInfo(sp, input.schoolId, ids, s);
    const existing = await sp
      .select({ id: smsMessages.id, studentId: smsMessages.studentId, toMobile: smsMessages.toMobile, status: smsMessages.status, relatedId: smsMessages.relatedId, sentAt: smsMessages.sentAt, error: smsMessages.error })
      .from(smsMessages)
      .where(
        and(
          eq(smsMessages.schoolId, input.schoolId),
          eq(smsMessages.relatedType, "attendance"),
          inArray(smsMessages.studentId, ids),
          like(smsMessages.relatedId, `${input.date}:%`),
          inArray(smsMessages.status, ["queued", "sent", "skipped"]),
        ),
      )
      .for("update");
    const sendAfter = after(now, out.delaySeconds);
    const rows: NewRow[] = [];
    const skipUpdates: { id: string; row: NewRow }[] = [];
    const cancelIds: string[] = [];
    for (const change of input.changes) {
      const f = fams.get(change.studentId);
      if (!f) continue;
      const N = change.status;
      const mine = existing.filter((r) => r.studentId === f.studentId);
      const base = {
        studentId: f.studentId,
        relatedType: "attendance",
        relatedId: `${input.date}:${N}`,
        createdBy: input.createdBy,
        sendAfter,
      };
      const values = { student: f.name, class: input.sectionLabel, date: smsDate(input.date), status: SMS_STATUS_WORDS[N][lang] };
      if (f.skip) {
        cancelIds.push(...mine.filter((r) => r.status === "queued").map((r) => r.id));
        const wouldSend = eventOn(s, attendanceEvent(N)) || mine.some((r) => r.status === "sent");
        if (!wouldSend) continue;
        out.unreachable++;
        const row = toRow(school, { ...base, kind: attendanceEvent(N), template: "attendance", values, toMobile: f.recordMobile, skip: f.skip });
        const earlier = mine.find((r) => r.status === "skipped");
        if (earlier) skipUpdates.push({ id: earlier.id, row });
        else rows.push(row);
        continue;
      }
      let queuedFor: "normal" | "correction" | null = null;
      for (const m of f.mobiles) {
        const onThis = mine.filter((r) => r.toMobile === m);
        const lastSent = onThis.filter((r) => r.status === "sent").sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))[0];
        const told = lastSent ? markOf(lastSent.relatedId) : null;
        const queued = onThis.find((r) => r.status === "queued");
        const dedupeKey = `att:${f.studentId}:${input.date}:${m}`;
        if (!told) {
          if (eventOn(s, attendanceEvent(N))) {
            rows.push(toRow(school, { ...base, kind: attendanceEvent(N), template: "attendance", values, toMobile: m, dedupeKey }));
            queuedFor ??= "normal";
          } else if (queued) {
            cancelIds.push(queued.id);
          }
        } else if (told === N) {
          if (queued) cancelIds.push(queued.id);
        } else {
          rows.push(
            toRow(school, {
              ...base,
              kind: "attendance_correction",
              template: "attendance_correction",
              values: { ...values, previous: SMS_STATUS_WORDS[told][lang] },
              toMobile: m,
              dedupeKey,
            }),
          );
          queuedFor = "correction";
        }
      }
      if (queuedFor === "correction") out.corrections++;
      else if (queuedFor === "normal") out.queued[N]++;
    }
    if (cancelIds.length) {
      out.withdrawn = await cancelWhere(sp, inArray(smsMessages.id, [...new Set(cancelIds)]), "The mark was changed before the message was sent.");
    }
    for (const u of skipUpdates) {
      await sp
        .update(smsMessages)
        .set({ kind: u.row.kind, template: u.row.template, lang: u.row.lang, toMobile: u.row.toMobile, vars: u.row.vars, body: u.row.body, relatedId: u.row.relatedId, error: u.row.error })
        .where(eq(smsMessages.id, u.id));
    }
    await put(sp, rows.filter((r) => r.status === "queued"), "replace");
    const skipped = rows.filter((r) => r.status === "skipped");
    if (skipped.length) await insertRows(sp, skipped);
    return out;
  });
}

/* ------------------------------------------------------------------ */
/* Remarks                                                             */
/* ------------------------------------------------------------------ */

export type SimpleSmsResult = { queued: number; unreachable: number; delaySeconds: number };
const none = (delaySeconds = 0): SimpleSmsResult => ({ queued: 0, unreachable: 0, delaySeconds });

/**
 * A remark was shared with the family (written as shared, or changed from
 * staff-only to shared): tell the family there is a note, not what it says.
 * Sent after SMS_REMARK_DELAY_SECONDS (default 3 minutes); withdrawn if the
 * remark is deleted or made staff-only before then. Never sent twice for
 * the same remark.
 */
export async function queueRemark(
  tx: Tx,
  input: { schoolId: string; remarkId: string; studentId: string; kind: "appreciation" | "concern"; createdBy: string | null },
  now = new Date(),
): Promise<SimpleSmsResult> {
  const delay = remarkDelaySeconds();
  return safely(tx, `a remark (${input.remarkId})`, none(delay), async (sp) => {
    const school = await schoolForSms(sp, input.schoolId);
    if (!eventOn(school.settings, "remark")) return none(delay);
    const lang = school.settings.lang;
    const f = (await familyInfo(sp, input.schoolId, [input.studentId], school.settings)).get(input.studentId);
    if (!f) return none(delay);
    const earlier = await sp
      .select({ toMobile: smsMessages.toMobile, status: smsMessages.status })
      .from(smsMessages)
      .where(and(eq(smsMessages.relatedType, "remark"), eq(smsMessages.relatedId, input.remarkId), inArray(smsMessages.status, ["queued", "sent", "skipped"])));
    const values = { student: f.name, class: f.sectionLabel ?? "-", kind: SMS_REMARK_WORDS[input.kind][lang] };
    const base = { kind: "remark" as const, template: "remark" as const, values, studentId: f.studentId, relatedType: "remark", relatedId: input.remarkId, createdBy: input.createdBy, sendAfter: after(now, delay) };
    if (f.skip) {
      if (!earlier.some((r) => r.status === "skipped")) await sp.insert(smsMessages).values(toRow(school, { ...base, toMobile: f.recordMobile, skip: f.skip }));
      return { queued: 0, unreachable: 1, delaySeconds: delay };
    }
    const already = new Set(earlier.filter((r) => r.status !== "skipped").map((r) => r.toMobile));
    const rows = f.mobiles.filter((m) => !already.has(m)).map((m) => toRow(school, { ...base, toMobile: m, dedupeKey: `remark:${input.remarkId}:${m}` }));
    const n = await put(sp, rows, "keep");
    return { queued: n, unreachable: 0, delaySeconds: delay };
  });
}

/** The remark was deleted or made staff-only: withdraw its message if it hasn't gone yet. */
export async function withdrawRemark(tx: Tx, remarkId: string, reason: string): Promise<number> {
  return safely(tx, `a remark (${remarkId})`, 0, (sp) => cancelWhere(sp, and(eq(smsMessages.relatedType, "remark"), eq(smsMessages.relatedId, remarkId)), reason));
}

/* ------------------------------------------------------------------ */
/* Notices                                                             */
/* ------------------------------------------------------------------ */

export type NoticeForSms = {
  id: string;
  schoolId: string;
  audience: "school" | "staff" | "section" | "students";
  sectionId: string | null;
  titleEn: string;
  titleHi: string | null;
  /** When the notice was written (its messages can't be older). */
  createdAt?: Date;
};

export const NOTICE_EVENT: Record<NoticeForSms["audience"], SmsEvent> = {
  school: "notice_school",
  section: "notice_class",
  students: "notice_students",
  staff: "notice_staff",
};

/**
 * Has this notice already been through the outbox (anything queued, sent,
 * skipped or cancelled)? Then it isn't sent again. Its messages can't be
 * older than the notice, so the search starts at `since` (its creation).
 */
export async function noticeAlreadyMessaged(tx: Tx, noticeId: string, schoolId: string, since?: Date): Promise<boolean> {
  const [row] = await tx
    .select({ id: smsMessages.id })
    .from(smsMessages)
    .where(
      and(
        eq(smsMessages.schoolId, schoolId),
        since ? gte(smsMessages.createdAt, since) : undefined,
        eq(smsMessages.relatedType, "notice"),
        eq(smsMessages.relatedId, noticeId),
      ),
    )
    .limit(1);
  return !!row;
}

/** The students a notice is for (families only; staff notices have none). */
async function noticeStudents(tx: Tx, n: NoticeForSms): Promise<string[]> {
  if (n.audience === "school") {
    const rows = await tx.select({ id: students.id }).from(students).where(and(eq(students.schoolId, n.schoolId), eq(students.status, "active")));
    return rows.map((r) => r.id);
  }
  if (n.audience === "section") return n.sectionId ? sectionStudentIds(tx, n.sectionId) : [];
  if (n.audience === "students") {
    const rows = await tx.select({ id: noticeRecipients.studentId }).from(noticeRecipients).where(eq(noticeRecipients.noticeId, n.id));
    return rows.map((r) => r.id);
  }
  return [];
}

/**
 * A notice is now showing (published, and its "show from" day has come):
 * tell its readers — every current family of the school, the families of
 * one section, the families of the chosen students, or staff. One message
 * per mobile number (brothers and sisters share one). The message gives
 * the notice's title and says to read it on the portal. Called once per
 * notice: editing a published notice doesn't send it again.
 */
export async function queueNotice(tx: Tx, n: NoticeForSms, createdBy: string | null, now = new Date()): Promise<SimpleSmsResult> {
  return safely(tx, `the notice ${n.id}`, none(), async (sp) => {
    const school = await schoolForSms(sp, n.schoolId);
    if (!eventOn(school.settings, NOTICE_EVENT[n.audience])) return none();
    if (await noticeAlreadyMessaged(sp, n.id, n.schoolId, n.createdAt)) return none();
    const lang = school.settings.lang;
    // In Hindi: the office's own Hindi title, else the Hindi translation made when it was published (lib/translate), else as written.
    const title = lang === "hi" ? n.titleHi || (await cachedHindi(sp, n.titleEn)) || n.titleEn : n.titleEn;
    const base = { kind: NOTICE_EVENT[n.audience], template: "notice" as const, values: { title }, relatedType: "notice", relatedId: n.id, createdBy, sendAfter: now };
    const rows: NewRow[] = [];
    const seen = new Set<string>();
    let unreachable = 0;
    if (n.audience === "staff") {
      const people = await sp
        .select({ id: staff.id, mobile: staff.mobile })
        .from(staff)
        .where(and(eq(staff.schoolId, n.schoolId), eq(staff.status, "active"), ne(staff.access, "none")));
      for (const p of people) {
        const m = validMobile(p.mobile);
        if (!m) {
          unreachable++;
          rows.push(toRow(school, { ...base, staffId: p.id, toMobile: "", skip: SKIP_REASONS.staffNoMobile }));
        } else if (!seen.has(m)) {
          seen.add(m);
          rows.push(toRow(school, { ...base, staffId: p.id, toMobile: m, dedupeKey: `notice:${n.id}:${m}` }));
        }
      }
    } else {
      const fams = await familyInfo(sp, n.schoolId, await noticeStudents(sp, n), school.settings);
      for (const f of [...fams.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        if (f.skip) {
          unreachable++;
          rows.push(toRow(school, { ...base, studentId: f.studentId, toMobile: f.recordMobile, skip: f.skip }));
          continue;
        }
        for (const m of f.mobiles) {
          if (seen.has(m)) continue;
          seen.add(m);
          rows.push(toRow(school, { ...base, studentId: f.studentId, toMobile: m, dedupeKey: `notice:${n.id}:${m}` }));
        }
      }
    }
    const queued = await put(sp, rows.filter((r) => r.status === "queued"), "keep");
    const skipped = rows.filter((r) => r.status === "skipped");
    if (skipped.length) await insertRows(sp, skipped);
    return { queued, unreachable, delaySeconds: 0 };
  });
}

/** The notice was archived: withdraw its messages that haven't gone yet. */
export async function withdrawNotice(tx: Tx, noticeId: string): Promise<number> {
  return safely(tx, `the notice ${noticeId}`, 0, (sp) =>
    cancelWhere(sp, and(eq(smsMessages.relatedType, "notice"), eq(smsMessages.relatedId, noticeId)), "The notice was archived before the message was sent."),
  );
}

/* ------------------------------------------------------------------ */
/* Homework summary                                                    */
/* ------------------------------------------------------------------ */

/**
 * One summary for a section's families: the subjects that were set
 * homework on `date` (in the school's language). Called by the sender at
 * the school's chosen time; `homework:<section>:<date>` rows show it went.
 */
export async function queueHomeworkDigest(
  tx: Tx,
  input: { schoolId: string; sectionId: string; sectionLabel: string; date: string; subjects: { en: string; hi: string }[] },
  now = new Date(),
): Promise<SimpleSmsResult> {
  return safely(tx, `the homework summary of ${input.sectionLabel}`, none(), async (sp) => {
    const school = await schoolForSms(sp, input.schoolId);
    if (!eventOn(school.settings, "homework_digest") || !input.subjects.length) return none();
    const lang = school.settings.lang;
    const names = [...new Set(input.subjects.map((x) => x[lang] || x.en))];
    const base = {
      kind: "homework_digest" as const,
      template: "homework" as const,
      values: { class: input.sectionLabel, date: smsDate(input.date), subjects: names.join(", ") },
      relatedType: "homework",
      relatedId: `${input.sectionId}:${input.date}`,
      createdBy: null,
      sendAfter: now,
    };
    const fams = await familyInfo(sp, input.schoolId, await sectionStudentIds(sp, input.sectionId), school.settings);
    const rows: NewRow[] = [];
    const seen = new Set<string>();
    let unreachable = 0;
    for (const f of [...fams.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (f.skip) {
        unreachable++;
        rows.push(toRow(school, { ...base, studentId: f.studentId, toMobile: f.recordMobile, skip: f.skip }));
        continue;
      }
      for (const m of f.mobiles) {
        if (seen.has(m)) continue;
        seen.add(m);
        rows.push(toRow(school, { ...base, studentId: f.studentId, toMobile: m, dedupeKey: `hw:${input.sectionId}:${input.date}:${m}` }));
      }
    }
    const queued = await put(sp, rows.filter((r) => r.status === "queued"), "keep");
    const skipped = rows.filter((r) => r.status === "skipped");
    if (skipped.length) await insertRows(sp, skipped);
    return { queued, unreachable, delaySeconds: 0 };
  });
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/**
 * A section's results were published: tell each family that their child's
 * results are on the portal. Families already told about this exam (the
 * results were reopened and published again) aren't told twice.
 */
export async function queueResults(
  tx: Tx,
  input: { schoolId: string; examId: string; examName: string; sectionId: string; sectionLabel: string; createdBy: string | null },
  now = new Date(),
): Promise<SimpleSmsResult> {
  return safely(tx, `the ${input.examName} results of ${input.sectionLabel}`, none(), async (sp) => {
    const school = await schoolForSms(sp, input.schoolId);
    if (!eventOn(school.settings, "results")) return none();
    const ids = await sectionStudentIds(sp, input.sectionId);
    if (!ids.length) return none();
    const fams = await familyInfo(sp, input.schoolId, ids, school.settings);
    const earlier = await sp
      .select({ studentId: smsMessages.studentId, toMobile: smsMessages.toMobile, status: smsMessages.status })
      .from(smsMessages)
      .where(and(eq(smsMessages.relatedType, "exam"), eq(smsMessages.relatedId, input.examId), inArray(smsMessages.studentId, ids), inArray(smsMessages.status, ["queued", "sent", "skipped"])));
    const told = new Set(earlier.filter((r) => r.status !== "skipped").map((r) => `${r.studentId}:${r.toMobile}`));
    const skippedBefore = new Set(earlier.filter((r) => r.status === "skipped").map((r) => r.studentId));
    const rows: NewRow[] = [];
    let unreachable = 0;
    for (const f of fams.values()) {
      const base = {
        kind: "results" as const,
        template: "results" as const,
        values: { exam: input.examName, student: f.name, class: input.sectionLabel },
        studentId: f.studentId,
        relatedType: "exam",
        relatedId: input.examId,
        createdBy: input.createdBy,
        sendAfter: now,
      };
      if (f.skip) {
        unreachable++;
        if (!skippedBefore.has(f.studentId)) rows.push(toRow(school, { ...base, toMobile: f.recordMobile, skip: f.skip }));
        continue;
      }
      for (const m of f.mobiles) {
        if (!told.has(`${f.studentId}:${m}`)) rows.push(toRow(school, { ...base, toMobile: m, dedupeKey: `results:${input.examId}:${f.studentId}:${m}` }));
      }
    }
    const queued = await put(sp, rows.filter((r) => r.status === "queued"), "keep");
    const skipped = rows.filter((r) => r.status === "skipped");
    if (skipped.length) await insertRows(sp, skipped);
    return { queued, unreachable, delaySeconds: 0 };
  });
}

/** Results reopened before their messages went: withdraw them (they are sent again when the results are published again). */
export async function withdrawResults(tx: Tx, input: { examId: string; sectionId: string }): Promise<number> {
  return safely(tx, `results (${input.examId})`, 0, async (sp) => {
    const ids = await sp.select({ id: enrolments.studentId }).from(enrolments).where(eq(enrolments.sectionId, input.sectionId));
    if (!ids.length) return 0;
    return cancelWhere(
      sp,
      and(eq(smsMessages.relatedType, "exam"), eq(smsMessages.relatedId, input.examId), inArray(smsMessages.studentId, ids.map((r) => r.id))),
      "The results were reopened before the message was sent.",
    );
  });
}

/* ------------------------------------------------------------------ */
/* Fees                                                                */
/* ------------------------------------------------------------------ */

/**
 * A fee payment was recorded (cash, cheque, bank or online — not an opening
 * balance): the family gets the amount, date and receipt number. Sent after
 * SMS_PAYMENT_DELAY_SECONDS (default 2 minutes), so a payment recorded by
 * mistake and cancelled straight away sends nothing.
 */
export async function queuePayment(
  tx: Tx,
  input: { schoolId: string; paymentId: string; studentId: string; amount: number; paidOn: string; receiptNo: string; method: string; createdBy: string | null },
  now = new Date(),
): Promise<SimpleSmsResult> {
  const delay = paymentDelaySeconds();
  if (input.method === "opening") return none(delay);
  return safely(tx, `receipt ${input.receiptNo}`, none(delay), async (sp) => {
    const school = await schoolForSms(sp, input.schoolId);
    if (!eventOn(school.settings, "payment")) return none(delay);
    const f = (await familyInfo(sp, input.schoolId, [input.studentId], school.settings)).get(input.studentId);
    if (!f) return none(delay);
    const base = {
      kind: "payment" as const,
      template: "payment" as const,
      values: { amount: smsAmount(input.amount), student: f.name, date: smsDate(input.paidOn), receipt: input.receiptNo },
      studentId: f.studentId,
      relatedType: "payment",
      relatedId: input.paymentId,
      createdBy: input.createdBy,
      sendAfter: after(now, delay),
    };
    if (f.skip) {
      await sp.insert(smsMessages).values(toRow(school, { ...base, toMobile: f.recordMobile, skip: f.skip }));
      return { queued: 0, unreachable: 1, delaySeconds: delay };
    }
    const queued = await put(sp, f.mobiles.map((m) => toRow(school, { ...base, toMobile: m, dedupeKey: `pay:${input.paymentId}:${m}` })), "keep");
    return { queued, unreachable: 0, delaySeconds: delay };
  });
}

/**
 * A receipt was cancelled (for example a bounced cheque). If the family's
 * receipt message hasn't gone yet it is withdrawn and nothing is sent;
 * numbers that were told about the payment get a cancellation message.
 */
export async function queuePaymentCancelled(
  tx: Tx,
  input: { schoolId: string; paymentId: string; studentId: string; amount: number; receiptNo: string; createdBy: string | null },
  now = new Date(),
): Promise<{ withdrawn: number; queued: number }> {
  return safely(tx, `the cancelled receipt ${input.receiptNo}`, { withdrawn: 0, queued: 0 }, async (sp) => {
    const withdrawn = await cancelWhere(
      sp,
      and(eq(smsMessages.relatedType, "payment"), eq(smsMessages.relatedId, input.paymentId), eq(smsMessages.template, "payment")),
      "The receipt was cancelled before the message was sent.",
    );
    const school = await schoolForSms(sp, input.schoolId);
    if (!school.settings.enabled) return { withdrawn, queued: 0 };
    const told = await sp
      .selectDistinct({ toMobile: smsMessages.toMobile })
      .from(smsMessages)
      .where(and(eq(smsMessages.relatedType, "payment"), eq(smsMessages.relatedId, input.paymentId), eq(smsMessages.template, "payment"), eq(smsMessages.status, "sent")));
    if (!told.length) return { withdrawn, queued: 0 };
    const [st] = await sp.select({ name: students.name }).from(students).where(eq(students.id, input.studentId));
    const rows = told.map((t) =>
      toRow(school, {
        kind: "payment",
        template: "payment_cancelled",
        values: { receipt: input.receiptNo, amount: smsAmount(input.amount), student: st?.name ?? "-" },
        studentId: input.studentId,
        toMobile: t.toMobile,
        relatedType: "payment",
        relatedId: input.paymentId,
        dedupeKey: `paycancel:${input.paymentId}:${t.toMobile}`,
        createdBy: input.createdBy,
        sendAfter: now,
      }),
    );
    return { withdrawn, queued: await put(sp, rows, "keep") };
  });
}

/**
 * The principal or an office admin declined a cash payment the family had
 * recorded on the portal: ask the family to contact the school. Sent at once
 * (quiet hours still apply), once per number for each record.
 */
export async function queueCashDeclined(
  tx: Tx,
  input: { schoolId: string; claimId: string; studentId: string; amount: number; createdBy: string | null },
  now = new Date(),
): Promise<SimpleSmsResult> {
  return safely(tx, `a declined cash payment (${input.claimId})`, none(), async (sp) => {
    const school = await schoolForSms(sp, input.schoolId);
    if (!eventOn(school.settings, "cash_declined")) return none();
    const f = (await familyInfo(sp, input.schoolId, [input.studentId], school.settings)).get(input.studentId);
    if (!f) return none();
    const base = {
      kind: "cash_declined" as const,
      template: "cash_declined" as const,
      values: { amount: smsAmount(input.amount), student: f.name },
      studentId: f.studentId,
      relatedType: "cash_claim",
      relatedId: input.claimId,
      createdBy: input.createdBy,
      sendAfter: now,
    };
    if (f.skip) {
      await sp.insert(smsMessages).values(toRow(school, { ...base, toMobile: f.recordMobile, skip: f.skip }));
      return { queued: 0, unreachable: 1, delaySeconds: 0 };
    }
    const queued = await put(sp, f.mobiles.map((m) => toRow(school, { ...base, toMobile: m, dedupeKey: `cashdecline:${input.claimId}:${m}` })), "keep");
    return { queued, unreachable: 0, delaySeconds: 0 };
  });
}

/* ------------------------------------------------------------------ */
/* Test messages                                                       */
/* ------------------------------------------------------------------ */

/** Queue a test message to a number an administrator typed; returns its id (the caller sends it at once). */
export async function queueTest(tx: Tx, input: { schoolId: string; toMobile: string; lang?: SmsLang; createdBy: string | null }, now = new Date()): Promise<string> {
  const school = await schoolForSms(tx, input.schoolId);
  const lang = input.lang ?? school.settings.lang;
  const row = toRow({ ...school, settings: { ...school.settings, lang } }, { kind: "test", template: "test", values: {}, toMobile: input.toMobile, sendAfter: now, createdBy: input.createdBy });
  const [r] = await tx.insert(smsMessages).values(row).returning({ id: smsMessages.id });
  return r.id;
}

/* ------------------------------------------------------------------ */
/* Office actions                                                      */
/* ------------------------------------------------------------------ */

/**
 * The family asked not to get text messages (or asked for them again).
 * Stopping them also withdraws the family's messages that haven't gone.
 */
export async function setFamilySmsOff(
  tx: Tx,
  input: { schoolId: string; studentId: string; off: boolean },
  actor: AuditActor,
): Promise<{ changed: boolean; withdrawn: number }> {
  const [s] = await tx
    .select({ id: students.id, smsOff: students.smsOff, name: students.name })
    .from(students)
    .where(and(eq(students.id, input.studentId), eq(students.schoolId, input.schoolId)))
    .for("update");
  if (!s) throw new Error("Student not found.");
  if (s.smsOff === input.off) return { changed: false, withdrawn: 0 };
  await tx.update(students).set({ smsOff: input.off, updatedAt: new Date() }).where(eq(students.id, s.id));
  const withdrawn = input.off ? await cancelWhere(tx, eq(smsMessages.studentId, s.id), SKIP_REASONS.optedOut) : 0;
  await audit(tx, actor, input.off ? "sms.family_off" : "sms.family_on", {
    schoolId: input.schoolId,
    targetType: "student",
    targetId: s.id,
    details: { studentId: s.id, ...(withdrawn ? { withdrawn } : {}) },
  });
  return { changed: true, withdrawn };
}

/** Failed messages can be tried again for this many days (after that the news is out of date). */
export const RETRY_DAYS = 7;

/**
 * Try failed messages again (all of the school's recent failed messages,
 * or the ones chosen). Returns how many were queued again.
 */
export async function retryFailed(tx: Tx, input: { schoolId: string; ids: string[] | "all" }, actor: AuditActor, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - RETRY_DAYS * 86_400_000);
  const where = and(
    eq(smsMessages.schoolId, input.schoolId),
    eq(smsMessages.status, "failed"),
    sql`${smsMessages.createdAt} >= ${since}`,
    input.ids === "all" ? undefined : inArray(smsMessages.id, input.ids.length ? input.ids : ["00000000-0000-0000-0000-000000000000"]),
  );
  const locked = await tx.select({ id: smsMessages.id, dedupeKey: smsMessages.dedupeKey }).from(smsMessages).where(where).for("update");
  if (!locked.length) return 0;
  // A newer message with the same key may be queued already (e.g. a correction): that one stands.
  const keys = locked.map((r) => r.dedupeKey).filter((k): k is string => !!k);
  const busy = keys.length
    ? new Set(
        (await tx.select({ k: smsMessages.dedupeKey }).from(smsMessages).where(and(eq(smsMessages.status, "queued"), inArray(smsMessages.dedupeKey, keys)))).map((r) => r.k),
      )
    : new Set<string | null>();
  const ids = locked.filter((r) => !r.dedupeKey || !busy.has(r.dedupeKey)).map((r) => r.id);
  if (!ids.length) return 0;
  const done = await tx
    .update(smsMessages)
    .set({ status: "queued", attempts: 0, error: null, sendAfter: now })
    .where(inArray(smsMessages.id, ids))
    .returning({ id: smsMessages.id });
  await audit(tx, actor, "sms.retried", { schoolId: input.schoolId, targetType: "sms", targetId: done.length === 1 ? done[0].id : undefined, details: { count: done.length } });
  return done.length;
}

/** Cancel queued messages the office chose. Returns how many were cancelled. */
export async function cancelQueued(tx: Tx, input: { schoolId: string; ids: string[] }, actor: AuditActor & { name?: string }): Promise<number> {
  if (!input.ids.length) return 0;
  const n = await cancelWhere(tx, and(eq(smsMessages.schoolId, input.schoolId), inArray(smsMessages.id, input.ids)), `Cancelled by the school office${actor.loginId ? ` (${actor.loginId})` : ""}.`);
  if (n) await audit(tx, actor, "sms.cancelled", { schoolId: input.schoolId, targetType: "sms", targetId: n === 1 ? input.ids[0] : undefined, details: { count: n } });
  return n;
}

