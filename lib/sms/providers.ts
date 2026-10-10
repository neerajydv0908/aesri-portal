/**
 * The SMS companies the portal can hand messages to. Each takes a batch of
 * messages that use the same school's template in the same language, and
 * says for each one whether the company accepted it. "Accepted" is all
 * the portal knows: delivery to the phone is reported by the company's own
 * dashboard.
 *
 *  - log:      writes each message to the server console (tests, laptops).
 *  - msg91:    POST https://control.msg91.com/api/v5/flow — one call per
 *              100 recipients, each with its own variables (var1, var2, …
 *              in the order of the template).
 *  - fast2sms: POST https://www.fast2sms.com/dev/bulkV2, route "dlt" — one
 *              call per set of identical variables, up to 100 numbers.
 *
 * Keys come from the environment and are never logged or returned.
 */
import { providerKeySet, smsProviderName, type ProviderName } from "./config";
import { maskMobile, type SmsLang } from "./templates";

export type OutgoingSms = { id: string; to: string; vars: string[]; body: string; lang: SmsLang };

export type SendOutcome = { id: string; ok: true; ref: string | null } | { id: string; ok: false; error: string };

export interface SmsProvider {
  name: ProviderName;
  /**
   * Send messages of one school's template in one language. `templateId` is
   * the company's ID for it (null for "log"); `sender` is the school's DLT
   * header (SMS_SENDER_ID), which Fast2SMS needs with every call (MSG91
   * takes it from its template).
   */
  send(templateId: string | null, batch: OutgoingSms[], sender?: string | null): Promise<SendOutcome[]>;
}

/** How long to wait for the SMS company before counting the try as failed (it is tried again later). */
const TIMEOUT_MS = 15_000;
const CHUNK = 100;

/** Error text safe to store and show: short, one line, and never a full mobile number. */
export function safeError(text: unknown): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  const masked = s.replace(/(\+?91)?[6-9]\d{9}/g, (m) => maskMobile(m.slice(-10)));
  return (masked || "Unknown error").slice(0, 300);
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Call an SMS company's API; returns its JSON answer, or an error message for a failed call. */
async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ ok: true; status: number; json: unknown } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "The SMS company did not answer in time." : `Could not reach the SMS company (${safeError((err as Error)?.message)}).` };
  }
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (json === null) return { ok: false, error: `The SMS company answered ${res.status}${text ? `: ${safeError(text.slice(0, 120))}` : ""}.` };
  return { ok: true, status: res.status, json };
}

const failAll = (batch: OutgoingSms[], error: string): SendOutcome[] => batch.map((m) => ({ id: m.id, ok: false, error: safeError(error) }));

/* ------------------------------------------------------------------ */
/* log                                                                 */
/* ------------------------------------------------------------------ */

export const logProvider: SmsProvider = {
  name: "log",
  async send(_templateId, batch) {
    for (const m of batch) console.info(`[sms] test mode, not sent — to ${maskMobile(m.to)} (${m.lang}): ${m.body}`);
    return batch.map((m) => ({ id: m.id, ok: true, ref: null }));
  },
};

/* ------------------------------------------------------------------ */
/* MSG91                                                               */
/* ------------------------------------------------------------------ */

export const MSG91_URL = "https://control.msg91.com/api/v5/flow";

/** The request body for one MSG91 call: the template, and each recipient with its variables as var1, var2, … */
export function msg91Body(templateId: string, batch: OutgoingSms[]) {
  return {
    template_id: templateId,
    short_url: "0", // never shorten links: only the whitelisted portal address may appear
    recipients: batch.map((m) => {
      const r: Record<string, string> = { mobiles: `91${m.to}` };
      m.vars.forEach((v, i) => (r[`var${i + 1}`] = v));
      return r;
    }),
  };
}

export const msg91Provider: SmsProvider = {
  name: "msg91",
  async send(templateId, batch) {
    const key = process.env.MSG91_AUTH_KEY?.trim();
    if (!key) return failAll(batch, "MSG91_AUTH_KEY is not set on the server.");
    if (!templateId) return failAll(batch, "No MSG91 template ID for this message.");
    const out: SendOutcome[] = [];
    let down: string | null = null;
    for (const part of chunks(batch, CHUNK)) {
      if (down) {
        out.push(...failAll(part, down));
        continue;
      }
      const r = await postJson(MSG91_URL, { authkey: key }, msg91Body(templateId, part));
      if (!r.ok) {
        // MSG91 didn't answer (or not with JSON): the rest wait for the next try instead of waiting here.
        down = r.error;
        out.push(...failAll(part, r.error));
        continue;
      }
      const j = (r.json ?? {}) as { type?: unknown; message?: unknown };
      if (j.type === "success" && r.status < 400) {
        const ref = typeof j.message === "string" ? j.message.slice(0, 100) : null;
        out.push(...part.map((m) => ({ id: m.id, ok: true as const, ref })));
      } else {
        out.push(...failAll(part, `MSG91: ${typeof j.message === "string" ? j.message : `answered ${r.status}`}`));
      }
    }
    return out;
  },
};

/* ------------------------------------------------------------------ */
/* Fast2SMS                                                            */
/* ------------------------------------------------------------------ */

export const FAST2SMS_URL = "https://www.fast2sms.com/dev/bulkV2";

/** Fast2SMS sends the same variables to every number in a call, so messages are grouped by their variables. */
export function fast2smsRequests(templateId: string, sender: string, batch: OutgoingSms[]) {
  const groups = new Map<string, OutgoingSms[]>();
  for (const m of batch) {
    const k = JSON.stringify(m.vars);
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  const requests: { messages: OutgoingSms[]; body: Record<string, string> }[] = [];
  for (const msgs of groups.values()) {
    for (const part of chunks(msgs, CHUNK)) {
      requests.push({
        messages: part,
        body: {
          route: "dlt",
          sender_id: sender,
          message: templateId,
          variables_values: part[0].vars.join("|"),
          numbers: part.map((m) => m.to).join(","),
          flash: "0",
        },
      });
    }
  }
  return requests;
}

export const fast2smsProvider: SmsProvider = {
  name: "fast2sms",
  async send(templateId, batch, sender) {
    const key = process.env.FAST2SMS_API_KEY?.trim();
    if (!key) return failAll(batch, "FAST2SMS_API_KEY is not set on the server.");
    if (!sender) return failAll(batch, "No sender ID for this school: SMS_SENDER_ID is not set on the server.");
    if (!templateId) return failAll(batch, "No Fast2SMS message ID for this message.");
    const out: SendOutcome[] = [];
    let down: string | null = null;
    for (const req of fast2smsRequests(templateId, sender, batch)) {
      if (down) {
        out.push(...failAll(req.messages, down));
        continue;
      }
      const r = await postJson(FAST2SMS_URL, { authorization: key }, req.body);
      if (!r.ok) {
        // Fast2SMS didn't answer (or not with JSON): one call a message would otherwise wait up to
        // 15 seconds each while the sender holds these messages locked. The rest are tried again later.
        down = r.error;
        out.push(...failAll(req.messages, r.error));
        continue;
      }
      const j = (r.json ?? {}) as { return?: unknown; request_id?: unknown; message?: unknown; status_code?: unknown };
      if (j.return === true && r.status < 400) {
        const ref = typeof j.request_id === "string" ? j.request_id.slice(0, 100) : null;
        out.push(...req.messages.map((m) => ({ id: m.id, ok: true as const, ref })));
      } else {
        const msg = Array.isArray(j.message) ? j.message.join(" ") : typeof j.message === "string" ? j.message : `answered ${r.status}`;
        out.push(...failAll(req.messages, `Fast2SMS${typeof j.status_code === "number" ? ` (${j.status_code})` : ""}: ${msg}`));
      }
    }
    return out;
  },
};

/* ------------------------------------------------------------------ */

export function providerFor(name: ProviderName): SmsProvider {
  return name === "msg91" ? msg91Provider : name === "fast2sms" ? fast2smsProvider : logProvider;
}

/** The SMS company chosen in SMS_PROVIDER. */
export function currentProvider(): SmsProvider {
  return providerFor(smsProviderName());
}

/** Who sends the messages, for the privacy notice and staff pages. */
export function smsCompanyName(): string | null {
  const p = smsProviderName();
  if (p === "msg91") return "MSG91 (Walkover Web Solutions Pvt. Ltd.)";
  if (p === "fast2sms") return "Fast2SMS";
  return null;
}

export { providerKeySet };
