/**
 * Text message settings: each school's choices (Settings → Text messages),
 * and AESRI's template IDs at the SMS company (AESRI → Text messages).
 *
 * A school's settings live in schools.settings.sms; anything missing takes
 * the default below (what the school asked for at launch: every event on,
 * in Hindi). Template IDs live in app_settings under "sms.templates", per
 * SMS company and per school (each school's name is fixed text in its own
 * templates, so each school registers its own copy).
 *
 * No "server-only" import: the services (and so the demo script) use it.
 */
import { eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { appSettings, schools, type SchoolSettings, type SchoolSmsSettings, type SmsEvent } from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import type { ProviderName } from "./config";
import { TEMPLATE_KEYS, type SmsLang, type TemplateKey } from "./templates";

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export type { SmsEvent };

/** What can send a message, as the office sees it (in this order). */
export const SMS_EVENTS: { key: SmsEvent; label: string; hint: string }[] = [
  { key: "attendance_absent", label: "Marked absent", hint: "When the class teacher marks a student absent in today’s or yesterday’s register." },
  { key: "attendance_late", label: "Marked late", hint: "When a student is marked late." },
  { key: "attendance_leave", label: "Marked on leave", hint: "When a student is marked on leave." },
  {
    key: "attendance_present",
    label: "Marked present",
    hint: "Every student marked present, every school day: most of the messages (and of the cost) come from this one.",
  },
  { key: "remark", label: "Remark shared with the family", hint: "Says a teacher has written a note of appreciation or concern, and to read it on the portal. The note itself is not in the message." },
  { key: "notice_school", label: "Notice to the whole school", hint: "To every current family, when the notice is published (or on its “show from” day)." },
  { key: "notice_class", label: "Notice to one class", hint: "Only to the families of that class." },
  { key: "notice_students", label: "Notice to selected students", hint: "Only to the families of the students chosen." },
  { key: "notice_staff", label: "Notice to staff", hint: "To current staff who have portal access and a mobile number." },
  { key: "homework_digest", label: "Homework summary", hint: "One message a day per class that was set homework, at the time below: the subjects, not the details." },
  { key: "results", label: "Results published", hint: "To the families of a class when the office publishes its results." },
  { key: "payment", label: "Fee received", hint: "Cash, cheque, bank and online payments (not opening balances), and a message if a receipt they were told about is cancelled." },
  {
    key: "cash_declined",
    label: "Recorded cash payment declined",
    hint: "When the principal or an office admin declines a cash payment the family recorded on the portal: asks them to contact the school office.",
  },
];

export const SMS_EVENT_KEYS: SmsEvent[] = SMS_EVENTS.map((e) => e.key);

export function isSmsEvent(v: unknown): v is SmsEvent {
  return typeof v === "string" && (SMS_EVENT_KEYS as string[]).includes(v);
}

/**
 * What a message was about, as recorded in sms_messages.kind: an event,
 * or one of the messages that don't have their own switch.
 */
export type SmsKind = SmsEvent | "attendance_correction" | "test";

export const KIND_LABELS: Record<SmsKind, string> = {
  attendance_absent: "Absent",
  attendance_late: "Late",
  attendance_leave: "On leave",
  attendance_present: "Present",
  attendance_correction: "Attendance correction",
  remark: "Remark",
  notice_school: "Notice: whole school",
  notice_class: "Notice: class",
  notice_students: "Notice: selected students",
  notice_staff: "Notice: staff",
  homework_digest: "Homework summary",
  results: "Results",
  payment: "Fees",
  cash_declined: "Cash payment declined",
  test: "Test message",
};

export const SMS_KINDS = Object.keys(KIND_LABELS) as SmsKind[];

export function isSmsKind(v: unknown): v is SmsKind {
  return typeof v === "string" && Object.hasOwn(KIND_LABELS, v);
}

/** The switch that governs a kind of message (corrections and tests follow only the master switch). */
export function eventOfKind(kind: string): SmsEvent | null {
  return isSmsEvent(kind) ? kind : null;
}

/* ------------------------------------------------------------------ */
/* A school's settings                                                 */
/* ------------------------------------------------------------------ */

export const DEFAULT_SMS_SETTINGS: SchoolSmsSettings = {
  enabled: true,
  events: {},
  lang: "hi",
  alsoSecondMobile: false,
  homeworkDigestAt: "16:30",
  quietHours: { from: "21:00", to: "07:00" },
};

/** Every event on unless the school switched it off. */
const EVENT_DEFAULT = true;

export type ResolvedSmsSettings = Omit<SchoolSmsSettings, "events"> & { events: Record<SmsEvent, boolean> };

export const isTime = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** A school's stored settings with the defaults filled in (bad stored values fall back to the default). */
export function resolveSmsSettings(raw: Partial<SchoolSmsSettings> | null | undefined): ResolvedSmsSettings {
  const r = raw ?? {};
  const events = {} as Record<SmsEvent, boolean>;
  for (const key of SMS_EVENT_KEYS) {
    const v = r.events?.[key];
    events[key] = typeof v === "boolean" ? v : EVENT_DEFAULT;
  }
  const quiet = r.quietHours === null ? null : r.quietHours && isTime(r.quietHours.from) && isTime(r.quietHours.to) ? r.quietHours : DEFAULT_SMS_SETTINGS.quietHours;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_SMS_SETTINGS.enabled,
    events,
    lang: r.lang === "en" || r.lang === "hi" ? r.lang : DEFAULT_SMS_SETTINGS.lang,
    alsoSecondMobile: typeof r.alsoSecondMobile === "boolean" ? r.alsoSecondMobile : DEFAULT_SMS_SETTINGS.alsoSecondMobile,
    homeworkDigestAt: isTime(r.homeworkDigestAt) ? r.homeworkDigestAt : DEFAULT_SMS_SETTINGS.homeworkDigestAt,
    quietHours: quiet && quiet.from !== quiet.to ? { from: quiet.from, to: quiet.to } : null,
  };
}

/** Does this school send messages for this event? (Master switch and the event's own switch.) */
export function eventOn(s: ResolvedSmsSettings, event: SmsEvent): boolean {
  return s.enabled && s.events[event];
}

/** Hours and minutes in India now, "HH:MM". */
export function istTime(now = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}

/** Is "HH:MM" inside the quiet time (which may run past midnight, e.g. 21:00–07:00)? The end time itself is not quiet. */
export function inQuietHours(quiet: { from: string; to: string } | null, hhmm: string): boolean {
  if (!quiet || quiet.from === quiet.to) return false;
  return quiet.from < quiet.to ? hhmm >= quiet.from && hhmm < quiet.to : hhmm >= quiet.from || hhmm < quiet.to;
}

export type SchoolForSms = { id: string; name: string; nameHi: string; settings: ResolvedSmsSettings };

/** A school's names and SMS settings (optionally locking the row, to change them). */
export async function schoolForSms(tx: Tx, schoolId: string, lock = false): Promise<SchoolForSms> {
  const q = tx.select({ id: schools.id, name: schools.name, nameHi: schools.nameHi, settings: schools.settings }).from(schools).where(eq(schools.id, schoolId));
  const [s] = lock ? await q.for("update") : await q;
  if (!s) throw new Error(`Unknown school ${schoolId}`);
  return { id: s.id, name: s.name, nameHi: s.nameHi, settings: resolveSmsSettings(s.settings.sms) };
}

/** The school's name in the message language. */
export function schoolNameIn(s: { name: string; nameHi: string }, lang: SmsLang): string {
  return lang === "hi" && s.nameHi ? s.nameHi : s.name;
}

/* ------------------------------------------------------------------ */
/* Changing a school's settings                                        */
/* ------------------------------------------------------------------ */

export type SmsSettingsProblems = Partial<Record<"homeworkDigestAt" | "quietFrom" | "quietTo" | "lang", string>>;

/** Read the settings form. Unticked boxes are "off". */
export function readSmsSettingsForm(form: FormData): { ok: true; value: ResolvedSmsSettings } | { ok: false; problems: SmsSettingsProblems } {
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const problems: SmsSettingsProblems = {};
  const lang = get("smsLang");
  if (lang !== "hi" && lang !== "en") problems.lang = "Choose Hindi or English.";
  const digest = get("homeworkDigestAt");
  if (!isTime(digest)) problems.homeworkDigestAt = "Type a time such as 16:30.";
  const quietOn = get("quietOn") === "yes";
  const from = get("quietFrom");
  const to = get("quietTo");
  if (quietOn) {
    if (!isTime(from)) problems.quietFrom = "Type a time such as 21:00.";
    if (!isTime(to)) problems.quietTo = "Type a time such as 07:00.";
    else if (isTime(from) && from === to) problems.quietTo = "The quiet time must end at a different time than it starts.";
  }
  if (Object.keys(problems).length) return { ok: false, problems };
  const events = {} as Record<SmsEvent, boolean>;
  for (const key of SMS_EVENT_KEYS) events[key] = get(`ev_${key}`) === "on";
  return {
    ok: true,
    value: {
      enabled: get("smsEnabled") === "on",
      events,
      lang: lang as SmsLang,
      alsoSecondMobile: get("alsoSecondMobile") === "on",
      homeworkDigestAt: digest,
      quietHours: quietOn ? { from, to } : null,
    },
  };
}

/** Plain words for one setting's value, for the activity log. */
function show(key: string, v: unknown): string {
  if (key === "lang") return v === "en" ? "English" : "Hindi";
  if (key === "quietHours") return v && typeof v === "object" ? `${(v as { from: string }).from}–${(v as { to: string }).to}` : "none";
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v ?? "—");
}

/**
 * Save a school's SMS settings; returns the names of what changed (nothing
 * written when nothing changed). Audited with each value before and after.
 */
export async function saveSmsSettings(tx: Tx, schoolId: string, next: ResolvedSmsSettings, actor: AuditActor): Promise<string[]> {
  const [cur] = await tx.select({ settings: schools.settings }).from(schools).where(eq(schools.id, schoolId)).for("update");
  if (!cur) throw new Error(`Unknown school ${schoolId}`);
  const was = resolveSmsSettings(cur.settings.sms);
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  const note = (key: string, a: unknown, b: unknown) => {
    if (show(key, a) !== show(key, b)) {
      before[key] = show(key, a);
      after[key] = show(key, b);
    }
  };
  note("enabled", was.enabled, next.enabled);
  note("lang", was.lang, next.lang);
  note("alsoSecondMobile", was.alsoSecondMobile, next.alsoSecondMobile);
  note("homeworkDigestAt", was.homeworkDigestAt, next.homeworkDigestAt);
  note("quietHours", was.quietHours, next.quietHours);
  for (const key of SMS_EVENT_KEYS) note(key, was.events[key], next.events[key]);
  const changed = Object.keys(after);
  if (!changed.length) return [];
  const sms: SchoolSmsSettings = { ...next, events: { ...next.events } };
  const settings: SchoolSettings = { ...cur.settings, sms };
  await tx.update(schools).set({ settings }).where(eq(schools.id, schoolId));
  await audit(tx, actor, "sms.settings_updated", { schoolId, targetType: "school", targetId: schoolId, details: { before, after } });
  return changed;
}

/** Words for the names saveSmsSettings returns. */
export function smsSettingName(key: string): string {
  const ev = SMS_EVENTS.find((e) => e.key === key);
  if (ev) return `“${ev.label}”`;
  return (
    {
      enabled: "the main switch",
      lang: "the language",
      alsoSecondMobile: "the second mobile",
      homeworkDigestAt: "the homework summary time",
      quietHours: "the quiet time",
    } as Record<string, string>
  )[key] ?? key;
}

/* ------------------------------------------------------------------ */
/* Template IDs at the SMS company (AESRI-level)                       */
/* ------------------------------------------------------------------ */

const TEMPLATE_IDS_KEY = "sms.templates";

export type SmsCompany = Exclude<ProviderName, "log">;
const COMPANIES: SmsCompany[] = ["msg91", "fast2sms"];

/**
 * Per SMS company, per school: "attendance.hi" → the company's template ID.
 * Each school registers its own templates (its name is fixed text in them).
 */
export type TemplateIds = Partial<Record<SmsCompany, Record<string, Record<string, string>>>>;

export const templateIdKey = (key: TemplateKey, lang: SmsLang) => `${key}.${lang}`;

/** A template ID as the SMS companies write them (letters, digits, - and _). */
export const isTemplateId = (v: string) => /^[A-Za-z0-9_-]{1,64}$/.test(v);

function cleanIds(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, id] of Object.entries(v as Record<string, unknown>)) if (typeof id === "string" && isTemplateId(id.trim())) out[k] = id.trim();
  return out;
}

export async function loadTemplateIds(tx: Tx): Promise<TemplateIds> {
  const [row] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, TEMPLATE_IDS_KEY));
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const out: TemplateIds = {};
  for (const p of COMPANIES) {
    const bySchool = v[p];
    if (!bySchool || typeof bySchool !== "object") continue;
    const clean: Record<string, Record<string, string>> = {};
    for (const [schoolId, ids] of Object.entries(bySchool as Record<string, unknown>)) {
      const c = cleanIds(ids);
      if (Object.keys(c).length) clean[schoolId] = c;
    }
    out[p] = clean;
  }
  return out;
}

/** A school's template ID for one template and language at the SMS company (null: not entered yet). */
export function templateIdFor(ids: TemplateIds, provider: ProviderName, schoolId: string, key: TemplateKey, lang: SmsLang): string | null {
  if (provider === "log") return null;
  return ids[provider]?.[schoolId]?.[templateIdKey(key, lang)] ?? null;
}

/**
 * Save one school's template IDs at one SMS company (an empty value means
 * not set up). Returns the "template.lang" keys that changed; audited as an
 * AESRI-level entry.
 */
export async function saveTemplateIds(
  tx: Tx,
  provider: SmsCompany,
  school: { id: string; name: string },
  next: Record<string, string>,
  actor: AuditActor,
): Promise<string[]> {
  const [row] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, TEMPLATE_IDS_KEY)).for("update");
  const all = { ...((row?.value ?? {}) as Record<string, unknown>) };
  const bySchool = { ...((all[provider] && typeof all[provider] === "object" ? all[provider] : {}) as Record<string, unknown>) };
  const cur = cleanIds(bySchool[school.id]);
  const merged: Record<string, string> = {};
  const changed: string[] = [];
  for (const key of TEMPLATE_KEYS) {
    for (const lang of ["hi", "en"] as const) {
      const k = templateIdKey(key, lang);
      const was = cur[k] ?? "";
      const now = (next[k] ?? "").trim();
      if (now && !isTemplateId(now)) throw new Error(`Not a template ID: ${k}`);
      if (now) merged[k] = now;
      if (was !== now) changed.push(k);
    }
  }
  if (!changed.length) return [];
  bySchool[school.id] = merged;
  all[provider] = bySchool;
  const value = all as Record<string, unknown>;
  if (row) await tx.update(appSettings).set({ value, updatedBy: actor.accountId, updatedAt: new Date() }).where(eq(appSettings.key, TEMPLATE_IDS_KEY));
  else await tx.insert(appSettings).values({ key: TEMPLATE_IDS_KEY, value, updatedBy: actor.accountId });
  await audit(tx, actor, "sms.templates_updated", {
    schoolId: null,
    targetType: "app_settings",
    targetId: TEMPLATE_IDS_KEY,
    details: { provider, school: school.id, schoolName: school.name, changed },
  });
  return changed;
}
