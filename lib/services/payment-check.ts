/**
 * The Razorpay check: online payments that never got a receipt.
 *
 * A payment is normally recorded twice over: when the family's browser comes
 * back from checkout, and when Razorpay's webhook arrives. If both are lost
 * (the phone closed, the webhook not set up or the server down while
 * Razorpay retried), the money has been taken but there is no receipt. So
 * every 10 minutes each portal server asks Razorpay about recent unfinished
 * orders (GET /v1/orders/{id}/payments) and records what it finds:
 *
 *   - captured payments are recorded exactly as the webhook would record them
 *     (confirmOrderPayment: once per payment, the amount must match), with the
 *     receipt dated the day the family paid; the family gets the usual text
 *     message with the receipt number;
 *   - authorised payments (not captured yet) are left alone: Razorpay
 *     captures them automatically (then the next check records them), or
 *     gives the money back to the family by itself;
 *   - a payment Razorpay has already refunded in full is not recorded (no
 *     money stayed with the school); the order says so, for the office;
 *   - a captured payment with part of it refunded is recorded, then its refunds.
 *
 * Which orders: Razorpay orders not paid (open, timed out or cancelled), at
 * least 5 minutes old (the browser and the webhook come first) and at most
 * 7 days old. Young orders are checked at every pass, older ones less often:
 * hourly after their first hour, daily after their first day. Each order is
 * claimed (checked_at) before Razorpay is asked, so two servers never ask
 * about the same order at the same moment, and no database transaction is
 * held open while Razorpay answers.
 *
 * The office can also check one student's unfinished payments at once
 * ("Check with Razorpay" on the student's fee page). PAYMENTS_CHECK=off stops
 * the automatic check on a server (for example when a scheduled
 * `npm run payments:check` does it instead).
 */
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { paymentOrders } from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { todayIST } from "@/lib/dates";
import { GatewayError, razorpayGateway, type GatewayPayment } from "@/lib/payments";
import { confirmOrderPayment } from "./payments";
import { syncGatewayRefunds } from "./refunds";

export const CHECK = {
  /** The browser and the webhook come first. */
  minAgeMinutes: 5,
  /** Older orders aren't asked about any more (Razorpay settles a payment long before). */
  maxAgeDays: 7,
  /** How often each server runs a pass. */
  everyMinutes: 10,
  /** At most this many orders are asked about in one pass. */
  perPass: 100,
} as const;

/** The actor named in the activity log for what the automatic check records. */
export const CHECK_ACTOR: AuditActor = { accountId: null, loginId: "Razorpay check", ip: null };

const MIN = 60_000;

type OrderRow = typeof paymentOrders.$inferSelect;

/**
 * Is this order due to be asked about again? Every pass in its first hour,
 * then hourly, then daily (a little early, so the timer's drift never skips a turn).
 */
export function dueForCheck(o: Pick<OrderRow, "createdAt" | "checkedAt">, now: Date): boolean {
  if (!o.checkedAt) return true;
  const age = now.getTime() - o.createdAt.getTime();
  const gap = age < 60 * MIN ? (CHECK.everyMinutes - 1) * MIN : age < 24 * 60 * MIN ? 55 * MIN : 23 * 60 * MIN;
  return now.getTime() - o.checkedAt.getTime() >= gap;
}

/** Claim an order for checking: only one server (or pass) gets it, until it is due again. */
async function claim(o: Pick<OrderRow, "id" | "checkedAt">, now: Date): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(paymentOrders)
    .set({ checkedAt: now })
    .where(
      and(
        eq(paymentOrders.id, o.id),
        // Unchanged since it was read (to the millisecond, as JavaScript keeps it): no other server claimed it meanwhile.
        o.checkedAt ? sql`date_trunc('milliseconds', ${paymentOrders.checkedAt}) = ${o.checkedAt.toISOString()}::timestamptz` : isNull(paymentOrders.checkedAt),
        sql`${paymentOrders.status} <> 'paid'`,
      ),
    )
    .returning({ id: paymentOrders.id });
  return rows.length === 1;
}

export type CheckSummary = {
  /** Orders asked about. */
  orders: number;
  /** Payments found and recorded now, each with its receipt. */
  recorded: { orderId: string; studentId: string; paymentId: string; receiptNo: string; amount: number }[];
  /** Authorised at Razorpay but not captured yet. */
  waiting: number;
  /** Paid and then refunded in full at Razorpay: nothing to record. */
  refundedThere: number;
  /** Found, but not recorded: an amount that didn't match, or a second payment for a paid order (see the activity log). */
  problems: number;
  /** Orders Razorpay couldn't be asked about this time (they are tried again later). */
  errors: number;
};

const emptySummary = (): CheckSummary => ({ orders: 0, recorded: [], waiting: 0, refundedThere: 0, problems: 0, errors: 0 });

/** The day the family paid, in India (today when Razorpay didn't say, never in the future). */
function paidOnOf(p: GatewayPayment, now: Date): string {
  const today = todayIST(now);
  const day = p.createdAt ? todayIST(p.createdAt) : today;
  return day > today ? today : day;
}

const REFUNDED_THERE = "Paid, then refunded in full at Razorpay: nothing to record.";

/** Ask Razorpay about one order and record what it finds (see the top of this file). */
async function checkOrder(o: OrderRow, actor: AuditActor, now: Date, out: CheckSummary): Promise<void> {
  out.orders++;
  let found: GatewayPayment[];
  try {
    found = await razorpayGateway.fetchOrderPayments(o.providerOrderId!);
  } catch (err) {
    if (!(err instanceof GatewayError)) throw err;
    out.errors++;
    return;
  }
  const db = await getDb();
  found.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  for (const p of found) {
    if (p.status === "authorized") {
      out.waiting++;
      continue;
    }
    if (p.status === "refunded") {
      out.refundedThere++;
      // Said once on the order (the office sees it under "Online payment attempts"), and once in the activity log.
      await db.transaction(async (tx) => {
        const hit = await tx
          .update(paymentOrders)
          .set({ failureReason: REFUNDED_THERE })
          .where(and(eq(paymentOrders.id, o.id), sql`${paymentOrders.status} <> 'paid'`, sql`${paymentOrders.failureReason} is distinct from ${REFUNDED_THERE}`))
          .returning({ id: paymentOrders.id });
        if (hit.length) {
          await audit(tx, actor, "fees.online_refunded_at_gateway", {
            schoolId: o.schoolId,
            targetType: "payment_order",
            targetId: o.id,
            details: { studentId: o.studentId, providerPaymentId: p.id, amount: p.amount },
          });
        }
      });
      continue;
    }
    if (p.status !== "captured") continue; // "created" or "failed": no money was taken

    const r = await db.transaction((tx) =>
      confirmOrderPayment(tx, o.id, { id: p.id, amount: p.amount, currency: p.currency, method: p.method, paidOn: paidOnOf(p, now) }, actor),
    );
    if (r.status === "recorded") {
      out.recorded.push({ orderId: o.id, studentId: o.studentId, paymentId: r.paymentId, receiptNo: r.receiptNo, amount: p.amount });
      if (p.amountRefunded > 0) {
        try {
          await syncGatewayRefunds({ schoolId: o.schoolId, paymentId: r.paymentId }, actor);
        } catch (err) {
          // The receipt stands; its refunds are recorded by the webhook or the office's button later.
          if (!(err instanceof GatewayError)) throw err;
          out.errors++;
        }
      }
    } else if (r.status === "duplicate" || r.status === "mismatch") {
      out.problems++;
    }
  }
}

/** What makes an order one that might hold a payment without a receipt. */
const unfinished = () =>
  and(eq(paymentOrders.provider, "razorpay"), inArray(paymentOrders.status, ["created", "expired", "failed"]), isNotNull(paymentOrders.providerOrderId));

/**
 * The automatic pass's orders: only those due now (the same rule as
 * dueForCheck, worked out by the database, so orders that aren't due never
 * take a place), orders in their first hour first, then the ones never asked
 * about, then those asked about longest ago.
 */
async function dueOrders(now: Date, limit: number): Promise<OrderRow[]> {
  const db = await getDb();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * MIN);
  const firstHour = ago(60);
  const firstDay = ago(24 * 60);
  const due = or(
    isNull(paymentOrders.checkedAt),
    and(gt(paymentOrders.createdAt, firstHour), lte(paymentOrders.checkedAt, ago(CHECK.everyMinutes - 1))),
    and(lte(paymentOrders.createdAt, firstHour), gt(paymentOrders.createdAt, firstDay), lte(paymentOrders.checkedAt, ago(55))),
    and(lte(paymentOrders.createdAt, firstDay), lte(paymentOrders.checkedAt, ago(23 * 60))),
  );
  return db
    .select()
    .from(paymentOrders)
    .where(and(unfinished(), gte(paymentOrders.createdAt, ago(CHECK.maxAgeDays * 24 * 60)), lte(paymentOrders.createdAt, ago(CHECK.minAgeMinutes)), due))
    .orderBy(
      sql`case when ${paymentOrders.createdAt} > ${firstHour.toISOString()}::timestamptz then 0 else 1 end`,
      sql`${paymentOrders.checkedAt} asc nulls first`,
      desc(paymentOrders.createdAt),
    )
    .limit(limit);
}

/** A student's unfinished Razorpay orders, newest first (the office's "Check with Razorpay"). */
async function unfinishedOrders(where: { studentId: string; schoolId: string; createdAfter: Date; createdBefore: Date; limit: number }): Promise<OrderRow[]> {
  const db = await getDb();
  return db
    .select()
    .from(paymentOrders)
    .where(
      and(
        unfinished(),
        gte(paymentOrders.createdAt, where.createdAfter),
        lte(paymentOrders.createdAt, where.createdBefore),
        eq(paymentOrders.studentId, where.studentId),
        eq(paymentOrders.schoolId, where.schoolId),
      ),
    )
    .orderBy(desc(paymentOrders.createdAt))
    .limit(where.limit);
}

/**
 * One pass of the automatic check (every 10 minutes on each server, or
 * `npm run payments:check`). Does nothing without Razorpay keys.
 */
export async function checkUnfinishedOrders(now = new Date(), opts: { perPass?: number } = {}): Promise<CheckSummary> {
  const out = emptySummary();
  if (!razorpayGateway.isConfigured()) return out;
  for (const o of await dueOrders(now, opts.perPass ?? CHECK.perPass)) {
    // Claimed first: another server (or pass) that got there meanwhile has it.
    if (!dueForCheck(o, now) || !(await claim(o, now))) continue;
    await checkOrder(o, CHECK_ACTOR, now, out);
  }
  return out;
}

/**
 * "Check with Razorpay" on a student's fee page: ask at once about this
 * student's unfinished Razorpay orders of the last 30 days (at most 10),
 * whatever their age or last check. Recorded in the activity log.
 */
export async function checkStudentOrders(input: { schoolId: string; studentId: string }, actor: AuditActor, now = new Date()): Promise<CheckSummary> {
  const out = emptySummary();
  if (!razorpayGateway.isConfigured()) return out;
  const orders = await unfinishedOrders({
    studentId: input.studentId,
    schoolId: input.schoolId,
    createdAfter: new Date(now.getTime() - 30 * 24 * 60 * MIN),
    createdBefore: now,
    limit: 10,
  });
  const db = await getDb();
  for (const o of orders) {
    await db.update(paymentOrders).set({ checkedAt: now }).where(eq(paymentOrders.id, o.id));
    await checkOrder(o, actor, now, out);
  }
  await db.transaction((tx) =>
    audit(tx, actor, "fees.online_checked", {
      schoolId: input.schoolId,
      targetType: "student",
      targetId: input.studentId,
      details: { studentId: input.studentId, orders: out.orders, recorded: out.recorded.length, waiting: out.waiting, refundedThere: out.refundedThere, problems: out.problems, errors: out.errors },
    }),
  );
  return out;
}

/* ------------------------------------------------------------------ */
/* The timer (started from instrumentation-node.ts)                    */
/* ------------------------------------------------------------------ */

const g = globalThis as unknown as { __aesriPaymentsCheck?: { timer: ReturnType<typeof setInterval>; running: boolean } };

/** A line for the server log, or null when the pass found nothing worth saying. */
export function checkSummaryText(s: CheckSummary): string | null {
  const parts = [
    s.recorded.length ? `${s.recorded.length} payment${s.recorded.length === 1 ? "" : "s"} without a receipt recorded (${s.recorded.map((r) => r.receiptNo).join(", ")})` : "",
    s.waiting ? `${s.waiting} authorised, waiting for Razorpay to capture` : "",
    s.refundedThere ? `${s.refundedThere} already refunded at Razorpay` : "",
    s.problems ? `${s.problems} not recorded (see the activity log)` : "",
    s.errors ? `Razorpay couldn't be asked about ${s.errors} order${s.errors === 1 ? "" : "s"} (tried again later)` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

/** Start the automatic check on this server (once). Never allowed to stop the server. */
export function startPaymentsCheck(): void {
  if (g.__aesriPaymentsCheck) return;
  const state = { timer: undefined as unknown as ReturnType<typeof setInterval>, running: false };
  const tick = async () => {
    if (state.running || !razorpayGateway.isConfigured()) return;
    state.running = true;
    try {
      const said = checkSummaryText(await checkUnfinishedOrders());
      if (said) console.info(`[payments] ${said}`);
    } catch (err) {
      console.error(`[payments] The Razorpay check stopped a pass: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      state.running = false;
    }
  };
  state.timer = setInterval(tick, CHECK.everyMinutes * MIN);
  state.timer.unref?.();
  setTimeout(tick, MIN).unref?.();
  g.__aesriPaymentsCheck = state;
  if (razorpayGateway.isConfigured()) console.info(`[payments] Razorpay check started (every ${CHECK.everyMinutes} minutes).`);
}
