/**
 * The sender: works through the text message outbox.
 *
 * Every ~30 seconds (SMS_WORKER_INTERVAL_SECONDS) each portal server runs
 * one pass (runSmsPass):
 *
 *  1. notices published earlier for today's date are queued (the day their
 *     "show from" date comes);
 *  2. each school's homework summaries are queued, once its chosen time has
 *     passed, for classes that were set homework today;
 *  3. messages that are due are sent, in batches locked with
 *     SELECT … FOR UPDATE SKIP LOCKED, so two servers never send the same
 *     message. A school's messages wait while it is in its quiet time
 *     (test messages don't). Before sending, each message is checked again
 *     against the school's switches and the family's choice. A failed
 *     message is tried again after 2, 10 and 30 minutes, then marked
 *     failed (the office can try it again);
 *  4. once an hour, messages older than 180 days lose their text,
 *     variables and full number (counts stay).
 *
 * Nothing here may stop the server: every step catches and logs its errors.
 * Started from instrumentation-node.ts (SMS_WORKER=off turns it off);
 * `npm run sms:send` runs one pass from the command line.
 */
import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import { classes, homework, notices, schools, sections, smsMessages, staff, students, subjects } from "@/lib/db/schema";
import { sectionLabel } from "@/lib/classes";
import { todayIST } from "@/lib/dates";
import { PROVIDER_LABELS, senderIdFor, smsMode, workerIntervalSeconds } from "./config";
import { noticeAlreadyMessaged, queueHomeworkDigest, queueNotice, SKIP_REASONS } from "./outbox";
import { currentProvider, safeError, type OutgoingSms, type SendOutcome } from "./providers";
import { eventOfKind, inQuietHours, istTime, KIND_LABELS, loadTemplateIds, resolveSmsSettings, SMS_EVENTS, templateIdFor, type ResolvedSmsSettings } from "./settings";
import { isTemplateKey, SMS_LANG_NAMES, TEMPLATES, validMobile, type SmsLang, type TemplateKey } from "./templates";

/** Messages sent per locked batch, and batches per pass (so one pass sends at most 1,000). */
const BATCH = 50;
const MAX_BATCHES = 20;
/**
 * Fast2SMS takes one call for each different set of variables (in practice one a message),
 * and a batch's messages stay locked until every call has answered — so a teacher re-saving a
 * register would wait for them. Its batches are smaller, for the same 1,000 a pass.
 */
const FAST2SMS_BATCH = 10;
const FAST2SMS_MAX_BATCHES = 100;
/** The first try and three more. */
export const MAX_ATTEMPTS = 4;
/** Minutes to wait before the 2nd, 3rd and 4th tries. */
export const RETRY_MINUTES = [2, 10, 30];
/** Message text, variables and full numbers are kept this long. */
export const KEEP_DAYS = 180;

/** Midnight at the start of an Indian day. */
export const istStart = (iso: string) => new Date(`${iso}T00:00:00+05:30`);

type SmsRow = typeof smsMessages.$inferSelect;

export type PassTotals = { scheduled: number; digests: number; sent: number; failed: number; retrying: number; skipped: number; cancelled: number; purged: number };
const zero = (): PassTotals => ({ scheduled: 0, digests: 0, sent: 0, failed: 0, retrying: 0, skipped: 0, cancelled: 0, purged: 0 });

/* ------------------------------------------------------------------ */
/* One server at a time for the scheduled work                         */
/* ------------------------------------------------------------------ */

const LOCK_SCHEDULED = 8_152_026_001;

/** A transaction-long advisory lock, so two servers don't queue the same scheduled messages at the same moment. */
async function tryLock(tx: Tx, key: number): Promise<boolean> {
  const res = (await tx.execute(sql`select pg_try_advisory_xact_lock(${key}) as ok`)) as unknown as { rows?: { ok: unknown }[] } | { ok: unknown }[];
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return rows[0]?.ok === true || rows[0]?.ok === "t";
}

/* ------------------------------------------------------------------ */
/* 1. Notices whose day has come                                       */
/* ------------------------------------------------------------------ */

/**
 * Notices published on an earlier day for today: queue their messages
 * today. (Notices published for today or an earlier date are queued when
 * they are published, and editing a notice never sends it again.)
 */
export async function queueScheduledNotices(now = new Date()): Promise<number> {
  const db = await getDb();
  const today = todayIST(now);
  return db.transaction(async (tx) => {
    if (!(await tryLock(tx, LOCK_SCHEDULED))) return 0;
    const due = await tx
      .select({
        id: notices.id,
        schoolId: notices.schoolId,
        audience: notices.audience,
        sectionId: notices.sectionId,
        titleEn: notices.titleEn,
        titleHi: notices.titleHi,
        createdAt: notices.createdAt,
        approvedBy: notices.approvedBy,
      })
      .from(notices)
      .where(
        and(
          eq(notices.status, "published"),
          eq(notices.publishOn, today),
          lt(notices.approvedAt, istStart(today)),
          or(isNull(notices.expiresOn), gte(notices.expiresOn, today)),
        ),
      );
    let n = 0;
    for (const x of due) {
      if (await noticeAlreadyMessaged(tx, x.id, x.schoolId, x.createdAt)) continue;
      n += (await queueNotice(tx, x, x.approvedBy, now)).queued;
    }
    return n;
  });
}

/* ------------------------------------------------------------------ */
/* 2. Homework summaries                                               */
/* ------------------------------------------------------------------ */

/**
 * After each school's chosen time: one summary per class that was set
 * homework today (homework "set on" today), if it hasn't had one today.
 */
export async function queueHomeworkDigests(now = new Date()): Promise<number> {
  const db = await getDb();
  const today = todayIST(now);
  const hhmm = istTime(now);
  const all = await db.select({ id: schools.id, settings: schools.settings }).from(schools);
  const due = all.filter((s) => {
    const st = resolveSmsSettings(s.settings.sms);
    return st.enabled && st.events.homework_digest && hhmm >= st.homeworkDigestAt;
  });
  if (!due.length) return 0;
  return db.transaction(async (tx) => {
    if (!(await tryLock(tx, LOCK_SCHEDULED + 1))) return 0;
    let n = 0;
    for (const school of due) {
      const rows = await tx
        .select({ sectionId: homework.sectionId, className: classes.name, sectionName: sections.name, en: subjects.name, hi: subjects.nameHi })
        .from(homework)
        .innerJoin(sections, eq(sections.id, homework.sectionId))
        .innerJoin(classes, eq(classes.id, sections.classId))
        .leftJoin(subjects, eq(subjects.id, homework.subjectId))
        .where(and(eq(classes.schoolId, school.id), eq(homework.assignedOn, today)))
        .orderBy(asc(subjects.sortOrder), asc(subjects.name), asc(homework.createdAt));
      if (!rows.length) continue;
      const bySection = new Map<string, { label: string; subjects: { en: string; hi: string }[] }>();
      for (const r of rows) {
        const sec = bySection.get(r.sectionId) ?? { label: sectionLabel(r.className, r.sectionName), subjects: [] };
        sec.subjects.push(r.en ? { en: r.en, hi: r.hi || r.en } : { en: "General", hi: "सामान्य" });
        bySection.set(r.sectionId, sec);
      }
      const keys = [...bySection.keys()].map((id) => `${id}:${today}`);
      const done = await tx
        .selectDistinct({ relatedId: smsMessages.relatedId })
        .from(smsMessages)
        .where(and(eq(smsMessages.schoolId, school.id), gte(smsMessages.createdAt, istStart(today)), eq(smsMessages.relatedType, "homework"), inArray(smsMessages.relatedId, keys)));
      const doneSet = new Set(done.map((d) => d.relatedId));
      for (const [sectionId, sec] of bySection) {
        if (doneSet.has(`${sectionId}:${today}`)) continue;
        n += (await queueHomeworkDigest(tx, { schoolId: school.id, sectionId, sectionLabel: sec.label, date: today, subjects: sec.subjects }, now)).queued;
      }
    }
    return n;
  });
}

/* ------------------------------------------------------------------ */
/* 3. Sending                                                          */
/* ------------------------------------------------------------------ */

type Settle =
  | { status: "sent"; provider: string; providerRef: string | null }
  | { status: "skipped" | "cancelled"; error: string }
  | { status: "failed"; error: string };

function describeEvent(kind: string): string {
  const ev = SMS_EVENTS.find((e) => e.key === kind);
  return ev ? ev.label : (KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

/**
 * Decide and send a batch of locked, due messages: check each against the
 * school's switches, the family's choice and the set-up, send the rest in
 * groups of one school's template in one language (each school has its own
 * registered templates and may have its own sender ID), and record what
 * happened.
 */
async function deliver(tx: Tx, rows: SmsRow[], now: Date): Promise<PassTotals> {
  const totals = zero();
  const schoolIds = [...new Set(rows.map((r) => r.schoolId))];
  const studentIds = [...new Set(rows.map((r) => r.studentId).filter((x): x is string => !!x))];
  const staffIds = [...new Set(rows.map((r) => r.staffId).filter((x): x is string => !!x))];
  const [schoolRows, studentRows, staffRows] = await Promise.all([
    tx.select({ id: schools.id, settings: schools.settings }).from(schools).where(inArray(schools.id, schoolIds)),
    studentIds.length ? tx.select({ id: students.id, smsOff: students.smsOff }).from(students).where(inArray(students.id, studentIds)) : [],
    staffIds.length ? tx.select({ id: staff.id, status: staff.status }).from(staff).where(inArray(staff.id, staffIds)) : [],
  ]);
  const settingsOf = new Map<string, ResolvedSmsSettings>(schoolRows.map((s) => [s.id, resolveSmsSettings(s.settings.sms)]));
  const optedOut = new Set(studentRows.filter((s) => s.smsOff).map((s) => s.id));
  const staffActive = new Set(staffRows.filter((s) => s.status === "active").map((s) => s.id));
  const mode = smsMode();
  const provider = currentProvider();
  const ids = mode === "live" ? await loadTemplateIds(tx) : {};

  const settle = new Map<string, Settle>();
  const groups = new Map<string, { schoolId: string; template: TemplateKey; lang: SmsLang; batch: OutgoingSms[] }>();
  for (const r of rows) {
    const s = settingsOf.get(r.schoolId);
    const event = eventOfKind(r.kind);
    const exempt = r.template === "attendance_correction" || r.template === "payment_cancelled";
    if (r.kind !== "test") {
      if (!s?.enabled) {
        settle.set(r.id, { status: "cancelled", error: "Text messages were switched off for the school (Settings)." });
        continue;
      }
      if (event && !exempt && !s.events[event]) {
        settle.set(r.id, { status: "cancelled", error: `“${describeEvent(event)}” messages were switched off in Settings.` });
        continue;
      }
      if (r.studentId && optedOut.has(r.studentId)) {
        settle.set(r.id, { status: "skipped", error: SKIP_REASONS.optedOut });
        continue;
      }
      if (r.staffId && !staffActive.has(r.staffId)) {
        settle.set(r.id, { status: "skipped", error: "No longer on the staff." });
        continue;
      }
    }
    const lang = r.lang === "en" || r.lang === "hi" ? (r.lang as SmsLang) : null;
    if (!validMobile(r.toMobile)) {
      settle.set(r.id, { status: "skipped", error: SKIP_REASONS.noMobile });
      continue;
    }
    if (!isTemplateKey(r.template) || !lang) {
      settle.set(r.id, { status: "failed", error: `Unknown message template “${r.template}”.` });
      continue;
    }
    if (mode === "off") {
      settle.set(r.id, { status: "skipped", error: "SMS isn’t set up yet: no SMS company is connected to the portal." });
      continue;
    }
    if (mode === "live" && provider.name === "fast2sms" && !senderIdFor(r.schoolId)) {
      settle.set(r.id, { status: "skipped", error: "SMS isn’t fully set up: there is no sender ID (SMS_SENDER_ID) for this school." });
      continue;
    }
    if (mode === "live" && !templateIdFor(ids, provider.name, r.schoolId, r.template, lang)) {
      settle.set(r.id, {
        status: "skipped",
        error: `Template not set up: “${TEMPLATES[r.template].name}” in ${SMS_LANG_NAMES[lang]} has no ${PROVIDER_LABELS[provider.name]} template ID for this school yet.`,
      });
      continue;
    }
    const key = `${r.schoolId}|${r.template}|${lang}`;
    const group = groups.get(key) ?? { schoolId: r.schoolId, template: r.template, lang, batch: [] };
    group.batch.push({ id: r.id, to: r.toMobile, vars: r.vars, body: r.body, lang });
    groups.set(key, group);
  }

  for (const { schoolId, template, lang, batch } of groups.values()) {
    const templateId = mode === "live" ? templateIdFor(ids, provider.name, schoolId, template, lang) : null;
    let outcomes: SendOutcome[];
    try {
      outcomes = await provider.send(templateId, batch, senderIdFor(schoolId));
    } catch (err) {
      outcomes = batch.map((m) => ({ id: m.id, ok: false, error: safeError(err instanceof Error ? err.message : err) }));
    }
    const byId = new Map(outcomes.map((o) => [o.id, o]));
    for (const m of batch) {
      const o = byId.get(m.id) ?? { id: m.id, ok: false as const, error: "The SMS company gave no answer for this message." };
      settle.set(m.id, o.ok ? { status: "sent", provider: provider.name, providerRef: o.ref } : { status: "failed", error: o.error });
    }
  }

  for (const r of rows) {
    const d = settle.get(r.id);
    if (!d) continue;
    if (d.status === "sent") {
      totals.sent++;
      await tx
        .update(smsMessages)
        .set({ status: "sent", provider: d.provider, providerRef: d.providerRef, sentAt: now, attempts: r.attempts + 1, error: null })
        .where(eq(smsMessages.id, r.id));
    } else if (d.status === "failed") {
      const attempts = r.attempts + 1;
      if (attempts >= MAX_ATTEMPTS || !isTemplateKey(r.template)) {
        totals.failed++;
        await tx
          .update(smsMessages)
          .set({ status: "failed", provider: provider.name, attempts, error: `${d.error} (tried ${attempts} ${attempts === 1 ? "time" : "times"})` })
          .where(eq(smsMessages.id, r.id));
      } else {
        totals.retrying++;
        const wait = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
        await tx
          .update(smsMessages)
          .set({ provider: provider.name, attempts, error: d.error, sendAfter: new Date(now.getTime() + wait * 60_000) })
          .where(eq(smsMessages.id, r.id));
      }
    } else {
      if (d.status === "skipped") totals.skipped++;
      else totals.cancelled++;
      await tx.update(smsMessages).set({ status: d.status, error: d.error }).where(eq(smsMessages.id, r.id));
    }
  }
  return totals;
}

const add = (a: PassTotals, b: PassTotals) => {
  for (const k of Object.keys(a) as (keyof PassTotals)[]) a[k] += b[k];
};

/** Schools whose quiet time it is now (their messages wait). */
async function schoolsInQuietTime(now: Date): Promise<string[]> {
  const db = await getDb();
  const all = await db.select({ id: schools.id, settings: schools.settings }).from(schools);
  const hhmm = istTime(now);
  return all.filter((s) => inQuietHours(resolveSmsSettings(s.settings.sms).quietHours, hhmm)).map((s) => s.id);
}

/** Send every message that is due (outside its school's quiet time). */
export async function sendDueMessages(now = new Date()): Promise<PassTotals> {
  const db = await getDb();
  const totals = zero();
  const quiet = await schoolsInQuietTime(now);
  const small = smsMode() === "live" && currentProvider().name === "fast2sms";
  const batch = small ? FAST2SMS_BATCH : BATCH;
  const maxBatches = small ? FAST2SMS_MAX_BATCHES : MAX_BATCHES;
  for (let i = 0; i < maxBatches; i++) {
    const n = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(smsMessages)
        .where(
          and(
            eq(smsMessages.status, "queued"),
            lte(smsMessages.sendAfter, now),
            quiet.length ? or(notInArray(smsMessages.schoolId, quiet), eq(smsMessages.kind, "test")) : undefined,
          ),
        )
        .orderBy(asc(smsMessages.sendAfter), asc(smsMessages.createdAt))
        .limit(batch)
        .for("update", { skipLocked: true });
      if (!rows.length) return 0;
      add(totals, await deliver(tx, rows, now));
      return rows.length;
    });
    if (n < batch) break;
  }
  return totals;
}

/**
 * Send some queued messages now, whatever the time (a test message the
 * office is waiting for). Returns the messages as they are afterwards.
 */
export async function sendNow(ids: string[]): Promise<SmsRow[]> {
  if (!ids.length) return [];
  const db = await getDb();
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(smsMessages)
      .where(and(inArray(smsMessages.id, ids), eq(smsMessages.status, "queued")))
      .for("update", { skipLocked: true });
    if (rows.length) await deliver(tx, rows, new Date());
  });
  return db.select().from(smsMessages).where(inArray(smsMessages.id, ids));
}

/* ------------------------------------------------------------------ */
/* 4. Old messages                                                     */
/* ------------------------------------------------------------------ */

/**
 * Messages older than 180 days keep only what is needed for counts: their
 * text and variables are cleared and the number is masked.
 */
export async function purgeOldMessages(now = new Date()): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000);
  const rows = await db
    .update(smsMessages)
    .set({
      body: "",
      vars: [],
      dedupeKey: null,
      toMobile: sql`case when length(${smsMessages.toMobile}) = 10 then left(${smsMessages.toMobile}, 2) || '•••••' || right(${smsMessages.toMobile}, 2) else ${smsMessages.toMobile} end`,
    })
    .where(and(lt(smsMessages.createdAt, cutoff), ne(smsMessages.status, "queued"), or(ne(smsMessages.body, ""), sql`length(${smsMessages.toMobile}) = 10`)))
    .returning({ id: smsMessages.id });
  return rows.length;
}

/* ------------------------------------------------------------------ */
/* One pass, and the timer                                             */
/* ------------------------------------------------------------------ */

const g = globalThis as unknown as { __aesriSmsWorker?: { timer: ReturnType<typeof setInterval>; lastPurge: number; running: boolean } };

/** One pass of the sender. Each step's errors are logged and don't stop the others. */
export async function runSmsPass(now = new Date(), opts: { purge?: boolean } = {}): Promise<PassTotals> {
  const totals = zero();
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[sms] ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await step("queueing notices", async () => {
    totals.scheduled = await queueScheduledNotices(now);
  });
  await step("queueing homework summaries", async () => {
    totals.digests = await queueHomeworkDigests(now);
  });
  await step("sending", async () => {
    add(totals, await sendDueMessages(now));
  });
  if (opts.purge) {
    await step("clearing old messages", async () => {
      totals.purged = await purgeOldMessages(now);
    });
  }
  return totals;
}

function summary(t: PassTotals): string | null {
  const parts = [
    t.scheduled ? `${t.scheduled} notice messages queued` : "",
    t.digests ? `${t.digests} homework summaries queued` : "",
    t.sent ? `${t.sent} sent` : "",
    t.retrying ? `${t.retrying} to try again` : "",
    t.failed ? `${t.failed} failed` : "",
    t.skipped ? `${t.skipped} skipped` : "",
    t.cancelled ? `${t.cancelled} cancelled` : "",
    t.purged ? `${t.purged} old messages cleared` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Start the sender in this server process (once, even if called again).
 * The timer doesn't keep the process alive and a pass never overlaps the
 * previous one.
 */
export function startSmsWorker(): void {
  if (g.__aesriSmsWorker) return;
  const every = workerIntervalSeconds() * 1000;
  const state = { timer: undefined as unknown as ReturnType<typeof setInterval>, lastPurge: 0, running: false };
  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      const purge = Date.now() - state.lastPurge > 3_600_000;
      const t = await runSmsPass(new Date(), { purge });
      if (purge) state.lastPurge = Date.now();
      const said = summary(t);
      if (said) console.info(`[sms] ${said}`);
    } catch (err) {
      console.error(`[sms] The sender stopped a pass: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      state.running = false;
    }
  };
  state.timer = setInterval(tick, every);
  state.timer.unref?.();
  setTimeout(tick, Math.min(5_000, every)).unref?.();
  g.__aesriSmsWorker = state;
  const mode = smsMode();
  console.info(
    `[sms] Sender started (every ${every / 1000} s): ${
      mode === "live" ? `sending through ${PROVIDER_LABELS[currentProvider().name]}` : mode === "test" ? "test mode, messages are written to this log" : "no SMS company set up, messages are recorded as skipped"
    }.`,
  );
}

