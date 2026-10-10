/**
 * Text message settings that come from the server's environment (set by
 * whoever runs the server, never shown in the portal):
 *
 *   SMS_PROVIDER        log (default) | msg91 | fast2sms
 *   MSG91_AUTH_KEY      MSG91 → API → Auth key (msg91)
 *   FAST2SMS_API_KEY    Fast2SMS → Dev API → API key (fast2sms)
 *   SMS_SENDER_ID       The 6-letter DLT sender ID (header): one for both schools ("AESRIS"), or one per
 *                       school ("aryavart:ARYAPS,aadharshila:AADHPS"). Needed for fast2sms; MSG91 takes the
 *                       header from each MSG91 template.
 *   SMS_PORTAL_ADDRESS  The portal address written into templates (default: APP_URL, e.g. https://portal.aesrischools.org)
 *   SMS_WORKER          "off" stops this server from sending (another server or `npm run sms:send` does it)
 *
 * For tests only: SMS_ATTENDANCE_DELAY_SECONDS (default 600),
 * SMS_REMARK_DELAY_SECONDS (180), SMS_PAYMENT_DELAY_SECONDS (120),
 * SMS_WORKER_INTERVAL_SECONDS (30).
 *
 * "log" writes messages to the server's console instead of sending them. On
 * a development server they are then marked "sent (test mode)"; on a
 * production server nothing is sent and each message is recorded as
 * skipped ("SMS isn't set up yet").
 */
import { appUrl, isProduction } from "@/lib/env";

export type ProviderName = "log" | "msg91" | "fast2sms";

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  log: "None (test mode)",
  msg91: "MSG91",
  fast2sms: "Fast2SMS",
};

/** The SMS company in SMS_PROVIDER ("log" when empty; an unknown name counts as "log" and is reported by smsConfigProblem). */
export function smsProviderName(): ProviderName {
  const v = process.env.SMS_PROVIDER?.trim().toLowerCase();
  return v === "msg91" || v === "fast2sms" ? v : "log";
}

/**
 * What happens to a message that is due:
 *  - "live": it goes to the SMS company;
 *  - "test": development server without an SMS company — written to the console and marked sent (test mode);
 *  - "off": production server without an SMS company — recorded as skipped.
 */
export type SmsMode = "live" | "test" | "off";

export function smsMode(): SmsMode {
  if (smsProviderName() !== "log") return "live";
  return isProduction() ? "off" : "test";
}

/** SMS_SENDER_ID read as school → header ("*" for the one used by every school). */
function senderMap(): Map<string, string> {
  const out = new Map<string, string>();
  const raw = process.env.SMS_SENDER_ID?.trim();
  if (!raw) return out;
  if (!raw.includes(":")) {
    out.set("*", raw);
    return out;
  }
  for (const part of raw.split(",")) {
    const [school, id] = part.split(":").map((x) => x.trim());
    if (school && id) out.set(school, id);
  }
  return out;
}

/** The DLT header a school's messages go out under (null: not set). */
export function senderIdFor(schoolId: string): string | null {
  const m = senderMap();
  return m.get(schoolId) ?? m.get("*") ?? null;
}

/** The headers as configured, for the AESRI page: "AESRIS", or "aryavart: ARYAPS · aadharshila: AADHPS". */
export function senderIdText(): string | null {
  const m = senderMap();
  if (!m.size) return null;
  if (m.has("*")) return m.get("*")!;
  return [...m].map(([k, v]) => `${k}: ${v}`).join(" · ");
}

/** Whether the key for the chosen SMS company is set (the key itself is never shown). */
export function providerKeySet(provider = smsProviderName()): boolean {
  if (provider === "msg91") return !!process.env.MSG91_AUTH_KEY?.trim();
  if (provider === "fast2sms") return !!process.env.FAST2SMS_API_KEY?.trim();
  return true;
}

/**
 * A problem with the SMS settings that must be fixed before the server
 * starts (instrumentation-node.ts), or null.
 */
export function smsConfigProblem(): string | null {
  const name = process.env.SMS_PROVIDER?.trim().toLowerCase();
  if (name && !["log", "msg91", "fast2sms"].includes(name)) return `SMS_PROVIDER must be log, msg91 or fast2sms (it is "${process.env.SMS_PROVIDER}").`;
  const p = smsProviderName();
  if (p === "msg91" && !providerKeySet(p)) return "SMS_PROVIDER is msg91, but MSG91_AUTH_KEY is not set.";
  const senders = senderMap();
  if (p === "fast2sms") {
    const missing = [!providerKeySet(p) ? "FAST2SMS_API_KEY" : null, !senders.size ? "SMS_SENDER_ID" : null].filter(Boolean);
    if (missing.length) return `SMS_PROVIDER is fast2sms, but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set.`;
  }
  const raw = process.env.SMS_SENDER_ID?.trim();
  if (raw && (!senders.size || [...senders.values()].some((id) => !/^[A-Za-z]{6}$/.test(id)))) {
    return "SMS_SENDER_ID must be the 6-letter sender ID (header) registered on DLT, for example AESRIS — or one per school, for example aryavart:ARYAPS,aadharshila:AADHPS.";
  }
  const portal = process.env.SMS_PORTAL_ADDRESS?.trim();
  if (portal && !/^(https?:\/\/|www\.)[^\s]+$/i.test(portal)) {
    return "SMS_PORTAL_ADDRESS must start with https:// (DLT accepts only links that start with http, https or www), for example https://portal.aesrischools.org.";
  }
  return null;
}

/**
 * The portal's address as it is written in message templates: fixed text
 * that must match the registered DLT templates and the whitelisted URL
 * exactly (DLT accepts links that start with http, https or www).
 * SMS_PORTAL_ADDRESS, or APP_URL.
 */
export function smsPortalAddress(): string {
  const own = process.env.SMS_PORTAL_ADDRESS?.trim();
  return (own || appUrl()).replace(/\/+$/, "");
}

function seconds(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 86_400 ? n : fallback;
}

/** How long attendance messages wait, so a corrected register sends one message instead of two. */
export const attendanceDelaySeconds = () => seconds("SMS_ATTENDANCE_DELAY_SECONDS", 600);
/** How long remark messages wait (the teacher may still change the remark or make it staff-only). */
export const remarkDelaySeconds = () => seconds("SMS_REMARK_DELAY_SECONDS", 180);
/** How long fee receipts wait (a payment recorded by mistake and cancelled at once sends nothing). */
export const paymentDelaySeconds = () => seconds("SMS_PAYMENT_DELAY_SECONDS", 120);
/** How often the sender looks for due messages. */
export const workerIntervalSeconds = () => Math.max(2, seconds("SMS_WORKER_INTERVAL_SECONDS", 30));

/** "in about 10 minutes", "in about a minute", "straight away". */
export function delayWords(sec: number): string {
  if (sec < 45) return "straight away";
  const min = Math.round(sec / 60);
  return min <= 1 ? "in about a minute" : `in about ${min} minutes`;
}

/** "about 10 minutes after you save", "as soon as you save". */
export function delayAfterSave(sec: number): string {
  if (sec < 45) return "as soon as you save";
  const min = Math.round(sec / 60);
  return min <= 1 ? "about a minute after you save" : `about ${min} minutes after you save`;
}
