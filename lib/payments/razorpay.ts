/**
 * Razorpay Standard Checkout (https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/).
 *
 *   1. The server creates an order: POST /v1/orders (Basic auth key_id:key_secret),
 *      amount in paise, currency INR, receipt = the portal's order id.
 *   2. The pay page opens checkout.js with that order_id.
 *   3. Checkout's handler returns razorpay_payment_id, razorpay_order_id and
 *      razorpay_signature = HMAC-SHA256(order_id + "|" + payment_id, key_secret),
 *      which the server verifies before looking the payment up and recording it.
 *   4. Webhooks (payment.captured, order.paid, refund.processed) are verified
 *      with HMAC-SHA256(raw body, RAZORPAY_WEBHOOK_SECRET) and recorded idempotently.
 *   5. The Razorpay check (lib/services/payment-check.ts) asks GET
 *      /v1/orders/{id}/payments about unfinished orders, in case both the
 *      browser and the webhook were lost; GET /v1/payments/{id}/refunds lists
 *      the refunds made in the Razorpay Dashboard, so the office can record them.
 *
 * Environment: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET.
 * RAZORPAY_API_URL points the portal at a stand-in for Razorpay in the unit
 * tests; a production server ignores it and always talks to Razorpay.
 */
import { hmacHex, safeEqualHex } from "@/lib/auth/crypto";
import { GatewayError, isGatewayId, parseRazorpayStyleEvent, readRefund, unixDate, type GatewayPayment, type GatewayRefund, type PaymentGateway } from "./types";

const apiBase = () => {
  const standIn = process.env.NODE_ENV === "production" ? "" : process.env.RAZORPAY_API_URL?.trim();
  return (standIn || "https://api.razorpay.com").replace(/\/+$/, "");
};

function keys() {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) throw new GatewayError("Razorpay keys are not set (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET).");
  return { keyId, keySecret };
}

/** The public key id, given to checkout.js in the browser. */
export function razorpayKeyId(): string | null {
  return process.env.RAZORPAY_KEY_ID?.trim() || null;
}

type RazorpayError = { error?: { code?: string; description?: string } };

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const { keyId, keySecret } = keys();
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new GatewayError(`Could not reach Razorpay (${err instanceof Error ? err.message : "network error"}).`);
  }
  const json = (await res.json().catch(() => null)) as (T & RazorpayError) | null;
  if (!res.ok || !json) {
    throw new GatewayError(`Razorpay refused ${method} ${path.replace(/\/(pay|order|rfnd)_[A-Za-z0-9]+/g, "/…")}: ${res.status} ${json?.error?.description ?? ""}`.trim());
  }
  return json;
}

type RpPayment = {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: string;
  method?: string | null;
  created_at?: number;
  amount_refunded?: number;
};

function toPayment(p: RpPayment): GatewayPayment {
  return {
    id: p.id,
    providerOrderId: p.order_id ?? null,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    method: p.method ?? null,
    createdAt: unixDate(p.created_at),
    amountRefunded: Number.isSafeInteger(p.amount_refunded) && (p.amount_refunded ?? 0) > 0 ? p.amount_refunded! : 0,
  };
}

/** One payment from a list, checked before it is used (null when malformed). */
function readPayment(v: unknown): GatewayPayment | null {
  const p = (v ?? {}) as Partial<RpPayment>;
  if (!isGatewayId(p.id, "pay_") || (p.order_id != null && !isGatewayId(p.order_id, "order_"))) return null;
  if (typeof p.amount !== "number" || !Number.isSafeInteger(p.amount) || typeof p.currency !== "string" || typeof p.status !== "string") return null;
  return toPayment({ ...p, method: typeof p.method === "string" ? p.method.slice(0, 40) : null } as RpPayment);
}

type RpList = { items?: unknown };
const itemsOf = (list: RpList): unknown[] => (Array.isArray(list.items) ? list.items : []);

export const razorpayGateway: PaymentGateway = {
  name: "razorpay",
  label: "Razorpay",

  isConfigured: () => Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim()),

  async createOrder({ orderId, amount, notes }) {
    const order = await call<{ id: string; amount: number; currency: string; status: string }>("POST", "/v1/orders", {
      amount,
      currency: "INR",
      receipt: orderId, // the portal's order id (36 characters; Razorpay allows 40)
      notes,
    });
    if (!isGatewayId(order.id, "order_")) throw new GatewayError("Razorpay returned an order id in an unexpected format.");
    if (order.amount !== amount || order.currency !== "INR") throw new GatewayError("Razorpay created the order with a different amount.");
    return { providerOrderId: order.id, amount: order.amount, currency: order.currency };
  },

  verifyCheckoutSignature(providerOrderId, paymentId, signature) {
    const { keySecret } = keys();
    return safeEqualHex(hmacHex(keySecret, `${providerOrderId}|${paymentId}`), signature);
  },

  async fetchPayment(paymentId) {
    if (!isGatewayId(paymentId, "pay_")) throw new GatewayError("Not a Razorpay payment id.");
    return toPayment(await call<RpPayment>("GET", `/v1/payments/${paymentId}`));
  },

  async fetchOrderPayments(providerOrderId) {
    if (!isGatewayId(providerOrderId, "order_")) throw new GatewayError("Not a Razorpay order id.");
    const list = await call<RpList>("GET", `/v1/orders/${providerOrderId}/payments`);
    // Only this order's payments, however the list comes back.
    return itemsOf(list)
      .map(readPayment)
      .filter((p): p is GatewayPayment => !!p && (p.providerOrderId === null || p.providerOrderId === providerOrderId))
      .map((p) => ({ ...p, providerOrderId }));
  },

  async fetchRefunds(paymentId) {
    if (!isGatewayId(paymentId, "pay_")) throw new GatewayError("Not a Razorpay payment id.");
    const list = await call<RpList>("GET", `/v1/payments/${paymentId}/refunds?count=100`);
    return itemsOf(list)
      .map((r) => readRefund((r ?? null) as Record<string, unknown> | null))
      .filter((r): r is GatewayRefund => !!r && r.paymentId === paymentId);
  },

  async capturePayment(paymentId, amount) {
    if (!isGatewayId(paymentId, "pay_")) throw new GatewayError("Not a Razorpay payment id.");
    return toPayment(await call<RpPayment>("POST", `/v1/payments/${paymentId}/capture`, { amount, currency: "INR" }));
  },

  verifyWebhookSignature(rawBody, signature) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
    if (!secret || !signature) return false;
    return safeEqualHex(hmacHex(secret, rawBody), signature.trim());
  },

  parseWebhook: parseRazorpayStyleEvent,
};
