/**
 * Payment gateways. PAYMENT_PROVIDER picks the one used for new orders
 * ("mock" by default, "razorpay" once AESRI has an account); an existing
 * order is always finished by the gateway that created it.
 */
import { paymentProvider } from "@/lib/env";
import { mockGateway } from "./mock";
import { razorpayGateway } from "./razorpay";
import type { PaymentGateway, ProviderName } from "./types";

export { GatewayError, isGatewayId } from "./types";
export type { GatewayEvent, GatewayPayment, GatewayRefund, PaymentGateway, ProviderName } from "./types";
export { mockGateway } from "./mock";
export { razorpayGateway, razorpayKeyId } from "./razorpay";

export function gatewayFor(name: string): PaymentGateway {
  if (name === "razorpay") return razorpayGateway;
  if (name === "mock") return mockGateway;
  throw new Error(`Unknown payment provider: ${name}`);
}

/** The gateway used for new orders. */
export function activeGateway(): PaymentGateway {
  return gatewayFor(paymentProvider());
}

export function isProviderName(v: string): v is ProviderName {
  return v === "mock" || v === "razorpay";
}
