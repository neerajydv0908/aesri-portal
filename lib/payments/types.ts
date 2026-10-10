/**
 * The contract every payment gateway implements. Amounts are in paise.
 *
 * The portal never trusts an amount from the browser: orders are created on
 * the server from the chosen fee lines, and a payment is recorded only after
 * the gateway's signature has been verified and the paid amount matches the
 * order amount.
 */

export type ProviderName = "mock" | "razorpay";

export class GatewayError extends Error {}

export type GatewayOrder = { providerOrderId: string; amount: number; currency: string };

export type GatewayPayment = {
  id: string;
  providerOrderId: string | null;
  amount: number;
  currency: string;
  /** "created" | "authorized" | "captured" | "refunded" | "failed" (Razorpay's words). */
  status: string;
  method: string | null;
  /** When the family paid (null when the gateway didn't say). */
  createdAt: Date | null;
  /** Paise already refunded on this payment at the gateway. */
  amountRefunded: number;
};

/** A refund made at the gateway (Razorpay Dashboard or API). */
export type GatewayRefund = {
  id: string;
  paymentId: string;
  amount: number;
  currency: string;
  /** "pending" | "processed" | "failed" (Razorpay's words). Only "processed" refunds are recorded. */
  status: string;
  createdAt: Date | null;
};

/** A webhook delivery, reduced to what the portal needs. */
export type GatewayEvent = {
  /** Unique per event (used to ignore duplicate deliveries). */
  id: string;
  type: string;
  paymentId: string | null;
  providerOrderId: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  error: string | null;
  /** Refund events (refund.processed): the refund, as the gateway signed it. */
  refund: GatewayRefund | null;
};

export interface PaymentGateway {
  name: ProviderName;
  /** Shown to staff, e.g. on receipts: "Razorpay". */
  label: string;
  /** Keys present, so orders can be created. */
  isConfigured(): boolean;
  createOrder(input: { orderId: string; amount: number; notes: Record<string, string> }): Promise<GatewayOrder>;
  /** Checkout's handler signature: HMAC-SHA256(order_id + "|" + payment_id). */
  verifyCheckoutSignature(providerOrderId: string, paymentId: string, signature: string): boolean;
  /** The payment as the gateway sees it (amount, status, order). */
  fetchPayment(paymentId: string, order: { providerOrderId: string; amount: number }): Promise<GatewayPayment>;
  /** Every payment attempt on one of the gateway's orders (to find payments that never got a receipt). */
  fetchOrderPayments(providerOrderId: string): Promise<GatewayPayment[]>;
  /** The refunds made on a payment. */
  fetchRefunds(paymentId: string): Promise<GatewayRefund[]>;
  /** Capture an authorised payment (only needed when auto-capture is off). */
  capturePayment(paymentId: string, amount: number): Promise<GatewayPayment>;
  /** Webhook signature: HMAC-SHA256 of the raw body. */
  verifyWebhookSignature(rawBody: string, signature: string | null): boolean;
  parseWebhook(rawBody: string, eventIdHeader: string | null): GatewayEvent;
}

/** Razorpay-style ids: a prefix and letters/digits only (safe to put in a URL path). */
export function isGatewayId(value: unknown, prefix: "pay_" | "order_" | "rfnd_"): value is string {
  return typeof value === "string" && value.length <= 64 && new RegExp(`^${prefix}[A-Za-z0-9]{6,58}$`).test(value);
}

/** A Unix time in seconds (as Razorpay sends it) as a Date, or null. */
export function unixDate(v: unknown): Date | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? new Date(v * 1000) : null;
}

/** A Razorpay-format refund entity, checked; null when anything is missing or malformed. */
export function readRefund(r: Record<string, unknown> | null | undefined): GatewayRefund | null {
  if (!r) return null;
  const { id, payment_id: paymentId, amount, currency, status } = r;
  if (!isGatewayId(id, "rfnd_") || !isGatewayId(paymentId, "pay_")) return null;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) return null;
  if (typeof currency !== "string" || typeof status !== "string" || status.length > 40) return null;
  return { id, paymentId, amount, currency, status, createdAt: unixDate(r.created_at) };
}

/**
 * Read a Razorpay-format webhook body (the mock gateway uses the same shape):
 * { event, payload: { payment: { entity }, order: { entity }, refund: { entity } } }.
 */
export function parseRazorpayStyleEvent(rawBody: string, eventIdHeader: string | null): GatewayEvent {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new GatewayError("The webhook body is not valid JSON.");
  }
  type Entity = { entity?: Record<string, unknown> };
  const b = (body ?? {}) as { event?: unknown; payload?: { payment?: Entity; order?: Entity; refund?: Entity } };
  const type = typeof b.event === "string" ? b.event : "unknown";
  const pay = b.payload?.payment?.entity ?? null;
  const ord = b.payload?.order?.entity ?? null;
  const str = (v: unknown) => (typeof v === "string" && v.length <= 200 ? v : null);
  const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
  const refund = readRefund(b.payload?.refund?.entity);
  const paymentId = str(pay?.id) ?? refund?.paymentId ?? null;
  const providerOrderId = str(pay?.order_id) ?? str(ord?.id);
  const headerId = eventIdHeader && eventIdHeader.length <= 100 ? eventIdHeader : null;
  return {
    id: headerId ?? `${type}:${refund?.id ?? paymentId ?? providerOrderId ?? "none"}`,
    type,
    paymentId,
    providerOrderId,
    amount: int(pay?.amount),
    currency: str(pay?.currency),
    status: str(pay?.status),
    error: str(pay?.error_description),
    refund,
  };
}
