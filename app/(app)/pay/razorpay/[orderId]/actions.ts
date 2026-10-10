"use server";

import { auditActor } from "@/lib/auth/dal";
import { familyPage } from "@/lib/page";
import { completeCheckout, OrderError } from "@/lib/services/payments";
import { orderErrorText } from "@/components/fees/order-messages";

export type ConfirmResponse = { ok: true; url: string } | { ok: false; message: string; pending: boolean };

/**
 * Razorpay Checkout's handler hands us (payment id, order id, signature).
 * The signature is verified on the server and the payment looked up before
 * anything is recorded; the webhook records it too if this never arrives.
 */
export async function confirmRazorpayAction(orderId: unknown, fields: unknown): Promise<ConfirmResponse> {
  const ctx = await familyPage();
  const f = (fields ?? {}) as Record<string, unknown>;
  const paymentId = f.razorpay_payment_id;
  const providerOrderId = f.razorpay_order_id;
  const signature = f.razorpay_signature;
  if (typeof orderId !== "string" || typeof paymentId !== "string" || typeof providerOrderId !== "string" || typeof signature !== "string") {
    return { ok: false, message: orderErrorText("signature", ctx.t), pending: false };
  }
  try {
    const r = await completeCheckout(
      { orderId, studentId: ctx.studentId, providerOrderId: providerOrderId.slice(0, 64), providerPaymentId: paymentId.slice(0, 64), signature: signature.slice(0, 128) },
      await auditActor(ctx.actor),
    );
    return { ok: true, url: `/my/fees/receipts/${r.paymentId}?paid=1` };
  } catch (err) {
    if (err instanceof OrderError) return { ok: false, message: orderErrorText(err.code, ctx.t), pending: err.code === "pending" };
    throw err;
  }
}
