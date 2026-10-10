/**
 * The workings of Hindi for families (lib/translate/index.ts wires them to
 * the database, the server's settings and Next's `after`): which texts to
 * look up, the requests to the translation service, and what happens when
 * it is slow or fails. No "server-only" or Next imports, so it can be tested
 * on its own.
 *
 *  - A text is translated once and kept (lib/translate/cache.ts), line by
 *    line: lines already in Hindi, blank lines and numbers stay as written.
 *  - New texts go out in small requests, one after another; each request
 *    has its own time limit, and what it brings back is kept at once — a
 *    later failure loses nothing already translated.
 *  - Texts on their way are shared: a second page asking for the same text
 *    waits for the same request.
 *  - When a request fails — the key refused, the service busy or out of
 *    reach — no requests go for a while (ten minutes, a minute, or as long
 *    as the service asked). When it sends nothing for some texts, those wait
 *    half an hour and the others carry on.
 *  - A page waits at most its time budget; whatever isn't back by then is
 *    shown as written and arrives for the next visit.
 */
import type { Tx } from "@/lib/db/client";
import { langOfText, type Lang } from "@/lib/i18n";
import { storedHindi, storeHindi, touchHindi } from "./cache";
import { MAX_REQUEST_CHARS, MAX_REQUEST_ITEMS, TranslateError, type TranslateFailure, type Translator } from "./providers";
import { joinLines, needsHindi, prepareSource, splitLines } from "./text";

export type FamilyTextValue = {
  /** What to show. */
  text: string;
  /** Its language (for the lang attribute: fonts, screen readers). */
  lang: Lang;
  /** The words as written, when `text` is a translation. */
  original?: string;
  /** Written in English, and no Hindi translation is available (yet). */
  untranslated?: boolean;
};

/** Look up one text (it must have been among those given to familyTexts); `translated` / `untranslated` count those texts. */
export type FamilyTextLookup = ((text: string | null | undefined) => FamilyTextValue | null) & { translated: number; untranslated: number };

/** What is kept between requests: on globalThis in the server (so it survives reloads in development), fresh in tests. */
export type EngineState = {
  /** Texts on their way to the service, and what they will become (null: not translated). */
  inflight: Map<string, Promise<string | null>>;
  /** No requests before this time (ms). */
  restUntil: number;
  /** Texts the service refused lately, and when they may be sent again (ms). */
  refused: Map<string, number>;
};

export const newEngineState = (): EngineState => ({ inflight: new Map(), restUntil: 0, refused: new Map() });

export type EngineDeps = {
  /** The translation service as set up now (null: off). */
  translator: () => Translator | null;
  db: () => Promise<Tx>;
  /** Run work after the response has gone (or just let it run). */
  background: (work: () => Promise<unknown>) => void;
  /** The demo's own Hindi, when the demo data is in the database (null otherwise). */
  phrasebook: () => Promise<Readonly<Record<string, string>> | null>;
  /** How long a family's page waits for new translations (ms). */
  waitMs: () => number;
  log?: (message: string) => void;
  now?: () => number;
  /** Time limit for one request (ms). */
  requestTimeoutMs?: number;
};

/**
 * How long no requests go after a request failed: the key refused, or the
 * request itself refused (a wrong address or setting — the portal's requests
 * are small and well-formed, so this isn't about the text): ten minutes;
 * busy or unreachable: a minute.
 */
export const REST_MS: Record<TranslateFailure, number> = { auth: 10 * 60_000, content: 10 * 60_000, busy: 60_000, down: 60_000 };
/** How long a text the service sent no translation for waits before it is sent again (the others carry on). */
export const REFUSED_MS = 30 * 60_000;
const REFUSED_KEEP = 2000;

/** One text as it goes to the service: the lines to translate (or the whole text, when it has very many lines). */
type Piece = { prepared: string; parts: string[]; translate: boolean[]; lines: string[]; chars: number };

function piece(prepared: string): Piece {
  const { parts, translate } = splitLines(prepared);
  const lines = parts.filter((_, i) => translate[i]);
  if (lines.length <= MAX_REQUEST_ITEMS) return { prepared, parts, translate, lines, chars: lines.reduce((a, l) => a + l.length, 0) };
  return { prepared, parts: [prepared], translate: [true], lines: [prepared], chars: prepared.length };
}

/** Whole texts packed into requests of at most 100 lines and about 10,000 characters (a text is never split across two). */
export function packRequests<T extends { lines: string[]; chars: number }>(pieces: T[], maxItems = MAX_REQUEST_ITEMS, maxChars = MAX_REQUEST_CHARS): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let items = 0;
  let chars = 0;
  for (const p of pieces) {
    if (cur.length && (items + p.lines.length > maxItems || chars + p.chars > maxChars)) {
      out.push(cur);
      cur = [];
      items = 0;
      chars = 0;
    }
    cur.push(p);
    items += p.lines.length;
    chars += p.chars;
  }
  if (cur.length) out.push(cur);
  return out;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createEngine(deps: EngineDeps, state: EngineState) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(m));
  const timeoutMs = deps.requestTimeoutMs ?? 10_000;

  function forgetOldRefusals(t: number) {
    for (const [p, until] of state.refused) if (until <= t) state.refused.delete(p);
    // Never let the list grow without end: the oldest go first (a Map keeps the order they came in).
    for (const p of state.refused.keys()) {
      if (state.refused.size <= REFUSED_KEEP) break;
      state.refused.delete(p);
    }
  }

  /** A request failed: no requests for a while (REST_MS). */
  function rest(err: unknown) {
    const kind: TranslateFailure = err instanceof TranslateError ? err.kind : "down";
    const ms = kind === "busy" && err instanceof TranslateError && err.retryAfterMs ? err.retryAfterMs : REST_MS[kind];
    state.restUntil = Math.max(state.restUntil, now() + ms);
    const when = ms < 90_000 ? `${Math.max(1, Math.ceil(ms / 1000))} seconds` : `${Math.round(ms / 60_000)} minutes`;
    const hint = kind === "auth" ? " Check AZURE_TRANSLATOR_KEY and AZURE_TRANSLATOR_REGION (and the free tier's monthly limit)." : kind === "content" ? " Check AZURE_TRANSLATOR_ENDPOINT." : "";
    log(`[translate] Hindi translation failed: ${message(err)}.${hint} Families see new texts as written; trying again in ${when}.`);
  }

  /** The service sent nothing for some texts: shown as written, and not sent again for half an hour. */
  function refuse(texts: string[]) {
    for (const p of texts) state.refused.set(p, now() + REFUSED_MS);
    log(`[translate] Microsoft Translator sent no translation for ${texts.length} text${texts.length === 1 ? "" : "s"}. They are shown as written and tried again in 30 minutes.`);
  }

  /** Ask the service for texts nobody has asked for yet. Returns a promise per text (never rejected): the Hindi, or null. */
  function translateMissing(prepared: string[]): Map<string, Promise<string | null>> {
    const out = new Map<string, Promise<string | null>>();
    for (const p of prepared) {
      const running = state.inflight.get(p);
      if (running) out.set(p, running);
    }
    const t = deps.translator();
    const at = now();
    if (!t || state.restUntil > at) return out;
    forgetOldRefusals(at);
    const fresh = [...new Set(prepared)].filter((p) => !state.inflight.has(p) && !((state.refused.get(p) ?? 0) > at));
    if (!fresh.length) return out;

    const settle = new Map<string, (text: string | null) => void>();
    for (const p of fresh) {
      const promise = new Promise<string | null>((resolve) => settle.set(p, resolve));
      state.inflight.set(p, promise);
      out.set(p, promise);
    }
    const finish = (p: string, text: string | null) => {
      const resolve = settle.get(p);
      if (!resolve) return;
      settle.delete(p);
      state.inflight.delete(p);
      resolve(text);
    };

    void (async () => {
      for (const request of packRequests(fresh.map(piece))) {
        if (state.restUntil > now()) break; // another request failed meanwhile
        let hindi: (string | null)[];
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // The signal stops the request; the race makes sure this settles even if a request ignores it.
          hindi = await Promise.race([
            t.toHindi(
              request.flatMap((x) => x.lines),
              AbortSignal.timeout(timeoutMs),
            ),
            new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TranslateError(`no answer within ${Math.round(timeoutMs / 1000)} seconds`, "down")), timeoutMs + 1000))),
          ]);
        } catch (err) {
          for (const x of request) finish(x.prepared, null);
          rest(err);
          break;
        } finally {
          clearTimeout(timer);
        }
        const done: { prepared: string; text: string }[] = [];
        const refused: string[] = [];
        let k = 0;
        for (const x of request) {
          const mine = hindi.slice(k, k + x.lines.length);
          k += x.lines.length;
          if (mine.length !== x.lines.length || mine.some((h) => h === null)) {
            refused.push(x.prepared); // nothing came back for a line: shown as written, tried again later
            continue;
          }
          done.push({ prepared: x.prepared, text: joinLines(x.parts, x.translate, mine as string[]) });
        }
        if (refused.length) {
          refuse(refused);
          for (const p of refused) finish(p, null);
        }
        try {
          await storeHindi(await deps.db(), done, t.name);
        } catch (err) {
          log(`[translate] Couldn't keep ${done.length} translation${done.length === 1 ? "" : "s"}: ${message(err)}`);
        }
        for (const d of done) finish(d.prepared, d.text);
      }
    })()
      .catch((err: unknown) => log(`[translate] ${message(err)}`))
      .finally(() => {
        for (const p of [...settle.keys()]) finish(p, null);
      });
    return out;
  }

  /**
   * Hindi for these prepared texts: the demo's own, then the stored ones,
   * then new ones from the service — waiting at most `waitMs` for those.
   */
  async function hindiFor(prepared: string[], waitMs: number): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (!prepared.length) return found;
    const book = await deps.phrasebook();
    if (book) for (const p of prepared) if (Object.hasOwn(book, p)) found.set(p, book[p]);
    const rest = prepared.filter((p) => !found.has(p));
    if (!rest.length) return found;
    const db = await deps.db();
    const stored = await storedHindi(db, rest);
    for (const [p, text] of stored) found.set(p, text);
    if (stored.size) deps.background(() => touchHindi(db, [...stored.keys()]));
    const missing = rest.filter((p) => !stored.has(p));
    if (!missing.length || !deps.translator()) return found;

    const work = translateMissing(missing);
    if (!work.size) return found;
    const arrived = new Map<string, string>();
    const all = Promise.all([...work].map(([p, promise]) => promise.then((text) => void (text && arrived.set(p, text)))));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
    for (const [p, text] of arrived) found.set(p, text);
    if (arrived.size < work.size) deps.background(() => all); // the rest is kept for the next visit
    return found;
  }

  const wantedOf = (texts: (string | null | undefined)[]) => [...new Set(texts.filter((s): s is string => !!s && !!s.trim()).map(prepareSource))].filter(needsHindi);

  /**
   * Every text a family page will show, looked up once. In English each text
   * is shown as written; in Hindi, English text comes back translated (with
   * the original), or as written marked `untranslated`.
   */
  async function familyTexts(lang: Lang, texts: (string | null | undefined)[]): Promise<FamilyTextLookup> {
    const asWritten = (s: string): FamilyTextValue => ({ text: s, lang: langOfText(s) });
    if (lang !== "hi") return Object.assign((s: string | null | undefined) => (s && s.trim() ? asWritten(s) : null), { translated: 0, untranslated: 0 });
    const wanted = wantedOf(texts);
    let found = new Map<string, string>();
    try {
      found = await hindiFor(wanted, deps.waitMs());
    } catch (err) {
      log(`[translate] ${message(err)}`);
    }
    const lookup = (s: string | null | undefined): FamilyTextValue | null => {
      if (!s || !s.trim()) return null;
      const p = prepareSource(s);
      if (!needsHindi(p)) return asWritten(s);
      const hi = found.get(p);
      if (hi === undefined) return { text: s, lang: "en", untranslated: true };
      // The same in both languages (a name, a page number): nothing to show twice.
      if (prepareSource(hi) === p) return asWritten(s);
      return { text: hi, lang: "hi", original: s };
    };
    const translated = wanted.filter((p) => found.has(p) && prepareSource(found.get(p)!) !== p).length;
    return Object.assign(lookup, { translated, untranslated: wanted.filter((p) => !found.has(p)).length });
  }

  /**
   * Get the Hindi of newly written text ready, so families don't wait for it
   * (from a Server Action, after saving). Does nothing when the service is
   * off. `wait`: finish first (at most a few seconds) — a notice, whose text
   * message is written in Hindi straight away; otherwise it runs after the
   * response.
   */
  async function prepareHindi(texts: (string | null | undefined)[], opts: { wait?: boolean } = {}): Promise<void> {
    if (!deps.translator()) return;
    const wanted = wantedOf(texts);
    if (!wanted.length) return;
    if (opts.wait) {
      try {
        await hindiFor(wanted, 4000);
      } catch (err) {
        log(`[translate] ${message(err)}`);
      }
      return;
    }
    deps.background(() => hindiFor(wanted, 60_000));
  }

  return { familyTexts, prepareHindi, translateMissing, hindiFor };
}
