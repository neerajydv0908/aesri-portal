/**
 * The translation service: Microsoft Translator (Azure AI Translator, Text
 * Translation v3). It is sent only the text to translate, from English to
 * Hindi, and — Microsoft's "no trace" policy — doesn't keep it. Each call is
 * one request; the caller keeps requests small (batches(): at most 100 texts
 * and about 10,000 characters), so a page never waits long.
 *
 * `fetch` can be replaced for tests: the real service is never called there.
 */
import type { TranslateProviderName } from "./config";

/**
 * Why a request failed, which decides what happens next (lib/translate/engine.ts):
 *  - "auth": the key was refused (401, 403 — also a used-up free tier): leave the service alone for a while;
 *  - "busy": too many requests (429): wait a minute, or as long as the service asked;
 *  - "down": the service couldn't be reached, timed out or failed itself (5xx): wait a minute;
 *  - "content": it refused the request itself (another 4xx, an answer that doesn't fit): most likely a wrong
 *    address or setting — the portal's requests are small and well-formed — so also leave it alone for a while.
 */
export type TranslateFailure = "auth" | "busy" | "down" | "content";

export class TranslateError extends Error {
  constructor(
    message: string,
    public kind: TranslateFailure,
    /** For "busy": how long the service asked us to wait (Retry-After), when it said. */
    public retryAfterMs?: number,
  ) {
    super(message);
  }
  /** Worth trying the same texts again later (network, timeout, too many requests, the service's own fault). */
  get retryable(): boolean {
    return this.kind === "busy" || this.kind === "down";
  }
}

export type Translator = {
  name: Exclude<TranslateProviderName, "off">;
  /** English → Hindi in one request: one result per text, in order — null for a text the service sent nothing for. */
  toHindi(texts: string[], signal?: AbortSignal): Promise<(string | null)[]>;
};

export const MAX_REQUEST_ITEMS = 100;
export const MAX_REQUEST_CHARS = 10_000;

/** Texts in batches small enough for one request each. */
export function batches(texts: string[], maxItems = MAX_REQUEST_ITEMS, maxChars = MAX_REQUEST_CHARS): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const t of texts) {
    if (cur.length && (cur.length >= maxItems || chars + t.length > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += t.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

type AzureAnswer = { translations?: { text?: unknown; to?: unknown }[] }[];

/** Retry-After in milliseconds (seconds, or an HTTP date), at most ten minutes. */
function retryAfter(res: Response): number | undefined {
  const v = res.headers.get("retry-after")?.trim();
  if (!v) return undefined;
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 10 * 60_000) : undefined;
}

export function azureTranslator(settings: { key: string; region: string | null; endpoint: string }, fetchImpl: typeof fetch = fetch): Translator {
  const url = `${settings.endpoint}/translate?api-version=3.0&from=en&to=hi&textType=plain`;
  return {
    name: "azure",
    async toHindi(texts, signal) {
      if (!texts.length) return [];
      let res: Response;
      let body: string;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": settings.key,
            ...(settings.region ? { "Ocp-Apim-Subscription-Region": settings.region } : {}),
            "Content-Type": "application/json; charset=UTF-8",
          },
          body: JSON.stringify(texts.map((text) => ({ text }))),
          // Never follow a redirect: the key and the text would go with it to another address.
          redirect: "error",
          signal,
        });
        body = await res.text();
      } catch (err) {
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
        const what = `${err instanceof Error ? err.message : String(err)}${cause ? ` (${cause})` : ""}`;
        // Sent elsewhere by a redirect (refused above): the address is wrong, not the service down.
        if (/redirect/i.test(what)) throw new TranslateError(`Microsoft Translator's address answered with a redirect, which isn't followed: ${what}`, "content");
        throw new TranslateError(`Microsoft Translator could not be reached: ${what}`, "down");
      }
      if (!res.ok) {
        let detail = "";
        try {
          const e = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
          detail = [e.error?.code, e.error?.message].filter(Boolean).join(" ");
        } catch {
          detail = body.slice(0, 200);
        }
        // Never put the key in an error: only the status and Microsoft's own message.
        const message = `Microsoft Translator answered ${res.status}${detail ? `: ${detail}` : ""}`;
        if (res.status === 401 || res.status === 403) throw new TranslateError(message, "auth");
        if (res.status === 429) throw new TranslateError(message, "busy", retryAfter(res));
        if (res.status >= 500) throw new TranslateError(message, "down");
        throw new TranslateError(message, "content");
      }
      let answer: AzureAnswer;
      try {
        answer = JSON.parse(body) as AzureAnswer;
      } catch {
        throw new TranslateError("Microsoft Translator sent an answer that isn't JSON.", "down");
      }
      if (!Array.isArray(answer) || answer.length !== texts.length) throw new TranslateError("Microsoft Translator's answer doesn't match the texts sent.", "content");
      return answer.map((a) => {
        const text = a?.translations?.[0]?.text;
        return typeof text === "string" && text.trim() ? text : null;
      });
    },
  };
}
