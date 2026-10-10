"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { auditActor } from "@/lib/auth/dal";
import { getDb } from "@/lib/db/client";
import { familyPage } from "@/lib/page";
import { fail, type FormState } from "@/lib/forms";
import { cleanText, parseDate, str } from "@/lib/validation";
import { parseRupees, type FamilyChoice } from "@/lib/services/fees";
import { closeOrder, createPaymentOrder, OrderError } from "@/lib/services/payments";
import { CASH_CLAIM_LIMITS, ClaimError, recordCashClaim, withdrawCashClaim } from "@/lib/services/cash-claims";
import { claimErrorText, orderErrorText } from "@/components/fees/order-messages";
import { failKeeping } from "@/components/fees/remember";

/**
 * "Pay fees": the family sends what to pay — the admission fee (yes or no)
 * and an amount of tuition — and how: online now, or cash already handed
 * over at the school. The server works out again what this child can pay
 * and checks the choice; the browser never decides an amount.
 */
export async function payAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await familyPage();
  const { t } = ctx;
  const how = str(formData, "how") === "cash" ? "cash" : "online";
  const raw = str(formData, "tuition");
  const tuition = raw ? parseRupees(raw) : 0;
  if (tuition === null) {
    const msg = t("Write the tuition amount in rupees, for example 5000.", "ट्यूशन फ़ीस की राशि रुपयों में लिखें, जैसे 5000।");
    return failKeeping(formData, msg, { tuition: msg });
  }
  const choice: FamilyChoice = { admission: str(formData, "admission") === "1", tuition };
  const who = await auditActor(ctx.actor);

  if (how === "online") {
    let started: { orderId: string; provider: string };
    try {
      started = await createPaymentOrder({ schoolId: ctx.schoolId, studentId: ctx.studentId, sessionId: ctx.sessionId, choice }, who);
    } catch (err) {
      if (err instanceof OrderError) {
        if (err.code === "not_due" || err.code === "open_order") refresh();
        const msg = orderErrorText(err.code, t, err.limits);
        return failKeeping(formData, msg, err.code === "amount_small" || err.code === "amount_large" ? { tuition: msg } : undefined);
      }
      throw err;
    }
    redirect(`/pay/${started.provider}/${started.orderId}`);
  }

  const paidOn = parseDate(str(formData, "paidOn"));
  if (!paidOn || paidOn === "invalid") {
    const msg = t("Enter the date you paid.", "भुगतान की तारीख लिखें।");
    return failKeeping(formData, msg, { paidOn: msg });
  }
  const db = await getDb();
  let repeated = false;
  try {
    ({ repeated } = await db.transaction((tx) =>
      recordCashClaim(
        tx,
        { schoolId: ctx.schoolId, studentId: ctx.studentId, sessionId: ctx.sessionId, choice, paidOn, note: cleanText(formData.get("note"), CASH_CLAIM_LIMITS.note) },
        who,
      ),
    ));
  } catch (err) {
    if (err instanceof ClaimError) {
      if (err.code === "admission_gone" || err.code === "tuition_gone" || err.code === "open_order") refresh();
      const msg = claimErrorText(err.code, t, err.limits);
      const field = err.code === "tuition_small" || err.code === "tuition_large" ? "tuition" : err.code === "date" ? "paidOn" : null;
      return failKeeping(formData, msg, field ? { [field]: msg } : undefined);
    }
    throw err;
  }
  // Sent twice (a double tap, or the form sent again): the first record stands, and the page says so.
  redirect(`/my/fees?done=${repeated ? "cash_again" : "cash"}#cash-records`);
}

/** Remove a recorded cash payment that is still waiting (typed by mistake). */
export async function withdrawCashAction(claimId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const ctx = await familyPage();
  const db = await getDb();
  const who = await auditActor(ctx.actor);
  try {
    await db.transaction((tx) => withdrawCashClaim(tx, { claimId, studentId: ctx.studentId, schoolId: ctx.schoolId }, who));
  } catch (err) {
    if (err instanceof ClaimError) {
      refresh();
      return fail(claimErrorText(err.code, ctx.t));
    }
    throw err;
  }
  redirect("/my/fees?done=removed#cash-records");
}

/** Cancel an unfinished online payment (so another can be started). */
export async function cancelOrderAction(orderId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const ctx = await familyPage();
  const db = await getDb();
  const who = await auditActor(ctx.actor);
  let closed: { state: "closed" | "paid"; paymentId: string | null };
  try {
    closed = await db.transaction((tx) => closeOrder(tx, { orderId, studentId: ctx.studentId, outcome: "cancelled", reason: "Cancelled by the family" }, who));
  } catch (err) {
    if (err instanceof OrderError) return fail(orderErrorText(err.code, ctx.t));
    throw err;
  }
  // The "payment in progress" card disappears, so the page itself confirms. If it was paid meanwhile (another tab), show the receipt.
  if (closed.state === "paid" && closed.paymentId) redirect(`/my/fees/receipts/${closed.paymentId}`);
  redirect("/my/fees?payment=cancelled");
}
