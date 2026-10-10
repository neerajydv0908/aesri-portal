/**
 * School settings: the pass mark and attendance warning used by results and
 * attendance pages, the office phone and email shown to families, and the
 * teachers' "Needs support" colour rule. Changes are audited with what each
 * value was before and after.
 */
import "server-only";
import { eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { schools, type SchoolSettings } from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { DEFAULT_SUPPORT_RULE, SUPPORT_RULE_LIMITS, resolveSupportRule, type SupportRule } from "@/lib/support/rules";

export type SettingsInput = {
  passPercent: number;
  attendanceWarnPercent: number;
  phone: string | null;
  email: string | null;
};

export type SettingsProblems = Partial<Record<keyof SettingsInput, string>>;

/** A whole percentage from 1 to 100, or null. */
function percent(raw: string): number | null {
  const s = raw.trim().replace(/\s*%$/, "");
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 100 ? n : null;
}

/** A phone number as the office would write it (6–15 digits; spaces, +, -, brackets allowed). */
function phone(raw: string): string | null | "invalid" {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.length > 25 || !/^[+0-9()\-. ]+$/.test(s)) return "invalid";
  const digits = s.replace(/\D/g, "").length;
  return digits >= 6 && digits <= 15 ? s : "invalid";
}

function email(raw: string): string | null | "invalid" {
  const s = raw.trim();
  if (!s) return null;
  return s.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : "invalid";
}

/** Check what was typed; returns clean values or a message per field. */
export function readSettings(form: { passPercent: string; attendanceWarnPercent: string; phone: string; email: string }): { ok: true; value: SettingsInput } | { ok: false; problems: SettingsProblems } {
  const problems: SettingsProblems = {};
  const pass = percent(form.passPercent);
  const warn = percent(form.attendanceWarnPercent);
  const ph = phone(form.phone);
  const em = email(form.email);
  if (pass === null) problems.passPercent = "Type a whole number from 1 to 100, for example 33.";
  if (warn === null) problems.attendanceWarnPercent = "Type a whole number from 1 to 100, for example 75.";
  if (ph === "invalid") problems.phone = "Type a phone number, such as +91 75973 82016, or leave the box empty.";
  if (em === "invalid") problems.email = "Type an email address, such as office@example.com, or leave the box empty.";
  if (pass === null || warn === null || ph === "invalid" || em === "invalid") return { ok: false, problems };
  return { ok: true, value: { passPercent: pass, attendanceWarnPercent: warn, phone: ph, email: em } };
}

/** Save the settings; returns the names of the values that changed (none: nothing written). */
export async function updateSchoolSettings(tx: Tx, schoolId: string, input: SettingsInput, actor: AuditActor): Promise<string[]> {
  const [cur] = await tx.select().from(schools).where(eq(schools.id, schoolId)).for("update");
  if (!cur) throw new Error(`Unknown school ${schoolId}`);
  const was = { passPercent: cur.settings.passPercent, attendanceWarnPercent: cur.settings.attendanceWarnPercent, phone: cur.phone, email: cur.email };
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of ["passPercent", "attendanceWarnPercent", "phone", "email"] as const) {
    if ((was[k] ?? null) !== (input[k] ?? null)) {
      before[k] = was[k] ?? null;
      after[k] = input[k] ?? null;
    }
  }
  const changed = Object.keys(after);
  if (!changed.length) return [];
  const settings: SchoolSettings = { ...cur.settings, passPercent: input.passPercent, attendanceWarnPercent: input.attendanceWarnPercent };
  await tx.update(schools).set({ settings, phone: input.phone, email: input.email }).where(eq(schools.id, schoolId));
  await audit(tx, actor, "settings.updated", { schoolId, targetType: "school", targetId: schoolId, details: { before, after } });
  return changed;
}

/** The "Needs support" rule as typed on the Settings page. */
export type SupportRuleForm = { attendanceRedPercent: string; concernsRed: string; concernDays: string };

const RULE_WORDS: Record<keyof SupportRule, string> = {
  attendanceRedPercent: "Type a whole number of percent",
  concernsRed: "Type a whole number of concerns",
  concernDays: "Type a whole number of days",
};

/** Check the typed rule; returns clean values or a message per field. */
export function readSupportRule(form: SupportRuleForm): { ok: true; value: SupportRule } | { ok: false; problems: Partial<Record<keyof SupportRule, string>> } {
  const problems: Partial<Record<keyof SupportRule, string>> = {};
  const value = { ...DEFAULT_SUPPORT_RULE };
  for (const k of Object.keys(DEFAULT_SUPPORT_RULE) as (keyof SupportRule)[]) {
    const raw = form[k].trim().replace(/\s*%$/, "");
    const { min, max } = SUPPORT_RULE_LIMITS[k];
    const n = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) problems[k] = `${RULE_WORDS[k]} from ${min} to ${max}.`;
    else value[k] = n;
  }
  return Object.keys(problems).length ? { ok: false, problems } : { ok: true, value };
}

/** Save the school's "Needs support" rule; returns the names of the values that changed. Audited with before and after. */
export async function saveSupportRule(tx: Tx, schoolId: string, rule: SupportRule, actor: AuditActor): Promise<(keyof SupportRule)[]> {
  const [cur] = await tx.select().from(schools).where(eq(schools.id, schoolId)).for("update");
  if (!cur) throw new Error(`Unknown school ${schoolId}`);
  const was = resolveSupportRule(cur.settings.support);
  const changed = (Object.keys(rule) as (keyof SupportRule)[]).filter((k) => was[k] !== rule[k]);
  if (!changed.length) return [];
  const settings: SchoolSettings = { ...cur.settings, support: { ...rule } };
  await tx.update(schools).set({ settings }).where(eq(schools.id, schoolId));
  await audit(tx, actor, "settings.support_updated", {
    schoolId,
    targetType: "school",
    targetId: schoolId,
    details: { before: Object.fromEntries(changed.map((k) => [k, was[k]])), after: Object.fromEntries(changed.map((k) => [k, rule[k]])) },
  });
  return changed;
}
