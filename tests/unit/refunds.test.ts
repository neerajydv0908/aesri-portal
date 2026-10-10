/**
 * Refunds (lib/services/refunds.ts) against a real (embedded) PostgreSQL:
 * where a refund's money comes from, net totals everywhere, voucher numbers,
 * what can't be refunded or cancelled, refunds recorded from Razorpay (the
 * office's button and the refund.processed webhook, each refund once), and
 * the collections report with refunds and whole-period totals.
 *
 *   node --import tsx --test tests/unit/refunds.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { FAKE_KEYS, rpRefund, startFakeRazorpay, unix, type FakeRazorpay } from "./fixtures/fake-razorpay";

// A fresh embedded database and a stand-in Razorpay for this file (read when first used).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-refunds-test-"));
process.env.PGLITE_DIR = dir;
delete process.env.DATABASE_URL;
delete process.env.SMS_PROVIDER;
process.env.APP_URL = "https://portal.aesri.org";
process.env.RAZORPAY_KEY_ID = FAKE_KEYS.keyId;
process.env.RAZORPAY_KEY_SECRET = FAKE_KEYS.keySecret;
process.env.RAZORPAY_WEBHOOK_SECRET = FAKE_KEYS.webhookSecret;

type Db = Awaited<ReturnType<typeof import("../../lib/db/client").getDb>>;
let db: Db;
let fake: FakeRazorpay;
let m: {
  client: typeof import("../../lib/db/client");
  schema: typeof import("../../lib/db/schema");
  fees: typeof import("../../lib/services/fees");
  refunds: typeof import("../../lib/services/refunds");
  payments: typeof import("../../lib/services/payments");
  reference: typeof import("../../lib/services/reference");
  crypto: typeof import("../../lib/auth/crypto");
  dates: typeof import("../../lib/dates");
};

const SCHOOL = "aryavart";
const SESSION = "2026-27";
const office = { accountId: null, loginId: "AryaE1", ip: null };
const S: Record<string, string> = {}; // students by short name
const lines: Record<string, { t1: string; t2: string }> = {}; // their two fee lines (Term I due 10 Apr, Term II due 15 Sep), ₹5,000 each

async function addStudent(key: string, srNo: string) {
  const { students, enrolments, sections, classes } = m.schema;
  await db.transaction(async (tx) => {
    const [cls] = await tx.select({ id: classes.id }).from(classes).where(and(eq(classes.schoolId, SCHOOL), eq(classes.name, "IV")));
    const [sec] = await tx.select({ id: sections.id }).from(sections).where(and(eq(sections.classId, cls.id), eq(sections.name, "A")));
    const [s] = await tx.insert(students).values({ schoolId: SCHOOL, srNo, name: `${key} Kumar` }).returning({ id: students.id });
    await tx.insert(enrolments).values({ studentId: s.id, sessionId: SESSION, sectionId: sec.id, rollNo: Number(srNo.slice(-2)) });
    await m.fees.ensureSessionCharges(tx, s.id, SESSION, office);
    S[key] = s.id;
    const l = (await m.fees.ledger(tx, s.id, SESSION)).lines;
    lines[key] = { t1: l[0].id, t2: l[1].id };
  });
}

const today = () => m.dates.todayIST();

async function pay(key: string, amount: number, method: "cash" | "cheque" | "bank" | "opening" = "cash") {
  return db.transaction((tx) =>
    m.fees.recordPayment(tx, { schoolId: SCHOOL, studentId: S[key], sessionId: SESSION, amount, method, reference: method === "cheque" ? "Cheque 1" : null, paidOn: today() }, office),
  );
}

/** An online payment as the portal records it: an order, then the gateway's captured payment. */
async function payOnline(key: string, chargeIds: string[], amount: number, payId: string) {
  const { paymentOrders, accounts } = m.schema;
  let [acc] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.loginId, `fam-${key.toLowerCase()}`));
  if (!acc) [acc] = await db.insert(accounts).values({ loginId: `fam-${key.toLowerCase()}`, role: "student", schoolId: SCHOOL, studentId: S[key], status: "active" }).returning({ id: accounts.id });
  const [o] = await db
    .insert(paymentOrders)
    .values({ schoolId: SCHOOL, studentId: S[key], amount, chargeIds, provider: "razorpay", providerOrderId: `order_${payId.slice(4)}`, createdBy: acc.id })
    .returning({ id: paymentOrders.id });
  const r = await db.transaction((tx) => m.payments.confirmOrderPayment(tx, o.id, { id: payId, amount, currency: "INR", method: "upi" }, { accountId: null, loginId: "razorpay webhook", ip: null }));
  assert.equal(r.status, "recorded");
  return (r as { paymentId: string }).paymentId;
}

async function refund(paymentId: string, amount: number, extra: Partial<import("../../lib/services/refunds").RefundInput> = {}) {
  return db.transaction((tx) => m.refunds.recordRefund(tx, { schoolId: SCHOOL, paymentId, amount, refundedOn: today(), method: "cash", note: "Student left", ...extra }, office));
}

async function paidOnLines(key: string) {
  const l = (await m.fees.ledger(db, S[key], SESSION)).lines;
  return { t1: l.find((x) => x.id === lines[key].t1)!.paid, t2: l.find((x) => x.id === lines[key].t2)!.paid };
}

before(async () => {
  m = {
    client: await import("../../lib/db/client"),
    schema: await import("../../lib/db/schema"),
    fees: await import("../../lib/services/fees"),
    refunds: await import("../../lib/services/refunds"),
    payments: await import("../../lib/services/payments"),
    reference: await import("../../lib/services/reference"),
    crypto: await import("../../lib/auth/crypto"),
    dates: await import("../../lib/dates"),
  };
  fake = await startFakeRazorpay();
  process.env.RAZORPAY_API_URL = fake.url;
  db = await m.client.getDb();
  await db.transaction((tx) => m.reference.seedReferenceData(tx));
  for (const [i, key] of ["Asha", "Bhanu", "Chetan", "Deepa", "Esha", "Farhan", "Gita"].entries()) await addStudent(key, `81${String(i).padStart(2, "0")}`);
});

after(async () => {
  await fake?.close();
  await m?.client.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("where a refund's money comes from", () => {
  const plan = (input: Partial<Parameters<typeof import("../../lib/services/refunds").planRefund>[0]> & { amount: number }) =>
    m.refunds.planRefund({ paymentAmount: 10_000_00, allocations: [], refundedFromLines: new Map(), refundedTotal: 0, ...input });
  const t1 = { chargeId: "t1", amount: 5_000_00, dueOn: "2026-04-10", order: 1 };
  const t2 = { chargeId: "t2", amount: 5_000_00, dueOn: "2026-09-15", order: 2 };

  test("the latest-due fee first", () => {
    assert.deepEqual(plan({ allocations: [t1, t2], amount: 6_000_00 }), { fromExcess: 0, lines: [{ chargeId: "t2", amount: 5_000_00 }, { chargeId: "t1", amount: 1_000_00 }] });
  });

  test("money paid beyond the fees due goes back first", () => {
    assert.deepEqual(plan({ paymentAmount: 7_000_00, allocations: [t1], amount: 1_500_00 }), { fromExcess: 1_500_00, lines: [] });
    assert.deepEqual(plan({ paymentAmount: 7_000_00, allocations: [t1], amount: 3_000_00 }), { fromExcess: 2_000_00, lines: [{ chargeId: "t1", amount: 1_000_00 }] });
  });

  test("earlier refunds are counted, and nothing beyond what is left", () => {
    const earlier = { refundedFromLines: new Map([["t2", 5_000_00]]), refundedTotal: 5_000_00 };
    assert.deepEqual(plan({ allocations: [t1, t2], ...earlier, amount: 5_000_00 }), { fromExcess: 0, lines: [{ chargeId: "t1", amount: 5_000_00 }] });
    assert.equal(plan({ allocations: [t1, t2], ...earlier, amount: 5_000_01 }), null);
    // An earlier refund already gave back part of the extra.
    assert.deepEqual(plan({ paymentAmount: 7_000_00, allocations: [t1], refundedTotal: 500_00, amount: 2_000_00 }), { fromExcess: 1_500_00, lines: [{ chargeId: "t1", amount: 500_00 }] });
  });

  test("nothing, a negative amount or more than was paid is refused", () => {
    for (const amount of [0, -1, 1.5, 10_000_01]) assert.equal(plan({ allocations: [t1, t2], amount }), null, String(amount));
  });
});

describe("a refund at the office", () => {
  test("comes off the latest fee, which is due again; totals, voucher and receipt follow", async () => {
    const before = await m.fees.feeTotals(db, SCHOOL, SESSION);
    const p = await pay("Asha", 10_000_00);
    const r = await refund(p.id, 6_000_00, { method: "cheque", reference: "Cheque 004513" });
    assert.equal(r.status, "recorded");
    assert.ok(r.status === "recorded" && /^ARY\/26-27\/RF\d{5}$/.test(r.voucherNo), "voucher number");
    assert.ok(r.status === "recorded" && r.fromExcess === 0);
    assert.deepEqual(r.status === "recorded" ? r.reopened.map((l) => l.amount) : [], [5_000_00, 1_000_00]);
    assert.deepEqual(await paidOnLines("Asha"), { t1: 4_000_00, t2: 0 });

    const led = await m.fees.ledger(db, S.Asha, SESSION);
    assert.equal(led.totals.paid, 4_000_00);
    assert.equal(led.totals.refunded, 6_000_00);
    assert.equal(led.totals.outstanding, 6_000_00);
    assert.equal(led.refunds.length, 1);

    const after = await m.fees.feeTotals(db, SCHOOL, SESSION);
    assert.equal(after.collected - before.collected, 4_000_00, "the session's collected figure is net of refunds");
    assert.equal(after.collectedToday - before.collectedToday, 10_000_00, "money received today stays as received");
    assert.equal(after.refunded - before.refunded, 6_000_00);
    assert.equal(after.refundedToday - before.refundedToday, 6_000_00);
    assert.equal(after.outstanding - before.outstanding, -4_000_00);

    const row = (await m.fees.schoolFeeRows(db, SCHOOL, SESSION)).find((x) => x.studentId === S.Asha)!;
    assert.equal(row.paid, 4_000_00);
    assert.equal(row.outstanding, 6_000_00);

    const receipt = (await m.fees.receiptData(db, p.id))!;
    assert.equal(receipt.amount, 10_000_00);
    assert.equal(receipt.lines.length, 2, "the receipt keeps the fees it paid");
    assert.equal(receipt.refunded, 6_000_00);
    assert.equal(receipt.refunds[0].reference, "Cheque 004513");

    // A second refund: the next voucher number, and what is left.
    const r2 = await refund(p.id, 4_000_00);
    assert.ok(r2.status === "recorded" && r.status === "recorded" && r2.voucherNo > r.voucherNo);
    await assert.rejects(refund(p.id, 1), /Everything paid on receipt .* has already been refunded/);
  });

  test("can't be more than is left, in the future, or before the payment", async () => {
    const p = await pay("Bhanu", 5_000_00);
    await assert.rejects(refund(p.id, 5_000_01), /At most ₹5,000 can still be refunded/);
    await assert.rejects(refund(p.id, 100_00, { refundedOn: m.dates.addDays(today(), 1) }), /can't be in the future/);
    await assert.rejects(refund(p.id, 100_00, { refundedOn: m.dates.addDays(today(), -1) }), /before the payment's date/);
    await assert.rejects(refund(p.id, 100_00, { note: "  " }), /Write why/);
    await assert.rejects(refund(p.id, 100_00, { method: "online" }), /cash, cheque or bank transfer/);
  });

  test("a receipt with refunds can't be cancelled; a cancelled one can't be refunded; nor can opening balances", async () => {
    const p = await pay("Chetan", 5_000_00);
    await refund(p.id, 1_000_00);
    await assert.rejects(
      db.transaction((tx) => m.fees.reversePayment(tx, p.id, SCHOOL, "Cheque bounced", office)),
      /already been refunded on this receipt, so it can't be cancelled/,
    );
    const c = await pay("Chetan", 1_000_00, "cheque");
    await db.transaction((tx) => m.fees.reversePayment(tx, c.id, SCHOOL, "Cheque bounced", office));
    await assert.rejects(refund(c.id, 100_00), /cancelled, so there is nothing to refund/);
    const o = await pay("Chetan", 500_00, "opening");
    await assert.rejects(refund(o.id, 100_00), /opening balance/);
    await assert.rejects(refund("00000000-0000-4000-8000-000000000000", 100_00), /not found/);
    // Another school's payment is "not found" too.
    await assert.rejects(
      db.transaction((tx) => m.refunds.recordRefund(tx, { schoolId: "aadharshila", paymentId: p.id, amount: 100_00, refundedOn: today(), method: "cash", note: "x" }, office)),
      /not found/,
    );
  });

  test("an online payment can't be refunded by hand", async () => {
    const id = await payOnline("Deepa", [lines.Deepa.t1], 5_000_00, "pay_DEEPA0000001");
    await assert.rejects(refund(id, 100_00), /refunded in the Razorpay Dashboard/);
  });
});

describe("a refund entered by mistake, a repeated form, a waived fee", () => {
  test("an office refund can be cancelled: it stays listed, stops counting, and the receipt can be reversed again", async () => {
    await addStudent("Hari", "8190");
    const p = await pay("Hari", 10_000_00);
    const r = await refund(p.id, 3_000_00);
    assert.ok(r.status === "recorded");
    assert.deepEqual(await paidOnLines("Hari"), { t1: 5_000_00, t2: 2_000_00 });
    const cancel = (reason = "Entered twice by mistake") =>
      db.transaction((tx) => m.refunds.cancelRefund(tx, { schoolId: SCHOOL, refundId: (r as { id: string }).id, reason }, office));
    await assert.rejects(cancel("  "), /Write why/);
    assert.equal(await cancel(), true);
    assert.equal(await cancel(), false, "already cancelled");
    assert.deepEqual(await paidOnLines("Hari"), { t1: 5_000_00, t2: 5_000_00 }, "paid again");
    const led = await m.fees.ledger(db, S.Hari, SESSION);
    assert.equal(led.totals.paid, 10_000_00);
    assert.equal(led.totals.refunded, 0);
    assert.equal(led.refunds[0].status, "reversed", "still listed");
    const receipt = (await m.fees.receiptData(db, p.id))!;
    assert.equal(receipt.refunds.length, 0);
    assert.equal(receipt.refunded, 0);
    // The whole amount can be refunded again, and with no refund left the receipt could be cancelled.
    await assert.rejects(refund(p.id, 10_000_01), /At most ₹10,000/);
    const { auditLog } = m.schema;
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.action, "fees.refund_cancelled"), eq(auditLog.targetId, p.id)));
    assert.equal((entry.details as Record<string, unknown>).reason, "Entered twice by mistake");
    await db.transaction((tx) => m.fees.reversePayment(tx, p.id, SCHOOL, "Payment entered on the wrong student", office));
    // Cancelled refunds are listed in the collections report but not counted.
    const totals = await m.fees.collectionTotals(db, SCHOOL, today(), today(), false);
    assert.ok(totals.cancelledRefunds >= 1);
    const rows = (await m.fees.collectionRows(db, SCHOOL, today(), today(), false)).rows;
    const listed = rows.find((x) => x.kind === "refund" && x.id === (r as { id: string }).id)!;
    assert.equal(listed.status, "reversed");
    assert.match(listed.note ?? "", /^Refund cancelled: Entered twice by mistake/);
  });

  test("a refund can't be cancelled once the fee it reopened has been paid again (it would count twice)", async () => {
    await addStudent("Lata", "8194");
    const p = await pay("Lata", 10_000_00);
    const r = await refund(p.id, 3_000_00);
    assert.ok(r.status === "recorded");
    const later = await pay("Lata", 3_000_00); // the family pays the reopened ₹3,000 again
    assert.deepEqual(await paidOnLines("Lata"), { t1: 5_000_00, t2: 5_000_00 });
    const cancel = () => db.transaction((tx) => m.refunds.cancelRefund(tx, { schoolId: SCHOOL, refundId: (r as { id: string }).id, reason: "Entered by mistake" }, office));
    await assert.rejects(cancel(), /been paid again since this refund, so cancelling it would count that fee twice\. First reverse \(or refund\) the later payment/);
    const unchanged = await m.fees.ledger(db, S.Lata, SESSION);
    assert.equal(unchanged.totals.refunded, 3_000_00);
    assert.equal(unchanged.refunds[0].status, "completed");
    // Reverse the later payment first; then the refund can be cancelled, and the fees are paid exactly once.
    await db.transaction((tx) => m.fees.reversePayment(tx, later.id, SCHOOL, "The refund was entered by mistake", office));
    assert.equal(await cancel(), true);
    assert.deepEqual(await paidOnLines("Lata"), { t1: 5_000_00, t2: 5_000_00 });
    const led = await m.fees.ledger(db, S.Lata, SESSION);
    assert.equal(led.totals.paid, 10_000_00);
    assert.equal(led.totals.outstanding, 0);
  });

  test("a Razorpay refund can't be cancelled", async () => {
    await addStudent("Isha", "8191");
    const id = await payOnline("Isha", [lines.Isha.t1], 5_000_00, "pay_ISHA00000001");
    fake.refunds.set("pay_ISHA00000001", [rpRefund("rfnd_ISHA0000001", "pay_ISHA00000001", 1_000_00)]);
    await m.refunds.syncGatewayRefunds({ schoolId: SCHOOL, paymentId: id }, office);
    const [row] = (await m.fees.ledger(db, S.Isha, SESSION)).refunds;
    await assert.rejects(
      db.transaction((tx) => m.refunds.cancelRefund(tx, { schoolId: SCHOOL, refundId: row.id, reason: "Wrong" }, office)),
      /made through Razorpay can't be cancelled/,
    );
  });

  test("the same refund form sent twice records one refund", async () => {
    await addStudent("Jai", "8192");
    const p = await pay("Jai", 10_000_00);
    const requestId = "6f1c2a52-9a8e-4d0b-9f7e-3b3c4a5d6e7f";
    const first = await refund(p.id, 1_000_00, { requestId });
    const again = await refund(p.id, 1_000_00, { requestId });
    assert.equal(first.status, "recorded");
    assert.equal(again.status, "already");
    assert.equal((await m.fees.ledger(db, S.Jai, SESSION)).totals.refunded, 1_000_00);
    // The same id on another payment is refused (₹1,000 became due again, so there can be another payment).
    const p2 = await pay("Jai", 500_00);
    await assert.rejects(refund(p2.id, 100_00, { requestId }), /Reload the page/);
    await assert.rejects(refund(p2.id, 100_00, { requestId: "not-a-uuid" }), /Reload the page/);
  });

  test("money taken back from a waived fee doesn't make it due again", async () => {
    await addStudent("Kiran", "8193");
    const p = await pay("Kiran", 6_000_00); // Term I paid, ₹1,000 towards Term II
    await db.transaction((tx) => m.fees.waiveCharge(tx, { schoolId: SCHOOL, sessionId: SESSION, chargeId: lines.Kiran.t2, note: "Concession" }, office));
    const r = await refund(p.id, 1_000_00);
    assert.ok(r.status === "recorded");
    assert.deepEqual(r.status === "recorded" ? r.reopened.map((l) => [l.chargeId === lines.Kiran.t2, l.waived]) : [], [[true, true]]);
    const led = await m.fees.ledger(db, S.Kiran, SESSION);
    assert.equal(led.totals.outstanding, 0, "nothing becomes due on a waived fee");
    assert.equal(led.totals.charged, 5_000_00, "a waived fee counts only what stays paid on it");
  });
});

describe("refunds made at Razorpay", () => {
  test("“Record refunds made in Razorpay”: processed refunds once each, money beyond the fees first", async () => {
    // Esha's fees are paid at the counter, then an online payment arrives for the same fee: all of it is extra.
    await pay("Esha", 10_000_00);
    const id = await payOnline("Esha", [lines.Esha.t1], 5_000_00, "pay_ESHA00000001");
    const receipt = (await m.fees.receiptData(db, id))!;
    assert.equal(receipt.unallocated, 5_000_00);
    fake.refunds.set("pay_ESHA00000001", [
      rpRefund("rfnd_ESHA0000001", "pay_ESHA00000001", 3_000_00, "processed", { created_at: unix(new Date(Date.now() - 86_400_000)) }),
      rpRefund("rfnd_ESHA0000002", "pay_ESHA00000001", 2_000_00, "pending"),
      rpRefund("rfnd_ESHA0000003", "pay_ESHA00000001", 1_000_00, "failed"),
    ]);
    const first = await m.refunds.syncGatewayRefunds({ schoolId: SCHOOL, paymentId: id }, office);
    assert.equal(first.recorded.length, 1);
    assert.deepEqual([first.pending, first.failed, first.already, first.problems.length], [1, 1, 0, 0]);
    const again = await m.refunds.syncGatewayRefunds({ schoolId: SCHOOL, paymentId: id }, office);
    assert.deepEqual([again.recorded.length, again.already], [0, 1]);

    const after = (await m.fees.receiptData(db, id))!;
    assert.equal(after.refunded, 3_000_00);
    assert.equal(after.unallocatedRefunded, 3_000_00, "taken from the extra, not from the fees");
    assert.equal(after.refunds[0].method, "online");
    assert.equal(after.refunds[0].providerRefundId, "rfnd_ESHA0000001");
    assert.equal(after.refunds[0].refundedOn, after.paidOn, "Razorpay said yesterday: never before the payment's own date");
    assert.deepEqual(await paidOnLines("Esha"), { t1: 5_000_00, t2: 5_000_00 }, "the fees stay paid");

    // A counter payment has nothing at Razorpay.
    const cash = await pay("Farhan", 1_000_00);
    await assert.rejects(m.refunds.syncGatewayRefunds({ schoolId: SCHOOL, paymentId: cash.id }, office), /isn't an online payment/);
  });

  test("the refund.processed webhook records a refund once, whichever way it arrives first", async () => {
    const id = await payOnline("Gita", [lines.Gita.t1, lines.Gita.t2], 10_000_00, "pay_GITA00000001");
    const body = (refundId: string, amount: number, status = "processed") =>
      JSON.stringify({
        entity: "event",
        event: "refund.processed",
        payload: { refund: { entity: rpRefund(refundId, "pay_GITA00000001", amount, status) }, payment: { entity: { id: "pay_GITA00000001", amount: 10_000_00, currency: "INR", status: "captured" } } },
      });
    const send = (raw: string, eventId: string) => m.payments.handleGatewayWebhook("razorpay", raw, m.crypto.hmacHex(FAKE_KEYS.webhookSecret, raw), eventId, "203.0.113.9");

    const raw = body("rfnd_GITA0000001", 2_500_00);
    assert.deepEqual((await send(raw, "evt_1")).body, { ok: true, result: "recorded" });
    assert.deepEqual((await send(raw, "evt_1")).body, { ok: true, duplicate: true });
    assert.deepEqual((await send(raw, "evt_2")).body, { ok: true, result: "already" }, "the same refund in another delivery");
    assert.equal((await m.fees.receiptData(db, id))!.refunded, 2_500_00);
    assert.deepEqual(await paidOnLines("Gita"), { t1: 5_000_00, t2: 2_500_00 }, "off the latest fee");

    // The office's button finds the same refund already recorded.
    fake.refunds.set("pay_GITA00000001", [rpRefund("rfnd_GITA0000001", "pay_GITA00000001", 2_500_00)]);
    assert.equal((await m.refunds.syncGatewayRefunds({ schoolId: SCHOOL, paymentId: id }, office)).already, 1);

    // Not processed, or for a payment the portal never recorded: nothing happens.
    assert.deepEqual((await send(body("rfnd_GITA0000002", 100_00, "pending"), "evt_4")).body, { ok: true, ignored: "missing refund details" });
    const stranger = JSON.stringify({ event: "refund.processed", payload: { refund: { entity: rpRefund("rfnd_OTHER000001", "pay_OTHER0000001", 100_00) } } });
    assert.deepEqual((await send(stranger, "evt_5")).body, { ok: true, ignored: "unknown payment" });
    // More than is left: not recorded, and said in the activity log.
    assert.deepEqual((await send(body("rfnd_GITA0000003", 9_000_00), "evt_6")).body, { ok: true, ignored: "refund not recorded" });
    const { auditLog } = m.schema;
    const [note] = await db.select().from(auditLog).where(eq(auditLog.action, "fees.refund_not_recorded"));
    assert.match(String((note.details as Record<string, unknown>).reason), /At most ₹7,500 can still be refunded/);
    // A wrong signature is refused before anything is read.
    assert.equal((await m.payments.handleGatewayWebhook("razorpay", raw, "0".repeat(64), "evt_7", null)).status, 400);
  });
});

describe("the collections report", () => {
  test("lists refunds as money paid out, and adds up the whole period", async () => {
    const day = today();
    const { rows, truncated } = await m.fees.collectionRows(db, SCHOOL, day, day, false);
    const totals = await m.fees.collectionTotals(db, SCHOOL, day, day, false);
    assert.equal(truncated, false);
    const receipts = rows.filter((r) => r.kind === "receipt");
    const refunds = rows.filter((r) => r.kind === "refund");
    const counted = refunds.filter((r) => r.status === "completed");
    assert.ok(counted.length >= 3 && refunds.every((r) => r.voucherNo && r.amount > 0));
    assert.equal(totals.received.total, receipts.filter((r) => r.status === "completed").reduce((a, r) => a + r.amount, 0));
    assert.equal(totals.refunded.total, counted.reduce((a, r) => a + r.amount, 0), "cancelled refunds are listed, not counted");
    assert.equal(totals.refunded.count, counted.length);
    assert.equal(totals.cancelledRefunds, refunds.length - counted.length);
    assert.equal(totals.net, totals.received.total - totals.refunded.total);
    assert.equal(totals.cancelled, receipts.filter((r) => r.status === "reversed").length);
    assert.equal(totals.entries, rows.length);
    assert.ok(totals.refunded.byMethod.some((x) => x.method === "online") && totals.refunded.byMethod.some((x) => x.method === "cash"));
    // Opening balances are left out unless asked for.
    assert.ok(!rows.some((r) => r.method === "opening"));
    assert.ok((await m.fees.collectionRows(db, SCHOOL, day, day, true)).rows.some((r) => r.method === "opening"));
  });

  test("a long list is cut short, but the totals still count every entry", async () => {
    const { payments: paymentsT, students } = m.schema;
    // 60 small receipts on one day in the past (written straight to the table: only the report reads them).
    const [st] = await db.select({ id: students.id }).from(students).where(eq(students.id, S.Farhan));
    const day = "2026-06-01";
    await db.insert(paymentsT).values(
      Array.from({ length: 60 }, (_, i) => ({ schoolId: SCHOOL, studentId: st.id, sessionId: SESSION, amount: 100_00 + i, method: "cash" as const, paidOn: day, receiptNo: `ARYA/26-27/T${String(i).padStart(5, "0")}` })),
    );
    const cut = await m.fees.collectionRows(db, SCHOOL, day, day, false, 50);
    const all = await m.fees.collectionRows(db, SCHOOL, day, day, false);
    const totals = await m.fees.collectionTotals(db, SCHOOL, day, day, false);
    assert.equal(cut.rows.length, 50);
    assert.equal(cut.truncated, true);
    assert.equal(all.rows.length, 60);
    assert.equal(all.truncated, false);
    assert.equal(totals.entries, 60);
    assert.equal(totals.received.count, 60);
    assert.equal(totals.received.total, Array.from({ length: 60 }, (_, i) => 100_00 + i).reduce((a, b) => a + b, 0));
    assert.deepEqual(cut.rows, all.rows.slice(0, 50), "the first 50 in date order");
    await db.execute(sql`delete from payments where receipt_no like 'ARYA/26-27/T%'`);
  });
});
