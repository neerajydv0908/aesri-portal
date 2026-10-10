"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { schools } from "@/lib/db/schema";
import { auditActor } from "@/lib/auth/dal";
import { done, fail, type FormState } from "@/lib/forms";
import { officePage } from "@/lib/page";
import { recentTests } from "@/lib/queries/sms";
import { cancelQueued, queueTest, retryFailed } from "@/lib/sms/outbox";
import { maskMobile } from "@/lib/sms/templates";
import { sendNow } from "@/lib/sms/worker";
import { audit } from "@/lib/audit";
import { parseMobile, str } from "@/lib/validation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The list's filters, carried back after an action (only these keys, only plain values). */
const BACK_KEYS = ["from", "to", "kind", "status", "section", "q", "page"];

function backTo(formData: FormData, doneKey: string): string {
  const raw = new URLSearchParams(str(formData, "back"));
  const u = new URLSearchParams();
  for (const k of BACK_KEYS) {
    const v = raw.get(k);
    if (v && v.length <= 80) u.set(k, v);
  }
  u.set("done", doneKey);
  return `/office/sms?${u.toString()}`;
}

/** Try one failed message again, or all of the school's recent failed messages. */
export async function retrySmsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const id = str(formData, "id");
  const all = str(formData, "all") === "yes";
  if (!all && !UUID.test(id)) return fail("Something went wrong with that request. Reload the page and try again.");
  const db = await getDb();
  const who = await auditActor(ctx.actor);
  const n = await db.transaction((tx) => retryFailed(tx, { schoolId: ctx.schoolId, ids: all ? "all" : [id] }, who));
  if (!n) return fail(all ? "There were no failed messages from the last 7 days to try again." : "That message can’t be tried again: it is no longer failed, is more than 7 days old, or a newer message has replaced it.");
  redirect(backTo(formData, n === 1 ? "retried" : "retried_all"));
}

/** Cancel a message that is waiting to be sent. */
export async function cancelSmsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const id = str(formData, "id");
  if (!UUID.test(id)) return fail("Something went wrong with that request. Reload the page and try again.");
  const db = await getDb();
  const who = await auditActor(ctx.actor);
  const n = await db.transaction((tx) => cancelQueued(tx, { schoolId: ctx.schoolId, ids: [id] }, who));
  if (!n) return fail("That message is no longer waiting: it may have been sent just now. Reload the page to see.");
  redirect(backTo(formData, "cancelled"));
}

/** At most this many test messages per school in ten minutes (each one costs money). */
const TESTS_PER_10_MIN = 5;

/**
 * Send a test message to a number an administrator typed, now (quiet time
 * doesn't apply), and say what happened. Office admins test their school;
 * AESRI admins the school whose wordings they are looking at.
 */
export async function sendTestSmsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const db = await getDb();
  let schoolId = ctx.schoolId;
  const asked = str(formData, "school");
  if (asked && asked !== schoolId && ctx.actor.role === "super_admin") {
    const [s] = await db.select({ id: schools.id }).from(schools).where(eq(schools.id, asked));
    if (!s) return fail("Something went wrong with that request. Reload the page and try again.");
    schoolId = s.id;
  }
  const mobile = parseMobile(str(formData, "mobile"));
  if (!mobile || mobile === "invalid") return fail("Type a 10-digit Indian mobile number, for example 98765 43210.", { mobile: "Type a 10-digit mobile number starting with 6, 7, 8 or 9." });
  const lang = str(formData, "lang") === "en" ? "en" : "hi";
  if ((await recentTests(schoolId, new Date(Date.now() - 10 * 60_000))) >= TESTS_PER_10_MIN) {
    return fail(`At most ${TESTS_PER_10_MIN} test messages can be sent in ten minutes. Please wait a few minutes.`);
  }
  const who = await auditActor(ctx.actor);
  const id = await db.transaction(async (tx) => {
    const smsId = await queueTest(tx, { schoolId, toMobile: mobile, lang, createdBy: ctx.actor.accountId });
    await audit(tx, who, "sms.test_sent", { schoolId, targetType: "sms", targetId: smsId, details: { to: maskMobile(mobile), lang } });
    return smsId;
  });
  const [row] = await sendNow([id]);
  const to = maskMobile(mobile);
  if (!row) return fail("The test message could not be found after sending. Please look at the list of messages.");
  if (row.status === "sent" && row.provider === "log") return done(`Test mode: the message to ${to} was written to the server’s log, not sent. Set up an SMS company to send real messages.`);
  if (row.status === "sent") return done(`Sent to ${to}: the SMS company accepted it${row.providerRef ? ` (reference ${row.providerRef})` : ""}. It should arrive within a minute or two.`);
  if (row.status === "queued") return fail(`The SMS company didn’t accept it yet: ${row.error ?? "no answer"}. It will be tried again in a few minutes.`);
  return fail(`Not sent to ${to}: ${row.error ?? "unknown reason"}`);
}
