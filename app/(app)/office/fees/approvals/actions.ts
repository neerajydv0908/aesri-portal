"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/lib/db/client";
import { auditActor } from "@/lib/auth/dal";
import { officePage } from "@/lib/page";
import { OFFICE_ROLES } from "@/lib/roles";
import { fail, type FormState } from "@/lib/forms";
import { cleanText } from "@/lib/validation";
import { PaymentError } from "@/lib/services/fees";
import { approveCashClaim, CASH_CLAIM_LIMITS, ClaimError, declineCashClaim } from "@/lib/services/cash-claims";
import { smsCanSend } from "@/lib/queries/sms";
import { prepareHindi } from "@/lib/translate";

/** Where to go back to: the approvals list, or the student's fees page the button was on. */
function backTo(from: string, studentId: string | null): string {
  return from === "student" && studentId ? `/office/fees/students/${studentId}` : "/office/fees/approvals";
}

/**
 * The principal, an office admin or an AESRI administrator approves a cash
 * payment a family recorded: it becomes a cash payment with a receipt.
 */
export async function approveClaimAction(claimId: string, from: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const { actor, schoolId } = await officePage(OFFICE_ROLES);
  const db = await getDb();
  const who = await auditActor(actor);
  let studentId: string | null = null;
  try {
    studentId = (await db.transaction((tx) => approveCashClaim(tx, { claimId, schoolId }, who))).studentId;
  } catch (err) {
    if (err instanceof ClaimError || err instanceof PaymentError) {
      refresh();
      return fail(err.message);
    }
    throw err;
  }
  redirect(`${backTo(from, studentId)}?done=approved`);
}

/** Decline it: nothing is paid; the family is asked by text message to contact the school, and sees the reason on the portal. */
export async function declineClaimAction(claimId: string, from: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, schoolId } = await officePage(OFFICE_ROLES);
  const reason = cleanText(formData.get("reason"), CASH_CLAIM_LIMITS.reason);
  const db = await getDb();
  const who = await auditActor(actor);
  let done: { studentId: string; sms: { queued: number; unreachable: number } };
  try {
    done = await db.transaction((tx) => declineCashClaim(tx, { claimId, schoolId, reason }, who));
  } catch (err) {
    if (err instanceof ClaimError) {
      refresh();
      return fail(err.message);
    }
    throw err;
  }
  // The family reads the reason in Hindi when they chose Hindi: have it ready.
  await prepareHindi([reason]);
  // Say plainly when no text message will reach the family, so someone phones them.
  const key = done.sms.queued
    ? (await smsCanSend(schoolId, "cash_declined"))
      ? "declined"
      : "declined_notsetup"
    : done.sms.unreachable
      ? "declined_unreachable"
      : "declined_nosms";
  redirect(`${backTo(from, done.studentId)}?done=${key}`);
}
