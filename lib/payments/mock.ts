/**
 * The built-in test checkout ("mock" gateway). No money ever moves.
 *
 * It behaves like Razorpay so the portal's own code is exercised end to end:
 * orders get gateway ids, the checkout returns a payment id with an
 * HMAC-SHA256 signature over "order_id|payment_id", and webhooks carry an
 * HMAC of the raw body. The key is derived from APP_SECRET (mockWebhookKey),
 * so only this server can produce valid signatures.
 */
import crypto from "node:crypto";
import { hmacHex, mockWebhookKey, safeEqualHex } from "@/lib/auth/crypto";
import { parseRazorpayStyleEvent, type GatewayPayment, type GatewayRefund, type PaymentGateway } from "./types";

const hex = (bytes: number) => crypto.randomBytes(bytes).toString("hex");

export const mockGateway: PaymentGateway & {
  newPaymentId(): string;
  signCheckout(providerOrderId: string, paymentId: string): string;
  signWebhook(rawBody: string): string;
} = {
  name: "mock",
  label: "Test checkout (no money moves)",

  isConfigured: () => true,

  async createOrder({ amount }) {
    return { providerOrderId: `order_mock${hex(8)}`, amount, currency: "INR" };
  },

  newPaymentId: () => `pay_mock${hex(8)}`,

  /** What the test gateway returns to the browser after "Pay" (Razorpay's formula, mock key). */
  signCheckout: (providerOrderId, paymentId) => hmacHex(mockWebhookKey(), `${providerOrderId}|${paymentId}`),

  verifyCheckoutSignature(providerOrderId, paymentId, signature) {
    return safeEqualHex(hmacHex(mockWebhookKey(), `${providerOrderId}|${paymentId}`), signature);
  },

  /** The test gateway always charges exactly the order amount, and captures at once. */
  async fetchPayment(paymentId, order): Promise<GatewayPayment> {
    return { id: paymentId, providerOrderId: order.providerOrderId, amount: order.amount, currency: "INR", status: "captured", method: "test", createdAt: new Date(), amountRefunded: 0 };
  },

  /** Nothing to find: a test payment is recorded the moment "Pay" is pressed. */
  async fetchOrderPayments(): Promise<GatewayPayment[]> {
    return [];
  },

  /** No money moved, so there is nothing to refund. */
  async fetchRefunds(): Promise<GatewayRefund[]> {
    return [];
  },

  async capturePayment(paymentId, amount): Promise<GatewayPayment> {
    return { id: paymentId, providerOrderId: null, amount, currency: "INR", status: "captured", method: "test", createdAt: new Date(), amountRefunded: 0 };
  },

  signWebhook: (rawBody) => hmacHex(mockWebhookKey(), rawBody),

  verifyWebhookSignature(rawBody, signature) {
    if (!signature) return false;
    return safeEqualHex(hmacHex(mockWebhookKey(), rawBody), signature);
  },

  parseWebhook: parseRazorpayStyleEvent,
};
