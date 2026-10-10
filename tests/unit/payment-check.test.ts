/**
 * The Razorpay check (lib/services/payment-check.ts) against a real (embedded)
 * PostgreSQL and a stand-in Razorpay: payments that never got a receipt are
 * found and recorded once, dated the day the family paid; authorised and
 * refunded payments are not recorded; amounts that don't match get no
 * receipt; young orders wait, older ones are asked less often; Razorpay being
 * down stops nothing; and the office's "Check with Razorpay".
 *
 *   node --import tsx --test tests/unit/payment-check.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { and, eq, like } from "drizzle-orm";
import { FAKE_KEYS, rpPayment, rpRefund, startFakeRazorpay, unix, type FakeRazorpay } from "./fixtures/fake-razorpay";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-payment-check-test-"));
process.env.PGLITE_DIR = dir;
delete process.env.DATABASE_URL;
delete process.env.SMS_PROVIDER;
process.env.APP_URL = "https://portal.aesri.org";
process.env.RAZORPAY_KEY_ID = FAKE_KEYS.keyId;
process.env.RAZORPAY_KEY_SECRET = FAKE_KEYS.keySecret;

type Db = Awaited<ReturnType<typeof import("../../lib/db/client").getDb>>;
let db: Db;
let fake: FakeRazorpay;
let m: {
  client: typeof import("../../lib/db/client");
  schema: typeof import("../../lib/db/schema");
  fees: typeof import("../../lib/services/fees");
  check: typeof import("../../lib/services/payment-check");
  reference: typeof import("../../lib/services/reference");
  dates: typeof import("../../lib/dates");
};

const SCHOOL = "aryavart";
const SESSION = "2026-27";
const MIN = 60_000;
let family: string; // an account to own the orders
let student: string;
let t1: string;
let t2: string;
let seq = 0;

/** An unfinished Razorpay order of `ageMinutes`, for Term I (₹5,000) unless said otherwise. */
async function order(ageMinutes: number, opts: { status?: "created" | "expired" | "failed"; provider?: string; amount?: number; chargeIds?: string[]; checkedAt?: Date; now?: Date } = {}) {
  const { paymentOrders } = m.schema;
  const now = opts.now ?? new Date();
  const providerOrderId = `order_TEST${String(++seq).padStart(8, "0")}`;
  const [o] = await db
    .insert(paymentOrders)
    .values({
      schoolId: SCHOOL,
      studentId: student,
      amount: opts.amount ?? 5_000_00,
      chargeIds: opts.chargeIds ?? [t1],
      provider: opts.provider ?? "razorpay",
      providerOrderId,
      status: opts.status ?? "expired",
      createdBy: family,
      createdAt: new Date(now.getTime() - ageMinutes * MIN),
      checkedAt: opts.checkedAt ?? null,
    })
    .returning();
  return o;
}

async function orderRow(id: string) {
  const { paymentOrders } = m.schema;
  const [o] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, id));
  return o;
}

const asked = (o: { providerOrderId: string | null }) => fake.requests.filter((r) => r === `GET /v1/orders/${o.providerOrderId}/payments`).length;

before(async () => {
  m = {
    client: await import("../../lib/db/client"),
    schema: await import("../../lib/db/schema"),
    fees: await import("../../lib/services/fees"),
    check: await import("../../lib/services/payment-check"),
    reference: await import("../../lib/services/reference"),
    dates: await import("../../lib/dates"),
  };
  fake = await startFakeRazorpay();
  process.env.RAZORPAY_API_URL = fake.url;
  db = await m.client.getDb();
  const { students, enrolments, sections, classes, accounts } = m.schema;
  await db.transaction(async (tx) => {
    await m.reference.seedReferenceData(tx);
    const [cls] = await tx.select({ id: classes.id }).from(classes).where(and(eq(classes.schoolId, SCHOOL), eq(classes.name, "IV")));
    const [sec] = await tx.select({ id: sections.id }).from(sections).where(and(eq(sections.classId, cls.id), eq(sections.name, "A")));
    const [s] = await tx.insert(students).values({ schoolId: SCHOOL, srNo: "9101", name: "Kavya Sharma" }).returning({ id: students.id });
    await tx.insert(enrolments).values({ studentId: s.id, sessionId: SESSION, sectionId: sec.id, rollNo: 1 });
    await m.fees.ensureSessionCharges(tx, s.id, SESSION, null);
    const [acc] = await tx.insert(accounts).values({ loginId: "arya9101", role: "student", schoolId: SCHOOL, studentId: s.id, status: "active" }).returning({ id: accounts.id });
    student = s.id;
    family = acc.id;
    const l = (await m.fees.ledger(tx, s.id, SESSION)).lines;
    [t1, t2] = [l[0].id, l[1].id];
  });
});

beforeEach(() => {
  fake.orders.clear();
  fake.refunds.clear();
  fake.failNext = 0;
});

after(async () => {
  await fake?.close();
  await m?.client.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("when to ask Razorpay", () => {
  test("every pass in an order's first hour, then hourly, then daily", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const at = (ageMin: number, checkedMinAgo: number | null) => ({ createdAt: new Date(now.getTime() - ageMin * MIN), checkedAt: checkedMinAgo === null ? null : new Date(now.getTime() - checkedMinAgo * MIN) });
    assert.equal(m.check.dueForCheck(at(20, null), now), true);
    assert.equal(m.check.dueForCheck(at(20, 5), now), false);
    assert.equal(m.check.dueForCheck(at(20, 10), now), true);
    assert.equal(m.check.dueForCheck(at(180, 30), now), false);
    assert.equal(m.check.dueForCheck(at(180, 56), now), true);
    assert.equal(m.check.dueForCheck(at(3 * 24 * 60, 12 * 60), now), false);
    assert.equal(m.check.dueForCheck(at(3 * 24 * 60, 23 * 60 + 1), now), true);
  });
});

describe("the automatic check", () => {
  test("a captured payment without a receipt is recorded once, dated the day the family paid", async () => {
    const o = await order(40, { status: "expired" });
    const paidAt = new Date(Date.now() - 30 * MIN);
    fake.orders.set(o.providerOrderId!, [rpPayment("pay_FOUND0000001", o.providerOrderId!, 5_000_00, "captured", { created_at: unix(paidAt), method: "upi" })]);
    const s = await m.check.checkUnfinishedOrders();
    assert.equal(s.recorded.length, 1);
    assert.equal(s.recorded[0].orderId, o.id);
    const row = await orderRow(o.id);
    assert.equal(row.status, "paid");
    assert.ok(row.paymentId);
    const receipt = (await m.fees.receiptData(db, row.paymentId!))!;
    assert.equal(receipt.paidOn, m.dates.todayIST(paidAt));
    assert.equal(receipt.providerPaymentId, "pay_FOUND0000001");
    assert.equal(receipt.method, "online");
    // Recorded by the check, in the activity log.
    const { auditLog } = m.schema;
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.action, "fees.online_payment"), eq(auditLog.targetId, row.paymentId!)));
    assert.equal(entry.actorLogin, "Razorpay check");
    // A paid order is never asked about again.
    const before = asked(o);
    const again = await m.check.checkUnfinishedOrders(new Date(Date.now() + 15 * MIN));
    assert.equal(again.recorded.length, 0);
    assert.equal(asked(o), before);
  });

  test("young orders wait for the browser and the webhook; older ones are asked less often", async () => {
    const young = await order(2, { status: "created" });
    const old = await order(30);
    fake.orders.set(young.providerOrderId!, []);
    fake.orders.set(old.providerOrderId!, []);
    const now = new Date();
    await m.check.checkUnfinishedOrders(now);
    assert.equal(asked(young), 0);
    assert.equal(asked(old), 1);
    await m.check.checkUnfinishedOrders(new Date(now.getTime() + 5 * MIN));
    assert.equal(asked(old), 1, "checked 5 minutes ago: not yet");
    await m.check.checkUnfinishedOrders(new Date(now.getTime() + 10 * MIN));
    assert.equal(asked(old), 2);
    assert.equal(asked(young), 1, "8 minutes old by now");
  });

  test("authorised payments wait; refunded ones are noted once, never recorded", async () => {
    const waiting = await order(20);
    const refunded = await order(20);
    fake.orders.set(waiting.providerOrderId!, [rpPayment("pay_AUTH00000001", waiting.providerOrderId!, 5_000_00, "authorized")]);
    fake.orders.set(refunded.providerOrderId!, [rpPayment("pay_REFD00000001", refunded.providerOrderId!, 5_000_00, "refunded", { amount_refunded: 5_000_00 })]);
    const now = new Date();
    const s = await m.check.checkUnfinishedOrders(now);
    assert.deepEqual([s.recorded.length, s.waiting, s.refundedThere], [0, 1, 1]);
    assert.equal((await orderRow(waiting.id)).status, "expired");
    assert.match((await orderRow(refunded.id)).failureReason ?? "", /refunded in full at Razorpay/);
    await m.check.checkUnfinishedOrders(new Date(now.getTime() + 10 * MIN));
    const { auditLog } = m.schema;
    const notes = await db.select().from(auditLog).where(and(eq(auditLog.action, "fees.online_refunded_at_gateway"), eq(auditLog.targetId, refunded.id)));
    assert.equal(notes.length, 1, "said once");
    // Once captured, the waiting payment is recorded.
    fake.orders.set(waiting.providerOrderId!, [rpPayment("pay_AUTH00000001", waiting.providerOrderId!, 5_000_00, "captured")]);
    const later = await m.check.checkUnfinishedOrders(new Date(now.getTime() + 20 * MIN));
    assert.equal(later.recorded.length, 1);
    assert.equal((await orderRow(waiting.id)).status, "paid");
  });

  test("an amount that doesn't match gets no receipt, and is said in the activity log", async () => {
    const o = await order(20, { chargeIds: [t2] });
    fake.orders.set(o.providerOrderId!, [rpPayment("pay_WRONG0000001", o.providerOrderId!, 4_000_00, "captured")]);
    const s = await m.check.checkUnfinishedOrders();
    assert.deepEqual([s.recorded.length, s.problems], [0, 1]);
    assert.equal((await orderRow(o.id)).status, "expired");
    const { auditLog, payments } = m.schema;
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.action, "fees.online_amount_mismatch"), eq(auditLog.targetId, o.id)));
    assert.equal((entry.details as Record<string, unknown>).studentId, student);
    assert.equal((await db.select().from(payments).where(eq(payments.providerPaymentId, "pay_WRONG0000001"))).length, 0);
  });

  test("a payment partly refunded at Razorpay is recorded with its refunds", async () => {
    const o = await order(25, { chargeIds: [t2] });
    fake.orders.set(o.providerOrderId!, [rpPayment("pay_PART00000001", o.providerOrderId!, 5_000_00, "captured", { amount_refunded: 1_000_00 })]);
    fake.refunds.set("pay_PART00000001", [rpRefund("rfnd_PART0000001", "pay_PART00000001", 1_000_00)]);
    const s = await m.check.checkUnfinishedOrders();
    assert.equal(s.recorded.length, 1);
    const receipt = (await m.fees.receiptData(db, s.recorded[0].paymentId))!;
    assert.equal(receipt.refunded, 1_000_00);
  });

  test("Razorpay being down stops nothing; the order is asked again later", async () => {
    const o = await order(15);
    fake.orders.set(o.providerOrderId!, []);
    fake.failNext = 100;
    const now = new Date();
    const s = await m.check.checkUnfinishedOrders(now);
    assert.ok(s.errors >= 1);
    fake.failNext = 0;
    const later = await m.check.checkUnfinishedOrders(new Date(now.getTime() + 10 * MIN));
    assert.equal(later.errors, 0);
    assert.ok(asked(o) >= 2);
  });

  test("a pass asks first about orders never asked about, then those asked about longest ago", async () => {
    const now = new Date(Date.now() + 2 * 24 * 60 * MIN); // later on, so earlier tests' orders are due too
    const older = [await order(3 * 24 * 60, { now }), await order(3 * 24 * 60 + 5, { now })];
    for (const o of older) fake.orders.set(o.providerOrderId!, []);
    // Last asked about just after they were made, three days ago: due again, and waiting longer than anything else here.
    const { paymentOrders } = m.schema;
    for (const o of older) await db.update(paymentOrders).set({ checkedAt: new Date(o.createdAt.getTime() + 6 * MIN) }).where(eq(paymentOrders.id, o.id));
    const newer = [await order(20, { now }), await order(25, { now })];
    for (const o of newer) fake.orders.set(o.providerOrderId!, []);
    await m.check.checkUnfinishedOrders(now, { perPass: 2 });
    assert.deepEqual(newer.map(asked), [1, 1], "never asked about: first");
    assert.deepEqual(older.map(asked), [0, 0]);
    await m.check.checkUnfinishedOrders(new Date(now.getTime() + MIN), { perPass: 2 });
    assert.ok(older.every((o) => asked(o) >= 1), "then the ones waiting longest, ahead of anything newer");
  });

  test("hundreds of orders that aren't due yet don't crowd out one that is", async () => {
    const now = new Date();
    const { paymentOrders } = m.schema;
    // 520 two-day-old orders last asked about 22 hours ago (next due in an hour), written straight to the table.
    await db.insert(paymentOrders).values(
      Array.from({ length: 520 }, (_, i) => ({
        schoolId: SCHOOL,
        studentId: student,
        amount: 5_000_00,
        chargeIds: [t1],
        provider: "razorpay",
        providerOrderId: `order_BULK${String(i).padStart(8, "0")}`,
        status: "expired" as const,
        createdBy: family,
        createdAt: new Date(now.getTime() - 2 * 24 * 60 * MIN),
        checkedAt: new Date(now.getTime() - 22 * 60 * MIN),
      })),
    );
    try {
      // A young order last asked about 10 minutes ago: due, though asked about more recently than all of those.
      const due = await order(30, { checkedAt: new Date(now.getTime() - 10 * MIN), now });
      fake.orders.set(due.providerOrderId!, []);
      await m.check.checkUnfinishedOrders(now, { perPass: 3 });
      assert.equal(asked(due), 1);
      assert.equal(fake.requests.filter((r) => r.includes("order_BULK")).length, 0, "none of the others asked about early");
    } finally {
      await db.delete(paymentOrders).where(like(paymentOrders.providerOrderId, "order_BULK%"));
    }
  });

  test("test-checkout orders, paid orders and orders older than a week are never asked about", async () => {
    const mock = await order(20, { provider: "mock" });
    const ancient = await order(8 * 24 * 60);
    await m.check.checkUnfinishedOrders();
    assert.equal(asked(mock), 0);
    assert.equal(asked(ancient), 0);
  });

  test("without Razorpay keys nothing happens", async () => {
    const o = await order(20);
    const keyId = process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_ID;
    try {
      const s = await m.check.checkUnfinishedOrders();
      assert.equal(s.orders, 0);
      assert.equal(asked(o), 0);
    } finally {
      process.env.RAZORPAY_KEY_ID = keyId;
    }
  });
});

describe("“Check with Razorpay” on a student's fee page", () => {
  test("asks at once about the student's unfinished orders, however young, and is logged", async () => {
    const young = await order(1, { status: "created", chargeIds: [t2], amount: 5_000_00 });
    fake.orders.set(young.providerOrderId!, []);
    const s = await m.check.checkStudentOrders({ schoolId: SCHOOL, studentId: student }, { accountId: null, loginId: "AryaE2", ip: null });
    assert.ok(s.orders >= 1);
    assert.equal(asked(young), 1);
    const { auditLog } = m.schema;
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.action, "fees.online_checked"), eq(auditLog.targetId, student)));
    assert.equal(entry.actorLogin, "AryaE2");
    // Another school's office finds nothing to ask about.
    const other = await m.check.checkStudentOrders({ schoolId: "aadharshila", studentId: student }, { accountId: null, loginId: "AadharE1", ip: null });
    assert.equal(other.orders, 0);
  });
});
