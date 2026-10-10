/**
 * Online fee payments: orders, checkout confirmation and gateway webhooks.
 *
 *   1. A family chooses what to pay: the admission fee (a fixed sum) and/or
 *      an amount of tuition (at least ₹1,000, or what is left). The server
 *      works out again what this student can pay (familyPayable: their
 *      unpaid lines, less cash payments they recorded that wait for
 *      approval), checks the choice and creates a payment order — its
 *      amount and the lines to pay in order — then asks the gateway for its
 *      own order id.
 *   2. After checkout, the gateway's signature is verified on the server, the
 *      payment is looked up to check the amount, and only then recorded.
 *   3. Webhooks are verified with an HMAC of the raw body and recorded
 *      idempotently: each event once (webhook_events), each gateway payment
 *      once (unique provider_payment_id), each order once (unique order_id,
 *      and the order row is locked while it is confirmed). So the browser
 *      return and the webhook can both arrive and only one receipt is made.
 *
 * Orders older than 30 minutes expire. Money a gateway reports as captured is
 * still recorded after that (it was taken), and anything beyond what is now
 * due is flagged in the activity log for a refund. If both the browser and
 * the webhook are lost, the Razorpay check (payment-check.ts) finds the
 * payment by asking Razorpay. Refunds made in the Razorpay Dashboard arrive
 * as refund.processed webhooks and are recorded by refunds.ts.
 */
import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import { academicSessions, paymentOrders, payments, schools, studentCharges, webhookEvents } from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { todayIST } from "@/lib/dates";
import { paymentProvider, razorpayTestKeys, razorpayTestKeysRefused, testPaymentsAllowed } from "@/lib/env";
import { GatewayError, gatewayFor, isGatewayId, mockGateway, razorpayGateway, type GatewayEvent, type GatewayPayment, type ProviderName } from "@/lib/payments";
import { allocate, checkFamilyChoice, familyPayable, isUuid, ledger, linesById, lockStudent, pendingCashFor, recordPayment, rupees, type ChoiceProblem, type FamilyChoice, type FamilyPayable } from "./fees";
import { recordGatewayRefund, RefundError } from "./refunds";

export const ORDER_TTL_MINUTES = 30;
const ttlCutoff = () => new Date(Date.now() - ORDER_TTL_MINUTES * 60_000);

export type OrderErrorCode =
  | "unavailable"
  | "no_lines"
  | "not_due"
  | "too_small"
  | "amount_small"
  | "amount_large"
  | "open_order"
  | "gateway"
  | "not_found"
  | "expired"
  | "closed"
  | "signature"
  | "mismatch"
  | "pending"
  | "changed";

/** An expected problem with an online payment; `code` lets family pages show it in Hindi too. */
export class OrderError extends Error {
  constructor(
    public code: OrderErrorCode,
    message: string,
    public orderId?: string,
    /** For amount_small / amount_large: the tuition the family may pay now (paise). */
    public limits?: { min: number; max: number },
  ) {
    super(message);
  }
}

/** A family's choice that can't be paid, as the error the pay pages explain (in English or Hindi). */
export function choiceError(problem: ChoiceProblem, p: FamilyPayable): OrderError {
  const limits = p.tuition ? { min: p.tuition.min, max: p.tuition.max } : undefined;
  switch (problem) {
    case "nothing":
      return new OrderError("no_lines", "Choose the admission fee or enter an amount of tuition to pay.");
    case "tuition_small":
      return new OrderError("amount_small", `Pay at least ${rupees(limits?.min ?? 0)} of tuition.`, undefined, limits);
    case "tuition_large":
      return new OrderError("amount_large", `Only ${rupees(limits?.max ?? 0)} of tuition is left to pay this session.`, undefined, limits);
    default:
      return new OrderError("not_due", "Some of the chosen fees are already paid or no longer due. The page has been updated — please choose again.");
  }
}

/* ------------------------------------------------------------------ */
/* Availability                                                        */
/* ------------------------------------------------------------------ */

/**
 * Can families pay online? Razorpay needs its keys. The test checkout
 * follows testPaymentsAllowed() (lib/env.ts): on a development server, or on
 * a production server only with ALLOW_TEST_PAYMENTS=1 (a demo server), and
 * never alongside PAYMENT_PROVIDER=razorpay — so a real school can never
 * mark fees as paid without money moving. The same rule is checked again
 * wherever the test checkout acts (its page, Pay button and webhook).
 * (`_tx` is kept for callers; nothing is read from the database.)
 */
export async function onlinePaymentsAvailable(_tx?: Tx): Promise<{ ok: boolean; provider: ProviderName; reason?: string; test?: boolean }> {
  const provider = paymentProvider();
  if (provider === "razorpay") {
    if (!razorpayGateway.isConfigured()) return { ok: false, provider, reason: "Razorpay keys are not set." };
    if (razorpayTestKeysRefused()) return { ok: false, provider, reason: "Razorpay test keys are set on a production server: they move no money, so online payment is off. Use the live keys (or ALLOW_TEST_PAYMENTS=1 on a demo server)." };
    return { ok: true, provider, test: razorpayTestKeys() };
  }
  return testPaymentsAllowed()
    ? { ok: true, provider, test: true }
    : { ok: false, provider, reason: "The test checkout is switched off on a production server. Set PAYMENT_PROVIDER=razorpay (or ALLOW_TEST_PAYMENTS=1 on a demo server)." };
}

/** The test checkout may not act here: behave as if the order didn't exist for it. */
function assertTestCheckout(): void {
  if (!testPaymentsAllowed()) throw new OrderError("unavailable", "Online payment is not available yet. Please pay at the school office.");
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

type OrderRow = typeof paymentOrders.$inferSelect;

export const orderIsOpen = (o: Pick<OrderRow, "status" | "createdAt">) => o.status === "created" && o.createdAt >= ttlCutoff();
export const orderExpiresAt = (o: Pick<OrderRow, "createdAt">) => new Date(o.createdAt.getTime() + ORDER_TTL_MINUTES * 60_000);

async function expireStale(tx: Tx, studentId: string, schoolId: string, actor: AuditActor) {
  const stale = await tx
    .update(paymentOrders)
    .set({ status: "expired", failureReason: `Not paid within ${ORDER_TTL_MINUTES} minutes` })
    .where(and(eq(paymentOrders.studentId, studentId), eq(paymentOrders.status, "created"), lt(paymentOrders.createdAt, ttlCutoff())))
    .returning({ id: paymentOrders.id });
  if (stale.length) {
    await audit(tx, actor, "fees.online_order_expired", { schoolId, targetType: "student", targetId: studentId, details: { orders: stale.map((s) => s.id) } });
  }
}

/**
 * Start an online payment for what the family chose: the admission fee
 * and/or an amount of tuition (checkFamilyChoice). Returns the open order
 * when the family chose exactly the same again (a second tap on "Pay"), and
 * refuses a new one while a different payment is still open — tuition is
 * paid in any amount, so any two payments could pay the same fee.
 */
export async function createPaymentOrder(
  input: { schoolId: string; studentId: string; sessionId: string; choice: FamilyChoice },
  actor: AuditActor,
): Promise<{ orderId: string; provider: ProviderName; reused: boolean }> {
  const avail = await onlinePaymentsAvailable();
  if (!avail.ok) throw new OrderError("unavailable", "Online payment is not available yet. Please pay at the school office.");
  if (!actor.accountId) throw new OrderError("not_found", "Sign in again to pay online.");
  const gateway = gatewayFor(avail.provider);

  const db = await getDb();
  const step = await db.transaction(async (tx) => {
    await lockStudent(tx, input.studentId, input.schoolId);
    await expireStale(tx, input.studentId, input.schoolId, actor);
    const [{ lines }, pending] = await Promise.all([ledger(tx, input.studentId, input.sessionId), pendingCashFor(tx, input.studentId, input.sessionId)]);
    const payable = familyPayable(lines, pending, todayIST());
    const checked = checkFamilyChoice(payable, input.choice);
    if (!checked.ok) throw choiceError(checked.problem, payable);
    const { amount, chargeIds } = checked.value; // the admission fee first, then tuition oldest first
    if (amount < 100) throw new OrderError("too_small", "The amount is too small to pay online. Please pay at the school office.");

    const open = await tx
      .select()
      .from(paymentOrders)
      .where(and(eq(paymentOrders.studentId, input.studentId), eq(paymentOrders.status, "created"), gte(paymentOrders.createdAt, ttlCutoff())))
      .orderBy(desc(paymentOrders.createdAt));
    for (const o of open) {
      const same =
        o.chargeIds.length === chargeIds.length && chargeIds.every((id, i) => o.chargeIds[i] === id) && o.amount === amount && o.provider === gateway.name && !!o.providerOrderId;
      if (same) return { orderId: o.id, amount, reused: true };
      throw new OrderError("open_order", "You already started a payment. Continue that payment, or cancel it first.", o.id);
    }

    const [o] = await tx
      .insert(paymentOrders)
      .values({ schoolId: input.schoolId, studentId: input.studentId, amount, chargeIds, provider: gateway.name, createdBy: actor.accountId! })
      .returning({ id: paymentOrders.id });
    await audit(tx, actor, "fees.online_order_created", {
      schoolId: input.schoolId,
      targetType: "payment_order",
      targetId: o.id,
      details: { studentId: input.studentId, amount, chargeIds, provider: gateway.name },
    });
    return { orderId: o.id, amount, reused: false };
  });
  if (step.reused) return { orderId: step.orderId, provider: gateway.name, reused: true };

  // Ask the gateway for its order id — outside the database transaction, so a slow network never holds locks.
  try {
    const [school] = await db.select({ code: schools.code }).from(schools).where(eq(schools.id, input.schoolId));
    const g = await gateway.createOrder({ orderId: step.orderId, amount: step.amount, notes: { portal_order: step.orderId, school: school?.code ?? input.schoolId } });
    await db.transaction(async (tx) => {
      await tx
        .update(paymentOrders)
        .set({ providerOrderId: g.providerOrderId })
        .where(and(eq(paymentOrders.id, step.orderId), eq(paymentOrders.status, "created"), isNull(paymentOrders.providerOrderId)));
      await audit(tx, actor, "fees.online_order_started", {
        schoolId: input.schoolId,
        targetType: "payment_order",
        targetId: step.orderId,
        details: { provider: gateway.name, providerOrderId: g.providerOrderId },
      });
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await db.transaction(async (tx) => {
      await tx
        .update(paymentOrders)
        .set({ status: "failed", failureReason: "The payment gateway could not start this payment." })
        .where(and(eq(paymentOrders.id, step.orderId), eq(paymentOrders.status, "created")));
      await audit(tx, actor, "fees.online_order_failed", {
        schoolId: input.schoolId,
        targetType: "payment_order",
        targetId: step.orderId,
        details: { error: detail.slice(0, 300) },
      });
    });
    if (err instanceof GatewayError) throw new OrderError("gateway", "The payment service could not be reached. Please try again in a few minutes.");
    throw err;
  }
  return { orderId: step.orderId, provider: gateway.name, reused: false };
}

/**
 * A family's own order (for the pay pages), with what it pays on each fee
 * line — worked out as it will be when the money arrives: the lines in the
 * order's order, as much of each as is still due. `stale`: an open order
 * whose lines no longer take its whole amount (the office recorded a payment
 * for them meanwhile) — the family should start again rather than pay more
 * than they chose. Null when it isn't theirs.
 */
export async function familyOrder(tx: Tx, orderId: string, studentId: string) {
  if (!isUuid(orderId)) return null;
  const [o] = await tx
    .select()
    .from(paymentOrders)
    .where(and(eq(paymentOrders.id, orderId), eq(paymentOrders.studentId, studentId)));
  if (!o) return null;
  const lines = await linesById(tx, o.chargeIds, studentId);
  const { allocations, excess } = allocate(lines, o.amount, o.chargeIds);
  const parts = allocations.map((a) => {
    const l = lines.find((x) => x.id === a.chargeId)!;
    return { id: l.id, kind: l.kind, label: l.label, labelHi: l.labelHi, dueOn: l.dueOn, amount: a.amount, lineAmount: l.amount };
  });
  return { ...o, parts, isOpen: orderIsOpen(o), expiresAt: orderExpiresAt(o), stale: o.status === "created" && excess > 0 };
}
export type FamilyOrder = NonNullable<Awaited<ReturnType<typeof familyOrder>>>;

/** The family's newest open order, if any (shown as "Continue payment"). */
export async function openOrderFor(tx: Tx, studentId: string) {
  const [o] = await tx
    .select()
    .from(paymentOrders)
    .where(and(eq(paymentOrders.studentId, studentId), eq(paymentOrders.status, "created"), gte(paymentOrders.createdAt, ttlCutoff())))
    .orderBy(desc(paymentOrders.createdAt))
    .limit(1);
  return o ?? null;
}

/** The family cancels an unfinished payment, or the test checkout's "Fail" button. */
/**
 * Close an unfinished order. Returns what the order really is afterwards: "closed", or
 * "paid" (with its payment) when the money had already arrived — the page may be stale.
 */
export async function closeOrder(
  tx: Tx,
  input: { orderId: string; studentId: string; outcome: "cancelled" | "failed"; reason: string },
  actor: AuditActor,
): Promise<{ state: "closed" | "paid"; paymentId: string | null }> {
  if (!isUuid(input.orderId)) throw new OrderError("not_found", "Payment not found.");
  const [o] = await tx
    .select()
    .from(paymentOrders)
    .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.studentId, input.studentId)))
    .for("update");
  if (!o) throw new OrderError("not_found", "Payment not found.");
  if (o.status === "paid") return { state: "paid", paymentId: o.paymentId };
  if (o.status !== "created") return { state: "closed", paymentId: null };
  await tx
    .update(paymentOrders)
    .set({ status: "failed", failureReason: input.reason.slice(0, 300) })
    .where(eq(paymentOrders.id, o.id));
  await audit(tx, actor, input.outcome === "cancelled" ? "fees.online_order_cancelled" : "fees.online_order_failed", {
    schoolId: o.schoolId,
    targetType: "payment_order",
    targetId: o.id,
    details: { reason: input.reason.slice(0, 300), amount: o.amount },
  });
  return { state: "closed", paymentId: null };
}

/* ------------------------------------------------------------------ */
/* Confirmation (shared by checkout return, test checkout and webhooks) */
/* ------------------------------------------------------------------ */

export type ConfirmResult =
  { status: "recorded" | "already"; paymentId: string; receiptNo: string } | { status: "duplicate"; paymentId: string; receiptNo: string } | { status: "mismatch"; detail: string };

async function receiptNoOf(tx: Tx, paymentId: string): Promise<string> {
  const [p] = await tx.select({ receiptNo: payments.receiptNo }).from(payments).where(eq(payments.id, paymentId));
  return p?.receiptNo ?? "";
}

/**
 * Record a gateway payment against its order — exactly once. The order row
 * is locked, the gateway payment id and the order may each be recorded only
 * once, and the amount must equal the order amount (in INR).
 */
export async function confirmOrderPayment(
  tx: Tx,
  orderId: string,
  paid: { id: string; amount: number; currency: string; method?: string | null; paidOn?: string },
  actor: AuditActor,
): Promise<ConfirmResult> {
  // Lock the student before the order — the same order as creating an order does — so two
  // transactions can never wait on each other.
  const [peek] = await tx.select({ studentId: paymentOrders.studentId, schoolId: paymentOrders.schoolId }).from(paymentOrders).where(eq(paymentOrders.id, orderId));
  if (!peek) throw new OrderError("not_found", "Payment order not found.");
  await lockStudent(tx, peek.studentId, peek.schoolId);
  const [o] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, orderId)).for("update");
  if (!o) throw new OrderError("not_found", "Payment order not found.");

  const [existing] = await tx.select({ id: payments.id, receiptNo: payments.receiptNo, orderId: payments.orderId }).from(payments).where(eq(payments.providerPaymentId, paid.id));
  if (existing) {
    if (existing.orderId === o.id) return { status: "already", paymentId: existing.id, receiptNo: existing.receiptNo };
    await audit(tx, actor, "fees.online_payment_conflict", {
      schoolId: o.schoolId,
      targetType: "payment_order",
      targetId: o.id,
      details: { studentId: o.studentId, providerPaymentId: paid.id, amount: paid.amount, receiptNo: existing.receiptNo, recordedForOrder: existing.orderId },
    });
    return { status: "mismatch", detail: "This gateway payment is already recorded against another order." };
  }
  if (o.status === "paid" && o.paymentId) {
    await audit(tx, actor, "fees.online_duplicate_payment", {
      schoolId: o.schoolId,
      targetType: "payment_order",
      targetId: o.id,
      details: { studentId: o.studentId, providerPaymentId: paid.id, amount: paid.amount, note: "A second payment arrived for an order that was already paid. Refund it through the payment gateway." },
    });
    return { status: "duplicate", paymentId: o.paymentId, receiptNo: await receiptNoOf(tx, o.paymentId) };
  }
  if (paid.currency !== "INR" || !Number.isSafeInteger(paid.amount) || paid.amount !== o.amount) {
    const detail = `Paid ${paid.amount} ${paid.currency} (paise), expected ${o.amount} INR.`;
    await tx
      .update(paymentOrders)
      .set({ failureReason: `Amount did not match. ${detail}` })
      .where(eq(paymentOrders.id, o.id));
    await audit(tx, actor, "fees.online_amount_mismatch", {
      schoolId: o.schoolId,
      targetType: "payment_order",
      targetId: o.id,
      details: { studentId: o.studentId, providerPaymentId: paid.id, amount: paid.amount, currency: paid.currency, expected: o.amount, detail },
    });
    return { status: "mismatch", detail };
  }

  // The session the chosen lines belong to (the current one if they have since been removed).
  const [line] = o.chargeIds.length ? await tx.select({ sessionId: studentCharges.sessionId }).from(studentCharges).where(inArray(studentCharges.id, o.chargeIds)).limit(1) : [];
  const [current] = line ? [] : await tx.select({ id: academicSessions.id }).from(academicSessions).where(eq(academicSessions.isCurrent, true));
  const sessionId = line?.sessionId ?? current?.id;
  if (!sessionId) throw new Error("No academic session for this payment.");

  const r = await recordPayment(
    tx,
    {
      schoolId: o.schoolId,
      studentId: o.studentId,
      sessionId,
      amount: o.amount,
      method: "online",
      reference: paid.method ? paid.method.slice(0, 40) : null,
      paidOn: paid.paidOn ?? todayIST(),
      chargeIds: o.chargeIds,
      allowExcess: true,
      provider: o.provider,
      providerPaymentId: paid.id,
      orderId: o.id,
    },
    actor,
  );
  await tx.update(paymentOrders).set({ status: "paid", paidAt: new Date(), paymentId: r.id, failureReason: null }).where(eq(paymentOrders.id, o.id));
  return { status: "recorded", paymentId: r.id, receiptNo: r.receiptNo };
}

export type CheckoutResult = { status: "recorded" | "already"; paymentId: string; receiptNo: string };

/**
 * The browser is back from checkout with (payment id, order id, signature).
 * Verify the signature, ask the gateway what was paid, then record it.
 */
export async function completeCheckout(
  input: { orderId: string; studentId: string; providerOrderId: string; providerPaymentId: string; signature: string },
  actor: AuditActor,
): Promise<CheckoutResult> {
  const db = await getDb();
  if (!isUuid(input.orderId)) throw new OrderError("not_found", "Payment not found.");
  const [o] = await db
    .select()
    .from(paymentOrders)
    .where(and(eq(paymentOrders.id, input.orderId), eq(paymentOrders.studentId, input.studentId)));
  if (!o) throw new OrderError("not_found", "Payment not found.");
  if (o.status === "paid" && o.paymentId) return { status: "already", paymentId: o.paymentId, receiptNo: await receiptNoOf(db, o.paymentId) };
  if (o.provider === "mock") assertTestCheckout();

  const gateway = gatewayFor(o.provider);
  let valid = false;
  if (o.providerOrderId && input.providerOrderId === o.providerOrderId && isGatewayId(input.providerPaymentId, "pay_") && /^[0-9a-f]{64}$/i.test(input.signature)) {
    try {
      valid = gateway.verifyCheckoutSignature(o.providerOrderId, input.providerPaymentId, input.signature);
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
    }
  }
  if (!valid) {
    await db.transaction((tx) =>
      audit(tx, actor, "fees.online_signature_invalid", {
        schoolId: o.schoolId,
        targetType: "payment_order",
        targetId: o.id,
        details: { studentId: o.studentId, providerPaymentId: String(input.providerPaymentId).slice(0, 64), amount: o.amount },
      }),
    );
    throw new OrderError(
      "signature",
      "The payment could not be verified, so no receipt was issued. If money was taken from your account, it will be confirmed or refunded automatically.",
    );
  }

  let payment: GatewayPayment;
  try {
    payment = await gateway.fetchPayment(input.providerPaymentId, { providerOrderId: o.providerOrderId!, amount: o.amount });
    if (payment.status === "authorized") payment = await gateway.capturePayment(payment.id, o.amount);
  } catch (err) {
    if (!(err instanceof GatewayError)) throw err;
    throw new OrderError("pending", "Your payment is being confirmed with the bank. It will appear on the Fees page within a few minutes.", o.id);
  }
  if (payment.providerOrderId && payment.providerOrderId !== o.providerOrderId) {
    throw new OrderError("mismatch", "This payment belongs to a different order. No receipt was issued. Please contact the school office.");
  }
  if (payment.status !== "captured") {
    // "created" / "authorized" (capture still on its way): the webhook will finish it. Anything else did not go through.
    if (payment.status === "created" || payment.status === "authorized") {
      throw new OrderError("pending", "Your payment is being confirmed with the bank. It will appear on the Fees page within a few minutes.", o.id);
    }
    throw new OrderError("closed", "The payment did not go through. No money was taken. You can try again.");
  }

  const r = await db.transaction((tx) => confirmOrderPayment(tx, o.id, { id: payment.id, amount: payment.amount, currency: payment.currency, method: payment.method }, actor));
  if (r.status === "mismatch")
    throw new OrderError("mismatch", "The amount paid did not match the fees chosen, so no receipt was issued. The school office has been alerted and will contact you.");
  return { status: r.status === "recorded" ? "recorded" : "already", paymentId: r.paymentId, receiptNo: r.receiptNo };
}

/**
 * The test checkout's "Pay" button. It plays the gateway's part — makes a
 * payment id and signs "order_id|payment_id" with the test key — then hands
 * over to completeCheckout, the same path a Razorpay payment takes.
 */
export async function payWithTestCheckout(input: { orderId: string; studentId: string }, actor: AuditActor): Promise<CheckoutResult> {
  assertTestCheckout();
  const db = await getDb();
  const o = await familyOrder(db, input.orderId, input.studentId);
  if (!o || o.provider !== "mock") throw new OrderError("not_found", "Payment not found.");
  if (o.status === "paid" && o.paymentId) return { status: "already", paymentId: o.paymentId, receiptNo: await receiptNoOf(db, o.paymentId) };
  if (o.status !== "created") throw new OrderError("closed", "This payment was cancelled. Go back to Fees to start again.");
  if (!o.isOpen) throw new OrderError("expired", "This payment timed out after 30 minutes. Go back to Fees to start again.");
  if (!o.providerOrderId) throw new OrderError("closed", "This payment could not be started. Go back to Fees to start again.");
  // The page may be older than the fees: never take more than the fees chosen still need.
  if (o.stale) throw new OrderError("changed", "The fees have changed since this payment was started. Cancel it and start again.");
  const paymentId = mockGateway.newPaymentId();
  const signature = mockGateway.signCheckout(o.providerOrderId, paymentId);
  return completeCheckout({ orderId: o.id, studentId: input.studentId, providerOrderId: o.providerOrderId, providerPaymentId: paymentId, signature }, actor);
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

export type WebhookResult = { status: number; body: Record<string, unknown> };

/**
 * Verify and process one webhook delivery. The event is stored in the same
 * transaction as its effect, so a failure means the gateway retries, and a
 * repeated delivery is acknowledged without doing anything.
 */
export async function handleGatewayWebhook(
  provider: ProviderName,
  rawBody: string,
  signature: string | null,
  eventIdHeader: string | null,
  ip: string | null,
): Promise<WebhookResult> {
  const gateway = gatewayFor(provider);
  if (provider === "mock" && !testPaymentsAllowed()) return { status: 404, body: { error: "Not found" } };
  if (rawBody.length > 512_000) return { status: 413, body: { error: "Body too large" } };
  if (provider === "razorpay" && !process.env.RAZORPAY_WEBHOOK_SECRET?.trim()) return { status: 503, body: { error: "Webhook secret not configured" } };
  if (!gateway.verifyWebhookSignature(rawBody, signature)) return { status: 400, body: { error: "Invalid signature" } };

  let ev: GatewayEvent;
  try {
    ev = gateway.parseWebhook(rawBody, eventIdHeader);
  } catch {
    return { status: 400, body: { error: "Unreadable event" } };
  }
  const actor: AuditActor = { accountId: null, loginId: `${provider} webhook`, ip };
  const db = await getDb();
  return db.transaction(async (tx): Promise<WebhookResult> => {
    const fresh = await tx
      .insert(webhookEvents)
      .values({ id: `${provider}:${ev.id}`.slice(0, 200), provider, type: ev.type.slice(0, 60) })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (!fresh.length) return { status: 200, body: { ok: true, duplicate: true } };

    if (ev.type === "payment.captured" || ev.type === "order.paid") {
      if (!ev.providerOrderId || !ev.paymentId || ev.amount === null) return { status: 200, body: { ok: true, ignored: "missing payment details" } };
      if (ev.type === "payment.captured" && ev.status && ev.status !== "captured") return { status: 200, body: { ok: true, ignored: `payment ${ev.status}` } };
      const [o] = await tx
        .select({ id: paymentOrders.id })
        .from(paymentOrders)
        .where(and(eq(paymentOrders.providerOrderId, ev.providerOrderId), eq(paymentOrders.provider, provider)));
      if (!o) return { status: 200, body: { ok: true, ignored: "unknown order" } };
      const r = await confirmOrderPayment(tx, o.id, { id: ev.paymentId, amount: ev.amount, currency: ev.currency ?? "" }, actor);
      return { status: 200, body: { ok: true, result: r.status } };
    }
    if (ev.type === "payment.failed" && ev.providerOrderId) {
      // Checkout lets the family try again on the same order, so the order stays open; only the reason is kept.
      const hit = await tx
        .update(paymentOrders)
        .set({ failureReason: (ev.error ?? "Payment failed at the gateway").slice(0, 300) })
        .where(and(eq(paymentOrders.providerOrderId, ev.providerOrderId), eq(paymentOrders.provider, provider), eq(paymentOrders.status, "created")))
        .returning({ id: paymentOrders.id, schoolId: paymentOrders.schoolId, studentId: paymentOrders.studentId, amount: paymentOrders.amount });
      if (hit[0]) {
        await audit(tx, actor, "fees.online_attempt_failed", {
          schoolId: hit[0].schoolId,
          targetType: "payment_order",
          targetId: hit[0].id,
          details: { studentId: hit[0].studentId, amount: hit[0].amount, paymentId: ev.paymentId, error: ev.error },
        });
      }
      return { status: 200, body: { ok: true } };
    }
    if (ev.type === "refund.processed") {
      // A refund made in the Razorpay Dashboard: recorded on its payment, once (amount and date as Razorpay signed them).
      if (!ev.refund || ev.refund.status !== "processed") return { status: 200, body: { ok: true, ignored: "missing refund details" } };
      const [p] = await tx
        .select({ id: payments.id, schoolId: payments.schoolId, paidOn: payments.paidOn })
        .from(payments)
        .where(and(eq(payments.providerPaymentId, ev.refund.paymentId), eq(payments.provider, provider)));
      // A payment the portal never recorded (a second payment for a paid order, say) has nothing to take the refund from.
      if (!p) return { status: 200, body: { ok: true, ignored: "unknown payment" } };
      try {
        const r = await recordGatewayRefund(tx, p, ev.refund, actor);
        return { status: 200, body: { ok: true, result: r.status } };
      } catch (err) {
        if (!(err instanceof RefundError)) throw err;
        await audit(tx, actor, "fees.refund_not_recorded", {
          schoolId: p.schoolId,
          targetType: "payment",
          targetId: p.id,
          details: { providerRefundId: ev.refund.id, amount: ev.refund.amount, reason: err.message },
        });
        return { status: 200, body: { ok: true, ignored: "refund not recorded" } };
      }
    }
    return { status: 200, body: { ok: true, ignored: ev.type } };
  });
}

/** Online payment orders for a student, newest first (office view). */
export async function studentOrders(tx: Tx, studentId: string, limit = 10) {
  return tx
    .select({
      id: paymentOrders.id,
      amount: paymentOrders.amount,
      status: paymentOrders.status,
      provider: paymentOrders.provider,
      createdAt: paymentOrders.createdAt,
      failureReason: paymentOrders.failureReason,
      paymentId: paymentOrders.paymentId,
    })
    .from(paymentOrders)
    .where(eq(paymentOrders.studentId, studentId))
    .orderBy(desc(paymentOrders.createdAt))
    .limit(limit);
}
