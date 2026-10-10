/**
 * The text message outbox and sender against a real (embedded) PostgreSQL:
 * who gets which message, merging and cancelling queued messages,
 * corrections, notices by audience, scheduled notices, homework summaries,
 * results, fees, settings switches, opt-outs, quiet hours, retries and the
 * 180-day clean-up. The SMS companies are never called (fetch is mocked).
 *
 *   node --import tsx --test tests/unit/sms-outbox.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "../../lib/db/client";
import * as schema from "../../lib/db/schema";
import { seedReferenceData } from "../../lib/services/reference";
import { saveRegister } from "../../lib/services/attendance";
import { activeNoticesForFamily, archiveNotice, createClassNotice, createOfficeNotice } from "../../lib/services/notices";
import { createRemark, updateRemark } from "../../lib/services/remarks";
import * as outbox from "../../lib/sms/outbox";
import * as worker from "../../lib/sms/worker";
import * as settingsMod from "../../lib/sms/settings";
import { addDays, todayIST } from "../../lib/dates";

// A fresh embedded database for this file (getDb() reads these when it first connects).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-sms-test-"));
process.env.PGLITE_DIR = dir;
delete process.env.DATABASE_URL;
delete process.env.SMS_PROVIDER;
process.env.APP_URL = "https://portal.aesri.org";

const { smsMessages, students, enrolments, sections, classes, staff, accounts, schools, homework, subjects, appSettings } = schema;
type Tx = Parameters<Parameters<Awaited<ReturnType<typeof getDb>>["transaction"]>[0]>[0];

const SCHOOL = "aryavart";
const SESSION = "2026-27";
let db: Awaited<ReturnType<typeof getDb>>;
let secA: string; // IV-A
let secB: string; // IV-B
let teacherAccount: string;
const S: Record<string, string> = {}; // student ids by short name
const writer = () => ({ accountId: teacherAccount, loginId: "AryaE3", ip: null });
const office = () => ({ accountId: teacherAccount, loginId: "AryaE1", ip: null });

async function addStudent(tx: Tx, key: string, opts: { section: string; mobile?: string | null; mobile2?: string | null; smsOff?: boolean; status?: "active" | "left"; roll: number }) {
  const [s] = await tx
    .insert(students)
    .values({
      schoolId: SCHOOL,
      srNo: String(7000 + opts.roll + (opts.section === secB ? 100 : 0)),
      name: `${key} Kumar`,
      guardianMobile: opts.mobile === undefined ? `98765${String(opts.roll).padStart(5, "0")}` : opts.mobile,
      mobile2: opts.mobile2 ?? null,
      smsOff: opts.smsOff ?? false,
      status: opts.status ?? "active",
    })
    .returning({ id: students.id });
  await tx.insert(enrolments).values({ studentId: s.id, sessionId: SESSION, sectionId: opts.section, rollNo: opts.roll });
  S[key] = s.id;
}

before(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedReferenceData(tx);
    const [cls] = await tx.select({ id: classes.id }).from(classes).where(and(eq(classes.schoolId, SCHOOL), eq(classes.name, "IV")));
    const [a] = await tx.select({ id: sections.id }).from(sections).where(and(eq(sections.classId, cls.id), eq(sections.name, "A")));
    secA = a.id;
    const [b] = await tx.insert(sections).values({ classId: cls.id, sessionId: SESSION, name: "B" }).returning({ id: sections.id });
    secB = b.id;
    const [t] = await tx.insert(staff).values({ schoolId: SCHOOL, empNo: "3", name: "Sunita Meena", access: "teacher", mobile: "9000000003" }).returning({ id: staff.id });
    await tx.insert(staff).values({ schoolId: SCHOOL, empNo: "4", name: "No Login", access: "none", mobile: "9000000004" });
    await tx.insert(staff).values({ schoolId: SCHOOL, empNo: "5", name: "No Mobile", access: "teacher", mobile: null });
    await tx.insert(staff).values({ schoolId: SCHOOL, empNo: "6", name: "Gone Away", access: "teacher", mobile: "9000000006", status: "left" });
    const [acc] = await tx.insert(accounts).values({ loginId: "aryae3", role: "teacher", schoolId: SCHOOL, staffId: t.id, status: "active" }).returning({ id: accounts.id });
    teacherAccount = acc.id;
    await addStudent(tx, "Asha", { section: secA, roll: 1 });
    await addStudent(tx, "Bhanu", { section: secA, roll: 2, mobile2: "9111111102" });
    await addStudent(tx, "Chetan", { section: secA, roll: 3, smsOff: true });
    await addStudent(tx, "Deepa", { section: secA, roll: 4, mobile: null });
    await addStudent(tx, "Esha", { section: secA, roll: 5, mobile: "9876500001" }); // Asha's sibling: same mobile
    await addStudent(tx, "Farhan", { section: secB, roll: 1, mobile: "9222222201" });
    await addStudent(tx, "Gita", { section: secB, roll: 2, mobile: "9222222202", status: "left" });
  });
});

after(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every message about some students (or all), oldest first. */
async function rows(where?: ReturnType<typeof eq>) {
  return db.select().from(smsMessages).where(where).orderBy(smsMessages.createdAt);
}

async function setSms(change: (s: ReturnType<typeof settingsMod.resolveSmsSettings>) => void) {
  await db.transaction(async (tx) => {
    const [cur] = await tx.select({ settings: schools.settings }).from(schools).where(eq(schools.id, SCHOOL));
    const next = settingsMod.resolveSmsSettings(cur.settings.sms);
    change(next);
    await tx.update(schools).set({ settings: { ...cur.settings, sms: next } }).where(eq(schools.id, SCHOOL));
  });
}

/** No messages, default settings — except no quiet time, so results don't depend on the hour the tests run. */
async function resetSms() {
  await db.delete(smsMessages);
  await db.update(schools).set({ settings: sql`${schools.settings} - 'sms'` }).where(eq(schools.id, SCHOOL));
  await setSms((s) => (s.quietHours = null));
}

const MIN = 60_000;
const at = (d: Date, minutes: number) => new Date(d.getTime() + minutes * MIN);

/* ------------------------------------------------------------------ */

describe("recipients", () => {
  test("parent's mobile; second mobile only when the school sends to both; opted-out, left and no-mobile families are skipped with a reason", () => {
    const base = { id: "x", name: "X", status: "active", smsOff: false, guardianMobile: "9876543210", mobile2: "9123456780", sectionLabel: "IV-A" };
    assert.deepEqual(outbox.familyRecipient(base, { alsoSecondMobile: false }).mobiles, ["9876543210"]);
    assert.deepEqual(outbox.familyRecipient(base, { alsoSecondMobile: true }).mobiles, ["9876543210", "9123456780"]);
    assert.deepEqual(outbox.familyRecipient({ ...base, mobile2: "+91 98765 43210" }, { alsoSecondMobile: true }).mobiles, ["9876543210"], "same number once");
    assert.equal(outbox.familyRecipient({ ...base, smsOff: true }, { alsoSecondMobile: true }).skip, outbox.SKIP_REASONS.optedOut);
    assert.equal(outbox.familyRecipient({ ...base, status: "left" }, { alsoSecondMobile: true }).skip, outbox.SKIP_REASONS.notCurrent);
    const none = outbox.familyRecipient({ ...base, guardianMobile: "12345" }, { alsoSecondMobile: true });
    assert.equal(none.skip, outbox.SKIP_REASONS.noMobile);
    assert.deepEqual(none.mobiles, []);
  });

  test("quiet hours run past midnight and end at the end time", () => {
    const q = { from: "21:00", to: "07:00" };
    assert.equal(settingsMod.inQuietHours(q, "21:00"), true);
    assert.equal(settingsMod.inQuietHours(q, "23:59"), true);
    assert.equal(settingsMod.inQuietHours(q, "03:00"), true);
    assert.equal(settingsMod.inQuietHours(q, "07:00"), false);
    assert.equal(settingsMod.inQuietHours(q, "12:00"), false);
    assert.equal(settingsMod.inQuietHours({ from: "13:00", to: "14:00" }, "13:30"), true);
    assert.equal(settingsMod.inQuietHours({ from: "13:00", to: "14:00" }, "14:30"), false);
    assert.equal(settingsMod.inQuietHours(null, "03:00"), false);
    assert.equal(settingsMod.istTime(new Date("2026-09-30T16:31:00+05:30")), "16:31");
  });

  test("defaults: on, every event on (present too), Hindi, parent's mobile only, homework at 16:30, quiet 21:00–07:00", () => {
    const d = settingsMod.resolveSmsSettings(undefined);
    assert.equal(d.enabled, true);
    assert.ok(Object.values(d.events).every(Boolean));
    assert.equal(d.events.attendance_present, true);
    assert.equal(d.lang, "hi");
    assert.equal(d.alsoSecondMobile, false);
    assert.equal(d.homeworkDigestAt, "16:30");
    assert.deepEqual(d.quietHours, { from: "21:00", to: "07:00" });
  });
});

describe("attendance", () => {
  beforeEach(resetSms);
  const now = new Date();
  const today = todayIST(now);
  const q = (changes: { studentId: string; status: "present" | "absent" | "late" | "leave" }[], when = now, date = today) =>
    db.transaction((tx) => outbox.queueAttendance(tx, { schoolId: SCHOOL, date, sectionLabel: "IV-A", changes, createdBy: teacherAccount }, when));

  test("a message per family whose child's mark is new, 10 minutes later, in Hindi; skipped families recorded with the reason", async () => {
    const r = await q([
      { studentId: S.Asha, status: "absent" },
      { studentId: S.Bhanu, status: "present" },
      { studentId: S.Chetan, status: "late" },
      { studentId: S.Deepa, status: "absent" },
    ]);
    assert.deepEqual(r.queued, { absent: 1, present: 1, late: 0, leave: 0 });
    assert.equal(r.unreachable, 2);
    const all = await rows();
    const queued = all.filter((m) => m.status === "queued");
    assert.equal(queued.length, 2);
    const asha = queued.find((m) => m.studentId === S.Asha)!;
    assert.equal(asha.kind, "attendance_absent");
    assert.equal(asha.lang, "hi");
    assert.equal(asha.toMobile, "9876500001");
    assert.match(asha.body, /^आर्यवर्त पब्लिक स्कूल: Asha Kumar \(IV-A\) की .* की उपस्थिति: अनुपस्थित।$/);
    // The school's name is fixed text of its own templates, not a variable.
    assert.deepEqual(asha.vars.slice(0, 2), ["Asha Kumar", "IV-A"]);
    assert.equal(asha.vars.length, 4);
    assert.equal(Math.round((asha.sendAfter.getTime() - now.getTime()) / 1000), 600);
    const skipped = all.filter((m) => m.status === "skipped");
    assert.deepEqual(skipped.map((m) => m.error).sort(), [outbox.SKIP_REASONS.noMobile, outbox.SKIP_REASONS.optedOut].sort());
  });

  test("a correction within the delay replaces the queued message (one message, the new mark)", async () => {
    await q([{ studentId: S.Asha, status: "absent" }]);
    await q([{ studentId: S.Asha, status: "late" }], at(now, 3));
    const mine = await rows(eq(smsMessages.studentId, S.Asha));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, "queued");
    assert.equal(mine[0].kind, "attendance_late");
    assert.match(mine[0].body, /देर से/);
    assert.equal(mine[0].sendAfter.getTime(), at(now, 13).getTime(), "the delay starts again");
  });

  test("a queued message whose new mark's messages are off is withdrawn", async () => {
    await setSms((s) => (s.events.attendance_present = false));
    await q([{ studentId: S.Asha, status: "absent" }]);
    const r = await q([{ studentId: S.Asha, status: "present" }], at(now, 2));
    assert.equal(r.withdrawn, 1);
    const mine = await rows(eq(smsMessages.studentId, S.Asha));
    assert.deepEqual(
      mine.map((m) => m.status),
      ["cancelled"],
    );
  });

  test("after the family was told, a change sends a correction (even if that mark's messages are off); changing back withdraws it", async () => {
    await setSms((s) => (s.events.attendance_present = false));
    await q([{ studentId: S.Asha, status: "absent" }]);
    await worker.sendDueMessages(at(now, 11));
    let mine = await rows(eq(smsMessages.studentId, S.Asha));
    assert.equal(mine[0].status, "sent");
    assert.equal(mine[0].provider, "log", "test mode on a development machine");

    const r = await q([{ studentId: S.Asha, status: "present" }], at(now, 20));
    assert.equal(r.corrections, 1);
    mine = await rows(eq(smsMessages.studentId, S.Asha));
    const corr = mine.find((m) => m.status === "queued")!;
    assert.equal(corr.kind, "attendance_correction");
    assert.match(corr.body, /सुधार - Asha Kumar \(IV-A\) की .* की उपस्थिति उपस्थित है, अनुपस्थित नहीं।$/);

    await q([{ studentId: S.Asha, status: "absent" }], at(now, 22));
    mine = await rows(eq(smsMessages.studentId, S.Asha));
    assert.deepEqual(mine.map((m) => m.status).sort(), ["cancelled", "sent"]);
  });

  test("only today's and yesterday's registers send messages", async () => {
    let r = await q([{ studentId: S.Asha, status: "absent" }], now, addDays(today, -2));
    assert.equal(r.queued.absent, 0);
    r = await q([{ studentId: S.Asha, status: "absent" }], now, addDays(today, -1));
    assert.equal(r.queued.absent, 1);
    assert.equal((await rows()).length, 1);
  });

  test("the second mobile gets its own message when the school sends to both", async () => {
    await setSms((s) => (s.alsoSecondMobile = true));
    await q([{ studentId: S.Bhanu, status: "leave" }]);
    const mine = await rows(eq(smsMessages.studentId, S.Bhanu));
    assert.deepEqual(mine.map((m) => m.toMobile).sort(), ["9111111102", "9876500002"]);
  });

  test("saving a register queues in the same transaction; a rolled-back save queues nothing", async () => {
    const marks = [
      { studentId: S.Asha, status: "absent" as const },
      { studentId: S.Bhanu, status: "present" as const },
      { studentId: S.Chetan, status: "present" as const },
      { studentId: S.Deepa, status: "present" as const },
      { studentId: S.Esha, status: "present" as const },
    ];
    await assert.rejects(
      db.transaction(async (tx) => {
        await saveRegister(tx, { schoolId: SCHOOL, sectionId: secA, date: today, marks }, writer());
        throw new Error("roll back");
      }),
      /roll back/,
    );
    assert.equal((await rows()).length, 0);
    const res = await db.transaction((tx) => saveRegister(tx, { schoolId: SCHOOL, sectionId: secA, date: today, marks }, writer()));
    assert.equal(res.sms.queued.absent, 1);
    // Asha and Esha share a mobile but are different children: two messages.
    assert.equal(res.sms.queued.present, 2);
    assert.equal((await rows()).filter((m) => m.status === "queued").length, 3);
    await db.delete(schema.attendance);
    await db.delete(schema.attendanceRegisters);
  });
});

describe("notices", () => {
  beforeEach(resetSms);
  const content = (extra: Partial<{ publishOn: string }> = {}) => ({
    category: "general" as const,
    titleEn: "Parent-teacher meeting on Saturday",
    bodyEn: "Please come at 10 am.",
    titleHi: "शनिवार को अभिभावक-शिक्षक बैठक",
    bodyHi: "कृपया सुबह 10 बजे आएँ।",
    publishOn: extra.publishOn ?? todayIST(),
    expiresOn: null,
  });

  test("a class notice reaches only that class's families — one message per mobile — with its title", async () => {
    const saved = await db.transaction((tx) => createClassNotice(tx, { schoolId: SCHOOL, sectionId: secA, ...content() }, writer()));
    assert.equal(saved.sms?.queued, 2, "Asha+Esha share one mobile; Bhanu");
    const all = await rows();
    const queued = all.filter((m) => m.status === "queued");
    assert.deepEqual(queued.map((m) => m.toMobile).sort(), ["9876500001", "9876500002"]);
    assert.ok(queued.every((m) => m.kind === "notice_class" && m.body.includes('"शनिवार को अभिभावक-शिक्षक बैठक"') && m.body.endsWith("portal.aesri.org")));
    assert.ok(!all.some((m) => m.studentId === S.Farhan || m.studentId === S.Gita), "nobody from IV-B");
    assert.deepEqual(all.filter((m) => m.status === "skipped").map((m) => m.error).sort(), [outbox.SKIP_REASONS.noMobile, outbox.SKIP_REASONS.optedOut].sort());
  });

  test("a notice to chosen students reaches only their families, and only they see it", async () => {
    const saved = await db.transaction((tx) => createClassNotice(tx, { schoolId: SCHOOL, sectionId: secA, studentIds: [S.Bhanu], ...content() }, writer()));
    const all = await rows();
    assert.deepEqual(all.map((m) => [m.studentId, m.kind]), [[S.Bhanu, "notice_students"]]);
    const seen = await activeNoticesForFamily(S.Bhanu, SCHOOL, secA, todayIST());
    assert.ok(seen.some((n) => n.id === saved.id && n.audience === "students" && n.recipientCount === 1));
    const notSeen = await activeNoticesForFamily(S.Asha, SCHOOL, secA, todayIST());
    assert.ok(!notSeen.some((n) => n.id === saved.id));
  });

  test("chosen students must be current students on the chosen class's roll", async () => {
    await assert.rejects(
      db.transaction((tx) => createClassNotice(tx, { schoolId: SCHOOL, sectionId: secA, studentIds: [S.Farhan], ...content() }, writer())),
      /not in IV-A/,
    );
    await assert.rejects(
      db.transaction((tx) => createOfficeNotice(tx, { schoolId: SCHOOL, target: { audience: "students", sectionId: secB, studentIds: [S.Gita] }, publish: true, ...content() }, office())),
      /not in IV-B/,
    );
    assert.equal((await rows()).length, 0);
  });

  test("whole school: every current family; staff: current staff with portal access and a mobile", async () => {
    await db.transaction((tx) => createOfficeNotice(tx, { schoolId: SCHOOL, target: { audience: "school" }, publish: true, ...content() }, office()));
    const all = await rows();
    const to = all.filter((m) => m.status === "queued").map((m) => m.toMobile).sort();
    assert.deepEqual(to, ["9222222201", "9876500001", "9876500002"]);
    assert.ok(!all.some((m) => m.studentId === S.Gita), "a student who left gets nothing");
    await resetSms();
    await db.transaction((tx) => createOfficeNotice(tx, { schoolId: SCHOOL, target: { audience: "staff" }, publish: true, ...content() }, office()));
    const st = await rows();
    assert.deepEqual(st.filter((m) => m.status === "queued").map((m) => m.toMobile), ["9000000003"]);
    assert.deepEqual(st.filter((m) => m.status === "skipped").map((m) => m.error), [outbox.SKIP_REASONS.staffNoMobile]);
  });

  test("a notice for a later date isn't sent today; on its day the sender queues it once", async () => {
    const tomorrow = addDays(todayIST(), 1);
    const saved = await db.transaction((tx) => createOfficeNotice(tx, { schoolId: SCHOOL, target: { audience: "section", sectionId: secB }, publish: true, ...content({ publishOn: tomorrow }) }, office()));
    assert.equal(saved.sms, null);
    assert.equal(await worker.queueScheduledNotices(new Date()), 0);
    assert.equal((await rows()).length, 0);
    const onTheDay = new Date(`${tomorrow}T07:30:00+05:30`);
    assert.equal(await worker.queueScheduledNotices(onTheDay), 1);
    assert.equal(await worker.queueScheduledNotices(onTheDay), 0, "not twice");
    await worker.sendDueMessages(onTheDay);
    assert.equal(await worker.queueScheduledNotices(at(onTheDay, 60)), 0, "not again after it was sent");
    const all = await rows();
    assert.deepEqual(all.map((m) => [m.toMobile, m.status]), [["9222222201", "sent"]]);
  });

  test("archiving withdraws messages that haven't gone", async () => {
    const saved = await db.transaction((tx) => createClassNotice(tx, { schoolId: SCHOOL, sectionId: secA, ...content() }, writer()));
    await db.transaction((tx) => archiveNotice(tx, SCHOOL, saved.id, writer()));
    assert.ok((await rows()).every((m) => m.status !== "queued"));
  });

  test("switched off: nothing is queued", async () => {
    await setSms((s) => (s.events.notice_class = false));
    await db.transaction((tx) => createClassNotice(tx, { schoolId: SCHOOL, sectionId: secA, ...content() }, writer()));
    assert.equal((await rows()).length, 0);
  });
});

describe("remarks, results, fees and homework", () => {
  beforeEach(resetSms);

  test("a remark shared with the family: one message after a few minutes, never the remark itself; made staff-only in time, withdrawn", async () => {
    const r = await db.transaction((tx) =>
      createRemark(tx, { schoolId: SCHOOL, studentId: S.Asha, recordedOn: todayIST(), kind: "concern", category: "behaviour", note: "Private words about a fight.", actionTaken: null, visibleToGuardian: true }, writer()),
    );
    assert.equal(r.sms?.queued, 1);
    let mine = await rows(eq(smsMessages.studentId, S.Asha));
    assert.equal(mine.length, 1);
    assert.ok(mine[0].body.includes("चिंता") && !mine[0].body.includes("fight"));
    assert.equal(Math.round((mine[0].sendAfter.getTime() - mine[0].createdAt.getTime()) / 60_000), 3);
    const reader = { accountId: teacherAccount, sessionId: SESSION, wholeSchool: true, classTeacherOf: [] };
    const fields = { kind: "concern" as const, category: "behaviour" as const, note: "Private words about a fight.", actionTaken: null, visibleToGuardian: false };
    await db.transaction((tx) => updateRemark(tx, SCHOOL, reader, r.id, fields, writer()));
    mine = await rows(eq(smsMessages.studentId, S.Asha));
    assert.deepEqual(mine.map((m) => m.status), ["cancelled"]);
    // Shared again, sent, then shared again after another round: still one message sent in all.
    await db.transaction((tx) => updateRemark(tx, SCHOOL, reader, r.id, { ...fields, visibleToGuardian: true }, writer()));
    await worker.sendDueMessages(at(new Date(), 5));
    await db.transaction((tx) => updateRemark(tx, SCHOOL, reader, r.id, { ...fields, visibleToGuardian: false }, writer()));
    await db.transaction((tx) => updateRemark(tx, SCHOOL, reader, r.id, { ...fields, visibleToGuardian: true }, writer()));
    mine = await rows(eq(smsMessages.studentId, S.Asha));
    assert.equal(mine.filter((m) => m.status === "sent").length, 1);
    assert.equal(mine.filter((m) => m.status === "queued").length, 0);
  });

  test("results: once per exam per family, withdrawn if reopened before they go", async () => {
    const input = { schoolId: SCHOOL, examId: "11111111-1111-1111-1111-111111111111", examName: "Half-yearly", sectionId: secA, sectionLabel: "IV-A", createdBy: teacherAccount };
    let r = await db.transaction((tx) => outbox.queueResults(tx, input));
    assert.equal(r.queued, 3, "Asha, Bhanu, Esha (each about their own child)");
    await db.transaction((tx) => outbox.withdrawResults(tx, { examId: input.examId, sectionId: secA }));
    r = await db.transaction((tx) => outbox.queueResults(tx, input));
    assert.equal(r.queued, 3);
    await worker.sendDueMessages(at(new Date(), 1));
    r = await db.transaction((tx) => outbox.queueResults(tx, input));
    assert.equal(r.queued, 0, "published again: not sent twice");
    const sent = await rows(eq(smsMessages.status, "sent"));
    assert.ok(sent.some((m) => m.body.includes("Asha Kumar (IV-A) का Half-yearly परिणाम पोर्टल पर है")));
  });

  test("fees: the receipt message waits 2 minutes; a cancelled receipt withdraws it, or tells the family if it went", async () => {
    const pay = (id: string) => db.transaction((tx) => outbox.queuePayment(tx, { schoolId: SCHOOL, paymentId: id, studentId: S.Bhanu, amount: 5_000_00, paidOn: todayIST(), receiptNo: "ARY/26-27/00012", method: "cash", createdBy: teacherAccount }));
    const cancel = (id: string) => db.transaction((tx) => outbox.queuePaymentCancelled(tx, { schoolId: SCHOOL, paymentId: id, studentId: S.Bhanu, amount: 5_000_00, receiptNo: "ARY/26-27/00012", createdBy: teacherAccount }));
    const p1 = "22222222-2222-2222-2222-222222222221";
    assert.equal((await pay(p1)).queued, 1);
    assert.deepEqual(await cancel(p1), { withdrawn: 1, queued: 0 });
    const p2 = "22222222-2222-2222-2222-222222222222";
    await pay(p2);
    await worker.sendDueMessages(at(new Date(), 3));
    assert.deepEqual(await cancel(p2), { withdrawn: 0, queued: 1 });
    const all = await rows(eq(smsMessages.relatedId, p2));
    assert.deepEqual(all.map((m) => [m.template, m.status]), [["payment", "sent"], ["payment_cancelled", "queued"]]);
    assert.match(all[0].body, /रु\. 5,000 प्राप्त हुए, रसीद ARY\/26-27\/00012।/);
    // Opening balances never send anything.
    assert.equal((await db.transaction((tx) => outbox.queuePayment(tx, { schoolId: SCHOOL, paymentId: "22222222-2222-2222-2222-222222222223", studentId: S.Bhanu, amount: 1, paidOn: todayIST(), receiptNo: "ARY/26-27/OB00001", method: "opening", createdBy: null }))).queued, 0);
  });

  test("homework summary: after the school's time, once per class per day, with the subjects", async () => {
    const today = todayIST();
    const [hin] = await db.select({ id: subjects.id }).from(subjects).limit(1);
    await db.insert(homework).values([
      { sectionId: secA, subjectId: null, title: "Read chapter 3", assignedOn: today, dueOn: today, createdBy: teacherAccount },
      { sectionId: secA, subjectId: hin?.id ?? null, title: "Exercise 4", assignedOn: today, dueOn: today, createdBy: teacherAccount },
    ]);
    try {
      assert.equal(await worker.queueHomeworkDigests(new Date(`${today}T16:00:00+05:30`)), 0, "not before 16:30");
      assert.equal(await worker.queueHomeworkDigests(new Date(`${today}T16:31:00+05:30`)), 2);
      assert.equal(await worker.queueHomeworkDigests(new Date(`${today}T17:00:00+05:30`)), 0, "once a day");
      const all = await rows(eq(smsMessages.kind, "homework_digest"));
      assert.ok(all.filter((m) => m.status === "queued").every((m) => m.body.includes("IV-A का") && m.body.includes("सामान्य")));
      assert.ok(!all.some((m) => m.studentId === S.Farhan), "IV-B had no homework");
    } finally {
      await db.delete(homework);
    }
  });
});

describe("the sender", () => {
  beforeEach(resetSms);
  const queueOne = () =>
    db.transaction((tx) => outbox.queueAttendance(tx, { schoolId: SCHOOL, date: todayIST(), sectionLabel: "IV-A", changes: [{ studentId: S.Asha, status: "absent" }], createdBy: null }, new Date(Date.now() - 20 * MIN)));

  test("waits during the school's quiet time (test messages don't)", async () => {
    await queueOne();
    const id = await db.transaction((tx) => outbox.queueTest(tx, { schoolId: SCHOOL, toMobile: "9876543210", createdBy: null }));
    await setSms((s) => (s.quietHours = { from: "00:00", to: "23:59" }));
    const t = await worker.sendDueMessages(new Date());
    assert.equal(t.sent, 1);
    const [test] = await rows(eq(smsMessages.id, id));
    assert.equal(test.status, "sent");
    assert.equal((await rows(eq(smsMessages.studentId, S.Asha)))[0].status, "queued");
  });

  test("settings are checked again when sending: switched off → cancelled; the family opted out → skipped", async () => {
    await queueOne();
    await setSms((s) => (s.events.attendance_absent = false));
    await worker.sendDueMessages(new Date());
    let [m] = await rows(eq(smsMessages.studentId, S.Asha));
    assert.equal(m.status, "cancelled");
    assert.match(m.error ?? "", /switched off in Settings/);

    await resetSms();
    await queueOne();
    await db.update(students).set({ smsOff: true }).where(eq(students.id, S.Asha));
    try {
      await worker.sendDueMessages(new Date());
      [m] = await rows(eq(smsMessages.studentId, S.Asha));
      assert.equal(m.status, "skipped");
      assert.equal(m.error, outbox.SKIP_REASONS.optedOut);
    } finally {
      await db.update(students).set({ smsOff: false }).where(eq(students.id, S.Asha));
    }
  });

  test("a production server without an SMS company records messages as skipped, never sent", async () => {
    await queueOne();
    const was = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      await worker.sendDueMessages(new Date());
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = was;
    }
    const [m] = await rows(eq(smsMessages.studentId, S.Asha));
    assert.equal(m.status, "skipped");
    assert.match(m.error ?? "", /SMS isn’t set up yet/);
  });

  test("with an SMS company: a template without an ID for the school is skipped; with one it is sent; failures are tried again, then marked failed", async () => {
    const realFetch = globalThis.fetch;
    let answer: () => Response = () => new Response(JSON.stringify({ type: "success", message: "req-1" }));
    const calls: { body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return answer();
    }) as typeof fetch;
    process.env.SMS_PROVIDER = "msg91";
    process.env.MSG91_AUTH_KEY = "k";
    try {
      await queueOne();
      await worker.sendDueMessages(new Date());
      let [m] = await rows(eq(smsMessages.studentId, S.Asha));
      assert.equal(m.status, "skipped");
      assert.match(m.error ?? "", /Template not set up: “Attendance” in Hindi has no MSG91 template ID for this school/);
      assert.equal(calls.length, 0);

      // The other school's template ID is not this school's (each registers its own, with its own name).
      const actor = { accountId: null, loginId: "test" };
      await db.transaction((tx) => settingsMod.saveTemplateIds(tx, "msg91", { id: "aadharshila", name: "Aadharshila Public School" }, { "attendance.hi": "tpl-aad-att-hi" }, actor));
      await resetSms();
      await queueOne();
      await worker.sendDueMessages(new Date());
      [m] = await rows(eq(smsMessages.studentId, S.Asha));
      assert.equal(m.status, "skipped");
      assert.equal(calls.length, 0);

      const changed = await db.transaction((tx) => settingsMod.saveTemplateIds(tx, "msg91", { id: SCHOOL, name: "Aryavart Public School" }, { "attendance.hi": "tpl-att-hi" }, actor));
      assert.deepEqual(changed, ["attendance.hi"]);
      const ids = await settingsMod.loadTemplateIds(db);
      assert.equal(settingsMod.templateIdFor(ids, "msg91", "aadharshila", "attendance", "hi"), "tpl-aad-att-hi", "saving one school keeps the other's");
      const [log] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "sms.templates_updated")).orderBy(sql`id desc`).limit(1);
      assert.deepEqual(log.details, { provider: "msg91", school: SCHOOL, schoolName: "Aryavart Public School", changed: ["attendance.hi"] });
      await resetSms();
      await queueOne();
      await worker.sendDueMessages(new Date());
      [m] = await rows(eq(smsMessages.studentId, S.Asha));
      assert.equal(m.status, "sent");
      assert.equal(m.provider, "msg91");
      assert.equal(m.providerRef, "req-1");
      assert.equal(calls[0].body.template_id, "tpl-att-hi");
      assert.deepEqual((calls[0].body.recipients as Record<string, string>[])[0], { mobiles: "919876500001", var1: "Asha Kumar", var2: "IV-A", var3: m.vars[2], var4: "अनुपस्थित" });

      await resetSms();
      answer = () => new Response(JSON.stringify({ type: "error", message: "Insufficient balance" }), { status: 400 });
      await queueOne();
      let now = new Date();
      for (let attempt = 1; attempt <= worker.MAX_ATTEMPTS; attempt++) {
        await worker.sendDueMessages(now);
        [m] = await rows(eq(smsMessages.studentId, S.Asha));
        assert.equal(m.attempts, attempt);
        if (attempt < worker.MAX_ATTEMPTS) {
          assert.equal(m.status, "queued", `try ${attempt}: will try again`);
          assert.equal(Math.round((m.sendAfter.getTime() - now.getTime()) / MIN), worker.RETRY_MINUTES[attempt - 1]);
          now = at(m.sendAfter, 0.1);
        }
      }
      assert.equal(m.status, "failed");
      assert.match(m.error ?? "", /MSG91: Insufficient balance \(tried 4 times\)/);

      // The office tries it again: it is queued once more.
      answer = () => new Response(JSON.stringify({ type: "success", message: "req-2" }));
      const n = await db.transaction((tx) => outbox.retryFailed(tx, { schoolId: SCHOOL, ids: "all" }, { accountId: null, loginId: "test" }));
      assert.equal(n, 1);
      await worker.sendDueMessages(new Date());
      [m] = await rows(eq(smsMessages.studentId, S.Asha));
      assert.equal(m.status, "sent");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SMS_PROVIDER;
      delete process.env.MSG91_AUTH_KEY;
      await db.delete(appSettings);
    }
  });

  test("Fast2SMS: each school's messages go under its own sender ID; a school without one is not sent", async () => {
    const realFetch = globalThis.fetch;
    const calls: { body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ return: true, request_id: "f2s-1" }));
    }) as typeof fetch;
    process.env.SMS_PROVIDER = "fast2sms";
    process.env.FAST2SMS_API_KEY = "k";
    process.env.SMS_SENDER_ID = "aadharshila:AADHPS";
    try {
      await db.transaction((tx) => settingsMod.saveTemplateIds(tx, "fast2sms", { id: SCHOOL, name: "Aryavart Public School" }, { "attendance.hi": "171234" }, { accountId: null, loginId: "test" }));
      await queueOne();
      await worker.sendDueMessages(new Date());
      let [m] = await rows(eq(smsMessages.studentId, S.Asha));
      assert.equal(m.status, "skipped");
      assert.match(m.error ?? "", /no sender ID \(SMS_SENDER_ID\) for this school/);
      assert.equal(calls.length, 0);

      process.env.SMS_SENDER_ID = "aryavart:ARYAPS, aadharshila:AADHPS";
      await resetSms();
      await queueOne();
      await worker.sendDueMessages(new Date());
      [m] = await rows(eq(smsMessages.studentId, S.Asha));
      assert.equal(m.status, "sent");
      assert.equal(m.providerRef, "f2s-1");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.sender_id, "ARYAPS");
      assert.equal(calls[0].body.message, "171234");
      assert.equal(calls[0].body.variables_values, m.vars.join("|"));
      assert.equal(calls[0].body.numbers, "9876500001");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SMS_PROVIDER;
      delete process.env.FAST2SMS_API_KEY;
      delete process.env.SMS_SENDER_ID;
      await db.delete(appSettings);
    }
  });

  test("the family's opt-out is audited and withdraws what is waiting", async () => {
    await queueOne();
    const r = await db.transaction((tx) => outbox.setFamilySmsOff(tx, { schoolId: SCHOOL, studentId: S.Asha, off: true }, { accountId: teacherAccount, loginId: "AryaE1" }));
    assert.deepEqual(r, { changed: true, withdrawn: 1 });
    const [log] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "sms.family_off"));
    assert.equal(log.targetId, S.Asha);
    await db.transaction((tx) => outbox.setFamilySmsOff(tx, { schoolId: SCHOOL, studentId: S.Asha, off: false }, { accountId: teacherAccount, loginId: "AryaE1" }));
  });

  test("the office can cancel a waiting message; it is audited", async () => {
    await queueOne();
    const [m] = await rows(eq(smsMessages.studentId, S.Asha));
    const n = await db.transaction((tx) => outbox.cancelQueued(tx, { schoolId: "aadharshila", ids: [m.id] }, { accountId: null, loginId: "x" }));
    assert.equal(n, 0, "never another school's message");
    assert.equal(await db.transaction((tx) => outbox.cancelQueued(tx, { schoolId: SCHOOL, ids: [m.id] }, { accountId: null, loginId: "x" })), 1);
    const [after] = await rows(eq(smsMessages.id, m.id));
    assert.equal(after.status, "cancelled");
  });

  test("after 180 days a message keeps only what counts need", async () => {
    await queueOne();
    await worker.sendDueMessages(new Date());
    await db.update(smsMessages).set({ createdAt: new Date(Date.now() - 181 * 86_400_000) });
    assert.equal(await worker.purgeOldMessages(new Date()), 1);
    const [m] = await rows();
    assert.equal(m.body, "");
    assert.deepEqual(m.vars, []);
    assert.equal(m.toMobile, "98•••••01");
    assert.equal(m.status, "sent");
    assert.equal(await worker.purgeOldMessages(new Date()), 0);
  });

  test("a whole pass runs every step and never throws", async () => {
    const t = await worker.runSmsPass(new Date(), { purge: true });
    assert.equal(typeof t.sent, "number");
  });
});

test("nothing is queued inside withoutSms (the demo's history)", async () => {
  await resetSms();
  await outbox.withoutSms(() =>
    db.transaction((tx) => outbox.queueAttendance(tx, { schoolId: SCHOOL, date: todayIST(), sectionLabel: "IV-A", changes: [{ studentId: S.Asha, status: "absent" }], createdBy: null })),
  );
  assert.equal((await db.select().from(smsMessages).where(inArray(smsMessages.studentId, [S.Asha]))).length, 0);
});

test("a whole-school notice to more families than one INSERT can hold queues every message (kept last: it adds 4,200 families)", async () => {
  await resetSms();
  const FAMILIES = 4_200; // × 16 values a message is over PostgreSQL's 65,535 parameters for one statement
  await db.transaction(async (tx) => {
    for (let i = 0; i < FAMILIES; i += 500) {
      const batch = Array.from({ length: Math.min(500, FAMILIES - i) }, (_, k) => i + k);
      const made = await tx
        .insert(students)
        .values(batch.map((n) => ({ schoolId: SCHOOL, srNo: `L${n}`, name: `Large ${n}`, guardianMobile: `97${String(n).padStart(8, "0")}` })))
        .returning({ id: students.id });
      await tx.insert(enrolments).values(made.map((s, k) => ({ studentId: s.id, sessionId: SESSION, sectionId: secB, rollNo: 100 + batch[k] })));
    }
  });
  const notice = {
    category: "general" as const,
    titleEn: "School closed tomorrow",
    bodyEn: "Heavy rain is expected.",
    titleHi: "कल विद्यालय बंद रहेगा",
    bodyHi: "भारी बारिश की संभावना है।",
    publishOn: todayIST(),
    expiresOn: null,
  };
  await db.transaction((tx) => createOfficeNotice(tx, { schoolId: SCHOOL, target: { audience: "school" }, publish: true, ...notice }, office()));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(smsMessages).where(and(eq(smsMessages.status, "queued"), sql`${smsMessages.toMobile} like '97%'`));
  assert.equal(n, FAMILIES);
});
