"use server";

import { refresh } from "next/cache";
import { getDb } from "@/lib/db/client";
import { auditActor } from "@/lib/auth/dal";
import { done, fail, type FormState } from "@/lib/forms";
import { officePage } from "@/lib/page";
import { str } from "@/lib/validation";
import { readSettings, readSupportRule, saveSupportRule, updateSchoolSettings } from "@/lib/services/settings";
import { CONTRACT, type BatchRequest } from "@/lib/studai/contract";
import { resetStudAiBackoff } from "@/lib/studai/estimates";
import { runStudAiForAccount } from "@/lib/studai/service";
import type { SupportRule } from "@/lib/support/rules";
import { readSmsSettingsForm, saveSmsSettings, smsSettingName } from "@/lib/sms/settings";

const NAMES: Record<string, string> = {
  passPercent: "the pass mark",
  attendanceWarnPercent: "the attendance warning",
  phone: "the office phone",
  email: "the office email",
};

function list(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0];
}

export async function saveSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const read = readSettings({
    passPercent: str(formData, "passPercent"),
    attendanceWarnPercent: str(formData, "attendanceWarnPercent"),
    phone: str(formData, "phone"),
    email: str(formData, "email"),
  });
  if (!read.ok) return fail("Please check the highlighted boxes.", read.problems as Record<string, string>);
  const db = await getDb();
  const who = await auditActor(ctx.actor);
  const changed = await db.transaction((tx) => updateSchoolSettings(tx, ctx.schoolId, read.value, who));
  if (!changed.length) return done("Nothing had changed.");
  refresh();
  const words = changed.map((k) => NAMES[k] ?? k);
  return done(`Saved. You changed ${list(words)}.`);
}

/** Text messages: the main switch, which events send one, language, second mobile, homework time and quiet time. */
export async function saveSmsSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const read = readSmsSettingsForm(formData);
  if (!read.ok) {
    const problems = read.problems as Record<string, string>;
    return fail(Object.keys(problems).length === 1 ? Object.values(problems)[0] : "Please check the highlighted boxes.", problems);
  }
  const db = await getDb();
  const who = await auditActor(ctx.actor);
  const changed = await db.transaction((tx) => saveSmsSettings(tx, ctx.schoolId, read.value, who));
  if (!changed.length) return done("Nothing had changed.");
  refresh();
  const words = changed.map(smsSettingName);
  return done(
    `Saved. You changed ${list(words.length > 4 ? [...words.slice(0, 3), `${words.length - 3} more`] : words)}.` +
      (read.value.enabled ? " Messages already waiting follow the new settings when they are sent." : " No more text messages will be sent until you switch them on again."),
  );
}

const RULE_NAMES: Record<keyof SupportRule, string> = {
  attendanceRedPercent: "the attendance level",
  concernsRed: "the number of concerns",
  concernDays: "the number of days",
};

/** The teachers' "Needs support" colour rule. */
export async function saveSupportRuleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const read = readSupportRule({
    attendanceRedPercent: str(formData, "attendanceRedPercent"),
    concernsRed: str(formData, "concernsRed"),
    concernDays: str(formData, "concernDays"),
  });
  if (!read.ok) {
    const problems = read.problems as Record<string, string>;
    return fail(Object.keys(problems).length === 1 ? Object.values(problems)[0] : "Please check the highlighted boxes.", problems);
  }
  const db = await getDb();
  const who = await auditActor(ctx.actor);
  const changed = await db.transaction((tx) => saveSupportRule(tx, ctx.schoolId, read.value, who));
  if (!changed.length) return done("Nothing had changed.");
  refresh();
  return done(`Saved. You changed ${list(changed.map((k) => RULE_NAMES[k]))}. Teachers see the new colours the next time they open “Needs support”.`);
}

/** A made-up student (no one's records) to check Stud-AI answers on this server. */
const SAMPLE: BatchRequest = {
  contract: CONTRACT,
  students: [
    {
      ref: "sample",
      subjects: [
        { key: "maths", name: "Mathematics", tests: [42, 48], attendance: 85, homework: 60 },
        { key: "english", name: "English", tests: [70, 74], attendance: 85, homework: 90 },
      ],
    },
  ],
};

/** "Check Stud-AI now": runs the made-up student through Stud-AI and says what happened. */
export async function checkStudAiAction(): Promise<FormState> {
  const ctx = await officePage();
  const run = await runStudAiForAccount(SAMPLE, ctx.actor.accountId);
  if (!run.ok) return fail(run.error);
  resetStudAiBackoff();
  refresh();
  return done("Stud-AI passed the check. Estimates are available to teachers.");
}
