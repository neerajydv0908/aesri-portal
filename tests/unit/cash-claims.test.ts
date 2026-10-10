/**
 * Cash payments a family records on the portal (lib/services/cash-claims.ts),
 * against a real (embedded) PostgreSQL: what may be recorded, that nothing is
 * paid until the principal or an office admin approves, that approving makes
 * a cash receipt (admission fee first, then tuition, oldest first) and
 * declining texts the family, and that a record is decided only once. The
 * SMS companies are never called.
 *
 *   node --import tsx --test tests/unit/cash-claims.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-cash-test-"));
process.env.PGLITE_DIR = dir;
delete process.env.DATABASE_URL;
delete process.env.SMS_PROVIDER;
process.env.APP_URL = "https://portal.aesri.org";

import { closeDb, getDb } from "../../lib/db/client";
import * as schema from "../../lib/db/schema";
import { seedReferenceData } from "../../lib/services/reference";
import { addAdmissionCharge, ensureSessionCharges, familyPayable, ledger, pendingCashFor, recordPayment, reversePayment } from "../../lib/services/fees";
import { approveCashClaim, claimChecks, ClaimError, declineCashClaim, familyClaims, recordCashClaim, waitingClaimCount, waitingClaims, withdrawCashClaim } from "../../lib/services/cash-claims";
import { addDays, todayIST } from "../../lib/dates";

const { students, enrolments, sections, classes, accounts, cashClaims, payments, paymentAllocations, paymentOrders, smsMessages, studentCharges } = schema;
const SCHOOL = "aryavart";
const SESSION = "2026-27";
const r = (rupees: number) => rupees * 100;

let db: Awaited<ReturnType<typeof getDb>>;
let studentId: string;
let familyAcc: string;
let officeAcc: string;
const family = () => ({ accountId: familyAcc, loginId: "arya7660", ip: null });
const office = () => ({ accountId: officeAcc, loginId: "aryae1", ip: null });

before(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedReferenceData(tx);
    const [cls] = await tx.select({ id: classes.id }).from(classes).where(and(eq(classes.schoolId, SCHOOL), eq(classes.name, "X")));
    const [sec] = await tx.select({ id: sections.id }).from(sections).where(and(eq(sections.classId, cls.id), eq(sections.name, "A")));
    const [s] = await tx
      .insert(students)
      .values({ schoolId: SCHOOL, srNo: "7660", name: "Nikhil Swami", guardianMobile: "9876500001", admittedOn: todayIST() })
      .returning({ id: students.id });
    studentId = s.id;
    await tx.insert(enrolments).values({ studentId, sessionId: SESSION, sectionId: sec.id, rollNo: 1 });
    const [fa] = await tx.insert(accounts).values({ loginId: "arya7660", role: "student", schoolId: SCHOOL, studentId, status: "active" }).returning({ id: accounts.id });
    familyAcc = fa.id;
    const [oa] = await tx.insert(accounts).values({ loginId: "aesri.test", role: "super_admin", displayName: "Test Admin", status: "active" }).returning({ id: accounts.id });
    officeAcc = oa.id;
    await ensureSessionCharges(tx, studentId, SESSION, office());
    await addAdmissionCharge(tx, studentId, SESSION, office());
  });
});

after(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const record = (choice: { admission: boolean; tuition: number }, paidOn = todayIST(), note: string | null = null) =>
  db.transaction((tx) => recordCashClaim(tx, { schoolId: SCHOOL, studentId, sessionId: SESSION, choice, paidOn, note }, family()));
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ClaimError) return err.code;
    throw err;
  }
  return "ok";
};

test("the admission fee is charged once: adding it again does nothing", async () => {
  await db.transaction((tx) => addAdmissionCharge(tx, studentId, SESSION, office()));
  const lines = await db.select().from(studentCharges).where(and(eq(studentCharges.studentId, studentId), eq(studentCharges.kind, "admission")));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].amount, r(2000));
});

test("a family records cash within the rules: at least ₹1,000 of tuition, a date in this session, not in the future", async () => {
  assert.equal(await code(record({ admission: false, tuition: r(500) })), "tuition_small");
  assert.equal(await code(record({ admission: false, tuition: r(18001) })), "tuition_large");
  assert.equal(await code(record({ admission: false, tuition: 0 })), "nothing");
  assert.equal(await code(record({ admission: false, tuition: r(1000) }, addDays(todayIST(), 1))), "date");
  assert.equal(await code(record({ admission: false, tuition: r(1000) }, "2026-03-31")), "date");
  assert.equal(await waitingClaimCount(db, SCHOOL), 0);
});

let first: string;
test("recording changes no money, and the same record sent twice is kept once", async () => {
  const a = await record({ admission: true, tuition: r(5000) }, todayIST(), "to the class teacher");
  assert.equal(a.amount, r(7000));
  assert.equal(a.repeated, false);
  first = a.id;
  const again = await record({ admission: true, tuition: r(5000) }, todayIST(), "to the class teacher");
  assert.equal(again.repeated, true);
  assert.equal(again.id, first);
  const { totals } = await ledger(db, studentId, SESSION);
  assert.equal(totals.paid, 0);
  assert.equal(await waitingClaimCount(db, SCHOOL), 1);
  // What is waiting isn't offered again.
  const p = familyPayable((await ledger(db, studentId, SESSION)).lines, await pendingCashFor(db, studentId, SESSION), todayIST());
  assert.equal(p.admission, null);
  assert.equal(p.tuition?.max, r(13000));
  assert.equal(await code(record({ admission: true, tuition: 0 })), "admission_gone");
});

test("approving makes a cash receipt: the admission fee first, then the oldest tuition", async () => {
  const done = await db.transaction((tx) => approveCashClaim(tx, { claimId: first, schoolId: SCHOOL }, office()));
  assert.equal(done.amount, r(7000));
  assert.match(done.receiptNo, /^ARY\/26-27\/\d{5}$/);
  const [p] = await db.select().from(payments).where(eq(payments.id, done.paymentId));
  assert.equal(p.method, "cash");
  assert.equal(p.amount, r(7000));
  assert.equal(p.paidOn, todayIST());
  assert.equal(p.recordedBy, officeAcc);
  const split = await db
    .select({ kind: studentCharges.kind, label: studentCharges.label, amount: paymentAllocations.amount })
    .from(paymentAllocations)
    .innerJoin(studentCharges, eq(studentCharges.id, paymentAllocations.chargeId))
    .where(eq(paymentAllocations.paymentId, p.id));
  assert.deepEqual(split.map((x) => [x.kind, x.amount]).sort(), [
    ["admission", r(2000)],
    ["instalment", r(5000)],
  ]);
  assert.ok(split.some((x) => x.kind === "instalment" && x.label.startsWith("Term I —")));
  const [c] = await db.select().from(cashClaims).where(eq(cashClaims.id, first));
  assert.equal(c.status, "approved");
  assert.equal(c.paymentId, p.id);
  // The family gets the usual "fee received" message.
  const sms = await db.select().from(smsMessages).where(and(eq(smsMessages.relatedType, "payment"), eq(smsMessages.relatedId, p.id)));
  assert.equal(sms.length, 1);
  assert.equal(sms[0].template, "payment");
  // Decided once only.
  assert.equal(await code(db.transaction((tx) => approveCashClaim(tx, { claimId: first, schoolId: SCHOOL }, office()))), "decided");
  assert.equal(await code(db.transaction((tx) => declineCashClaim(tx, { claimId: first, schoolId: SCHOOL, reason: null }, office()))), "decided");
  assert.equal(await waitingClaimCount(db, SCHOOL), 0);
});

test("declining pays nothing and texts the family to contact the school; the family sees the reason", async () => {
  const a = await record({ admission: false, tuition: r(3000) }, addDays(todayIST(), -2));
  const done = await db.transaction((tx) => declineCashClaim(tx, { claimId: a.id, schoolId: SCHOOL, reason: "No cash was received that day." }, office()));
  assert.equal(done.sms.queued, 1);
  const [m] = await db.select().from(smsMessages).where(and(eq(smsMessages.relatedType, "cash_claim"), eq(smsMessages.relatedId, a.id)));
  assert.equal(m.template, "cash_declined");
  assert.equal(m.kind, "cash_declined");
  assert.equal(m.toMobile, "9876500001");
  assert.match(m.body, /^आर्यवर्त पब्लिक स्कूल: Nikhil Swami के लिए दर्ज किया गया रु\. 3,000 का नकद भुगतान विद्यालय ने अस्वीकार कर दिया है।/);
  const { totals } = await ledger(db, studentId, SESSION);
  assert.equal(totals.paid, r(7000));
  const seen = await familyClaims(db, studentId);
  const declined = seen.find((c) => c.id === a.id);
  assert.equal(declined?.status, "declined");
  assert.equal(declined?.declineReason, "No cash was received that day.");
});

test("a family can withdraw a record while it waits, and no more than three wait at once", async () => {
  const a = await record({ admission: false, tuition: r(1000) });
  await db.transaction((tx) => withdrawCashClaim(tx, { claimId: a.id, studentId, schoolId: SCHOOL }, family()));
  assert.equal(await code(db.transaction((tx) => approveCashClaim(tx, { claimId: a.id, schoolId: SCHOOL }, office()))), "decided");
  assert.ok(!(await familyClaims(db, studentId)).some((c) => c.id === a.id), "withdrawn records aren't listed for the family");
  const ids = [];
  for (const rupees of [1000, 1100, 1200]) ids.push((await record({ admission: false, tuition: r(rupees) })).id);
  assert.equal(await code(record({ admission: false, tuition: r(1300) })), "too_many");
  for (const id of ids) await db.transaction((tx) => withdrawCashClaim(tx, { claimId: id, studentId, schoolId: SCHOOL }, family()));
});

test("a record for money that is no longer due can't be approved (the same cash may already be on a receipt)", async () => {
  const a = await record({ admission: false, tuition: r(9000) });
  // Meanwhile the accountant takes cash at the counter for most of what was due.
  await db.transaction((tx) => recordPayment(tx, { schoolId: SCHOOL, studentId, sessionId: SESSION, amount: r(8000), method: "cash", paidOn: todayIST() }, office()));
  assert.equal(await code(db.transaction((tx) => approveCashClaim(tx, { claimId: a.id, schoolId: SCHOOL }, office()))), "too_much");
  const [c] = await db.select().from(cashClaims).where(eq(cashClaims.id, a.id));
  assert.equal(c.status, "pending");
  await db.transaction((tx) => declineCashClaim(tx, { claimId: a.id, schoolId: SCHOOL, reason: null }, office()));
});

test("no record while an online payment is in progress, and none for another school", async () => {
  const [o] = await db.insert(paymentOrders).values({ schoolId: SCHOOL, studentId, amount: r(1000), chargeIds: [], provider: "mock", createdBy: familyAcc }).returning({ id: paymentOrders.id });
  assert.equal(await code(record({ admission: false, tuition: r(1000) })), "open_order");
  await db.update(paymentOrders).set({ status: "failed" }).where(eq(paymentOrders.id, o.id));
  const a = await record({ admission: false, tuition: r(1000) });
  assert.equal(await code(db.transaction((tx) => approveCashClaim(tx, { claimId: a.id, schoolId: "aadharshila" }, office()))), "not_found");
  assert.equal(await code(db.transaction((tx) => approveCashClaim(tx, { claimId: "not-a-uuid", schoolId: SCHOOL }, office()))), "not_found");
});

test("beside a waiting record the principal sees what is due, by kind, and the receipts close to that day", async () => {
  const [w] = (await waitingClaims(db, SCHOOL)).filter((c) => c.studentId === studentId);
  assert.ok(w, "a record is waiting");
  // The accountant takes ₹1,000 at the counter the same day: it may be the same cash.
  const counter = await db.transaction((tx) => recordPayment(tx, { schoolId: SCHOOL, studentId, sessionId: SESSION, amount: r(1000), method: "cash", paidOn: todayIST() }, office()));
  const check = (await claimChecks(db, [w])).get(w.id)!;
  const open = (await ledger(db, studentId, SESSION)).lines.filter((l) => l.outstanding > 0);
  const sum = (kind: "admission" | "tuition") => open.filter((l) => (l.kind === "admission") === (kind === "admission")).reduce((a, l) => a + l.outstanding, 0);
  assert.deepEqual(check.due, { admission: sum("admission"), tuition: sum("tuition") });
  assert.ok(check.receipts.some((x) => x.id === counter.id && !x.fromFamilyRecord));
  assert.ok(check.receipts.some((x) => x.fromFamilyRecord), "the receipt of the family's earlier, approved record is shown too");
  assert.ok(check.cashReceipts >= 2);
});

test("a receipt cancelled after approval shows as cancelled on the family's record", async () => {
  const [w] = (await waitingClaims(db, SCHOOL)).filter((c) => c.studentId === studentId);
  const done = await db.transaction((tx) => approveCashClaim(tx, { claimId: w.id, schoolId: SCHOOL }, office()));
  assert.equal((await familyClaims(db, studentId)).find((c) => c.id === w.id)?.receiptStatus, "completed");
  await db.transaction((tx) => reversePayment(tx, done.paymentId, SCHOOL, "Counted twice", office()));
  assert.equal((await familyClaims(db, studentId)).find((c) => c.id === w.id)?.receiptStatus, "reversed");
});

test("the same record sent again after two minutes is a second payment, not a repeat", async () => {
  const a = await record({ admission: false, tuition: r(1000) });
  await db.update(cashClaims).set({ createdAt: new Date(Date.now() - 3 * 60_000) }).where(eq(cashClaims.id, a.id));
  const b = await record({ admission: false, tuition: r(1000) });
  assert.equal(b.repeated, false);
  assert.notEqual(b.id, a.id);
  for (const id of [a.id, b.id]) await db.transaction((tx) => withdrawCashClaim(tx, { claimId: id, studentId, schoolId: SCHOOL }, family()));
});

test("a record still waiting from the last session stays in the family's list, apart from this session's fees", async () => {
  await db.insert(schema.academicSessions).values({ id: "2025-26", startsOn: "2025-04-01", endsOn: "2026-03-31" }).onConflictDoNothing();
  const [old] = await db
    .insert(cashClaims)
    .values({ schoolId: SCHOOL, studentId, sessionId: "2025-26", amount: r(1500), admissionAmount: 0, paidOn: "2026-03-30", createdBy: familyAcc })
    .returning({ id: cashClaims.id });
  const seen = (await familyClaims(db, studentId)).find((c) => c.id === old.id);
  assert.equal(seen?.status, "pending");
  assert.equal(seen?.sessionId, "2025-26");
  assert.equal(familyPayable((await ledger(db, studentId, SESSION)).lines, await pendingCashFor(db, studentId, SESSION), todayIST()).pending.tuition, 0);
  // Its due is worked out in its own session (nothing was charged there).
  assert.deepEqual((await claimChecks(db, [(await waitingClaims(db, SCHOOL, { studentId })).find((c) => c.id === old.id)!])).get(old.id)?.due, { admission: 0, tuition: 0 });
  await db.transaction((tx) => withdrawCashClaim(tx, { claimId: old.id, studentId, schoolId: SCHOOL }, family()));
});

test("approving never moves money the family recorded as tuition onto the admission fee", async () => {
  // A second child of class X whose admission fee is still due.
  const sid = await db.transaction(async (tx) => {
    const [cls] = await tx.select({ id: classes.id }).from(classes).where(and(eq(classes.schoolId, SCHOOL), eq(classes.name, "X")));
    const [sec] = await tx.select({ id: sections.id }).from(sections).where(and(eq(sections.classId, cls.id), eq(sections.name, "A")));
    const [s] = await tx.insert(students).values({ schoolId: SCHOOL, srNo: "7661", name: "Kavita Swami", guardianMobile: "9876500002", admittedOn: todayIST() }).returning({ id: students.id });
    await tx.insert(enrolments).values({ studentId: s.id, sessionId: SESSION, sectionId: sec.id, rollNo: 2 });
    await ensureSessionCharges(tx, s.id, SESSION, office());
    await addAdmissionCharge(tx, s.id, SESSION, office());
    return s.id;
  });
  const claim = await db.transaction((tx) => recordCashClaim(tx, { schoolId: SCHOOL, studentId: sid, sessionId: SESSION, choice: { admission: false, tuition: r(5000) }, paidOn: todayIST(), note: null }, family()));
  // Meanwhile the accountant takes tuition at the counter: ₹4,000 of tuition and the ₹2,000 admission fee stay due.
  const { lines } = await ledger(db, sid, SESSION);
  const tuitionLines = lines.filter((l) => l.kind !== "admission" && l.outstanding > 0).map((l) => l.id);
  const tuitionDue = lines.filter((l) => l.kind !== "admission").reduce((a, l) => a + l.outstanding, 0);
  await db.transaction((tx) => recordPayment(tx, { schoolId: SCHOOL, studentId: sid, sessionId: SESSION, amount: tuitionDue - r(4000), method: "cash", paidOn: todayIST(), chargeIds: tuitionLines }, office()));
  assert.equal(await code(db.transaction((tx) => approveCashClaim(tx, { claimId: claim.id, schoolId: SCHOOL }, office()))), "too_much");
  const [c] = await db.select().from(cashClaims).where(eq(cashClaims.id, claim.id));
  assert.equal(c.status, "pending");
  const after = await ledger(db, sid, SESSION);
  assert.equal(after.lines.filter((l) => l.kind === "admission").reduce((a, l) => a + l.outstanding, 0), r(2000), "the admission fee is still due");
  await db.transaction((tx) => declineCashClaim(tx, { claimId: claim.id, schoolId: SCHOOL, reason: null }, office()));
});
