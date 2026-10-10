"use server";

import { redirect } from "next/navigation";
import { auditActor } from "@/lib/auth/dal";
import { getDb } from "@/lib/db/client";
import { testPaymentsAllowed } from "@/lib/env";
import { familyPage } from "@/lib/page";
import { fail, type FormState } from "@/lib/forms";
import { closeOrder, OrderError, payWithTestCheckout, type CheckoutResult } from "@/lib/services/payments";
import { orderErrorText } from "@/components/fees/order-messages";

/**
 * Test checkout "Pay": signs the result like the gateway would and sends it
 * through the same verification and recording path as a Razorpay payment.
 * Pressing it twice (or in two tabs) returns the same receipt. Refused
 * wherever the test checkout is switched off (payWithTestCheckout checks too).
 */
export async function mockPayAction(orderId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const ctx = await familyPage();
  if (!testPaymentsAllowed()) return fail(orderErrorText("unavailable", ctx.t));
  let r: CheckoutResult;
  try {
    r = await payWithTestCheckout({ orderId, studentId: ctx.studentId }, await auditActor(ctx.actor));
  } catch (err) {
    if (err instanceof OrderError) return fail(orderErrorText(err.code, ctx.t));
    throw err;
  }
  redirect(`/my/fees/receipts/${r.paymentId}?paid=1`);
}

/** Test checkout "Fail": the payment is marked as not completed; no money moves. */
export async function mockFailAction(orderId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const ctx = await familyPage();
  if (!testPaymentsAllowed()) return fail(orderErrorText("unavailable", ctx.t));
  const db = await getDb();
  const who = await auditActor(ctx.actor);
  let closed: { state: "closed" | "paid"; paymentId: string | null };
  try {
    closed = await db.transaction((tx) => closeOrder(tx, { orderId, studentId: ctx.studentId, outcome: "failed", reason: "Payment failed at the test checkout" }, who));
  } catch (err) {
    if (err instanceof OrderError) return fail(orderErrorText(err.code, ctx.t));
    throw err;
  }
  // Paid in another tab meanwhile: show the receipt rather than a "cancelled" message.
  if (closed.state === "paid" && closed.paymentId) redirect(`/my/fees/receipts/${closed.paymentId}`);
  redirect("/my/fees?payment=failed");
}
