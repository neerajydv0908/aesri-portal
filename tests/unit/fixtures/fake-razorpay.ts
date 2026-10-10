/**
 * A stand-in for Razorpay's API on 127.0.0.1, for the unit tests: the
 * payments of an order and the refunds of a payment, as Razorpay lists them.
 * Point the portal at it with RAZORPAY_API_URL (ignored on production servers).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_KEYS = { keyId: "rzp_test_unitfake", keySecret: "unit-test-secret", webhookSecret: "unit-test-webhook-secret" };

export type FakeRazorpay = {
  url: string;
  /** Payments by Razorpay order id (Razorpay's payment entities). */
  orders: Map<string, Record<string, unknown>[]>;
  /** Refunds by Razorpay payment id (Razorpay's refund entities). */
  refunds: Map<string, Record<string, unknown>[]>;
  /** Every request, as "GET /v1/…". */
  requests: string[];
  /** Answer the next N requests with a server error. */
  failNext: number;
  close(): Promise<void>;
};

export async function startFakeRazorpay(): Promise<FakeRazorpay> {
  const state = { orders: new Map(), refunds: new Map(), requests: [] as string[], failNext: 0 } as Omit<FakeRazorpay, "url" | "close">;
  const expectedAuth = `Basic ${Buffer.from(`${FAKE_KEYS.keyId}:${FAKE_KEYS.keySecret}`).toString("base64")}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    state.requests.push(`${req.method} ${url.pathname}`);
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== expectedAuth) return send(401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } });
    if (state.failNext > 0) {
      state.failNext--;
      return send(500, { error: { code: "SERVER_ERROR", description: "We are facing some trouble completing your request at the moment." } });
    }
    const list = (items: unknown[]) => send(200, { entity: "collection", count: items.length, items });
    let m = /^\/v1\/orders\/(order_[A-Za-z0-9]+)\/payments$/.exec(url.pathname);
    if (m && req.method === "GET") return list(state.orders.get(m[1]) ?? []);
    m = /^\/v1\/payments\/(pay_[A-Za-z0-9]+)\/refunds$/.exec(url.pathname);
    if (m && req.method === "GET") return list(state.refunds.get(m[1]) ?? []);
    send(404, { error: { code: "BAD_REQUEST_ERROR", description: "The requested URL was not found on the server." } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

/** Seconds since 1970, as Razorpay writes times. */
export const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** A Razorpay payment entity. */
export function rpPayment(id: string, orderId: string, amount: number, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, entity: "payment", amount, currency: "INR", status, order_id: orderId, method: "upi", amount_refunded: 0, captured: status === "captured", created_at: unix(new Date()), ...extra };
}

/** A Razorpay refund entity. */
export function rpRefund(id: string, paymentId: string, amount: number, status = "processed", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, entity: "refund", amount, currency: "INR", payment_id: paymentId, notes: {}, receipt: null, status, speed_processed: "normal", created_at: unix(new Date()), ...extra };
}
