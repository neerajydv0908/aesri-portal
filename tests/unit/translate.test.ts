/**
 * Hindi translation of what teachers and the office write (lib/translate):
 * which texts need translating, how paragraphs survive, the requests to
 * Microsoft Translator (fetch is mocked: the real service is never called),
 * the settings check, the stored translations, and the demo's own Hindi.
 *
 *   node --import tsx --test tests/unit/translate.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { joinLines, lineNeedsHindi, needsHindi, prepareSource, sourceHash, splitLines, TRANSLATE_MAX_CHARS } from "../../lib/translate/text";
import { azureTranslator, batches, TranslateError, type Translator } from "../../lib/translate/providers";
import { createEngine, newEngineState, packRequests, REFUSED_MS, REST_MS } from "../../lib/translate/engine";
import { translateConfigProblem, translateProviderName } from "../../lib/translate/config";
import { DEMO_HINDI } from "../../lib/demo/translations";
import { APPRECIATIONS, CONCERNS, HOMEWORK_IDEAS, LOW_ATTENDANCE_CONCERN } from "../../lib/demo/texts";

test("English text needs Hindi; Hindi text, numbers and codes don't", () => {
  assert.equal(needsHindi("Learn the spellings of lesson 4"), true);
  assert.equal(needsHindi("Write 10 lines on “मेरा गाँव”"), true);
  assert.equal(needsHindi("शब्द रूप: ‘बालक’ सभी विभक्तियों में"), false);
  assert.equal(needsHindi("कविता याद करें (poem)"), false);
  assert.equal(needsHindi("4.2, 1–10"), false);
  assert.equal(needsHindi("A"), false);
  assert.equal(needsHindi(""), false);
  assert.equal(needsHindi("x".repeat(TRANSLATE_MAX_CHARS + 1)), false);
});

test("an English instruction around quoted Hindi words needs Hindi; a Hindi sentence with an English word in brackets doesn't", () => {
  assert.equal(needsHindi("Learn “जल ही जीवन है”"), true);
  assert.equal(needsHindi("Revise “संज्ञा” and “सर्वनाम”"), true);
  assert.equal(needsHindi("Write 10 lines on “मेरा गाँव” and “मेरा विद्यालय”"), true);
  assert.equal(needsHindi('Read "ईदगाह" again'), true);
  assert.equal(needsHindi("‘The Road Not Taken’ कविता पढ़ें"), false);
  assert.equal(needsHindi("(Bring your notebook)"), true);
  // Line by line: one English line is enough, and only that line is sent.
  assert.equal(needsHindi("Read page 5.\nकविता याद करें"), true);
  assert.deepEqual(splitLines("Read page 5.\nकविता याद करें\n\n4.2, 1–10").translate, [true, false, false, false, false]);
  assert.equal(lineNeedsHindi("Don't forget the diary"), true);
});

test("the same text is found again however its spaces and line ends were typed", () => {
  assert.equal(prepareSource("  Bring the diary.\r\n\r\nThank you. "), "Bring the diary.\n\nThank you.");
  assert.equal(sourceHash(prepareSource("Hello ")), sourceHash(prepareSource("Hello")));
  assert.notEqual(sourceHash("Hello"), sourceHash("Hello."));
  assert.match(sourceHash("x"), /^[0-9a-f]{64}$/);
});

test("paragraphs come back exactly as written, with only the lines translated", () => {
  const p = prepareSource("Write each word three times.\n\nBring your copy on Monday.\nThanks");
  const { parts, translate } = splitLines(p);
  assert.deepEqual(parts, ["Write each word three times.", "\n\n", "Bring your copy on Monday.", "\n", "Thanks"]);
  assert.deepEqual(translate, [true, false, true, false, true]);
  assert.equal(joinLines(parts, translate, ["अ", "ब", "स"]), "अ\n\nब\nस");
});

test("requests stay small: at most 100 texts and about 10,000 characters each", () => {
  assert.deepEqual(
    batches(["a", "b", "c"], 2, 100).map((b) => b.length),
    [2, 1],
  );
  assert.deepEqual(
    batches(["x".repeat(6000), "y".repeat(6000), "z"], 100, 10_000).map((b) => b.length),
    [1, 2],
  );
  assert.equal(batches(Array(250).fill("t")).length, 3);
});

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: (body: { text: string }[]) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const sent = JSON.parse(String(init?.body ?? "[]")) as { text: string }[];
    const a = answer(sent);
    return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

test("Microsoft Translator: English to Hindi, with the key and region, one answer per text", async () => {
  const { f, calls } = fakeFetch((sent) => ({ status: 200, body: sent.map((s) => ({ translations: [{ text: `हि:${s.text}`, to: "hi" }] })) }));
  const t = azureTranslator({ key: "k-123", region: "centralindia", endpoint: "https://api.cognitive.microsofttranslator.com" }, f);
  assert.deepEqual(await t.toHindi(["Hello", "Good work"]), ["हि:Hello", "हि:Good work"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=hi&textType=plain");
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h["Ocp-Apim-Subscription-Key"], "k-123");
  assert.equal(h["Ocp-Apim-Subscription-Region"], "centralindia");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), [{ text: "Hello" }, { text: "Good work" }]);
  // A redirect would take the key and the text to another address: refused, and reported as a settings problem.
  assert.equal(calls[0].init.redirect, "error");
  const redirected = (async () => {
    throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
  }) as unknown as typeof fetch;
  await assert.rejects(azureTranslator({ key: "k", region: null, endpoint: "https://x" }, redirected).toHindi(["Hi"]), (err: unknown) => err instanceof TranslateError && err.kind === "content" && /redirect/.test(err.message));
  // A global resource needs no region header.
  const g = fakeFetch((sent) => ({ status: 200, body: sent.map(() => ({ translations: [{ text: "ठीक" }] })) }));
  await azureTranslator({ key: "k", region: null, endpoint: "https://x.example" }, g.f).toHindi(["Fine"]);
  assert.equal((g.calls[0].init.headers as Record<string, string>)["Ocp-Apim-Subscription-Region"], undefined);
});

test("Microsoft Translator's refusals say what went wrong, never the key, and whether to try again", async () => {
  const refused = fakeFetch(() => ({ status: 401, body: { error: { code: 401000, message: "The request is not authorized because credentials are missing or invalid." } } }));
  await assert.rejects(azureTranslator({ key: "secret-key-xyz", region: "centralindia", endpoint: "https://x" }, refused.f).toHindi(["Hi there"]), (err: unknown) => {
    assert.ok(err instanceof TranslateError);
    assert.equal(err.retryable, false);
    assert.match(err.message, /401/);
    assert.doesNotMatch(err.message, /secret-key-xyz/);
    return true;
  });
  const busy = fakeFetch(() => ({ status: 429, body: { error: { code: 429001, message: "Too many requests" } } }));
  await assert.rejects(azureTranslator({ key: "k", region: null, endpoint: "https://x" }, busy.f).toHindi(["Hi there"]), (err: unknown) => err instanceof TranslateError && err.retryable && err.kind === "busy");
  const slowDown = (async () => new Response("{}", { status: 429, headers: { "retry-after": "120" } })) as unknown as typeof fetch;
  await assert.rejects(azureTranslator({ key: "k", region: null, endpoint: "https://x" }, slowDown).toHindi(["Hi there"]), (err: unknown) => err instanceof TranslateError && err.retryAfterMs === 120_000);
  const quota = fakeFetch(() => ({ status: 403, body: { error: { code: 403001, message: "Out of call volume quota" } } }));
  await assert.rejects(azureTranslator({ key: "k", region: null, endpoint: "https://x" }, quota.f).toHindi(["Hi there"]), (err: unknown) => err instanceof TranslateError && err.kind === "auth");
  const bad = fakeFetch(() => ({ status: 400, body: { error: { code: 400000, message: "One of the request inputs is not valid." } } }));
  await assert.rejects(azureTranslator({ key: "k", region: null, endpoint: "https://x" }, bad.f).toHindi(["Hi there"]), (err: unknown) => err instanceof TranslateError && err.kind === "content" && !err.retryable);
  const short = fakeFetch(() => ({ status: 200, body: [] }));
  await assert.rejects(azureTranslator({ key: "k", region: null, endpoint: "https://x" }, short.f).toHindi(["Hi there"]), /doesn't match/);
  // An empty answer for one text: null for that text only.
  const gap = fakeFetch(() => ({ status: 200, body: [{ translations: [{ text: "नमस्ते" }] }, { translations: [{ text: " " }] }] }));
  assert.deepEqual(await azureTranslator({ key: "k", region: null, endpoint: "https://x" }, gap.f).toHindi(["Hello", "Bye"]), ["नमस्ते", null]);
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  await assert.rejects(azureTranslator({ key: "k", region: null, endpoint: "https://x" }, down).toHindi(["Hi there"]), (err: unknown) => err instanceof TranslateError && err.retryable);
});

test("settings: off by default; azure needs its key and an https endpoint", () => {
  const keep = { ...process.env };
  try {
    delete process.env.TRANSLATE_PROVIDER;
    delete process.env.AZURE_TRANSLATOR_KEY;
    assert.equal(translateProviderName(), "off");
    assert.equal(translateConfigProblem(), null);
    process.env.TRANSLATE_PROVIDER = "google";
    assert.match(translateConfigProblem() ?? "", /must be azure/);
    process.env.TRANSLATE_PROVIDER = "azure";
    assert.match(translateConfigProblem() ?? "", /AZURE_TRANSLATOR_KEY/);
    process.env.AZURE_TRANSLATOR_KEY = "k";
    process.env.AZURE_TRANSLATOR_REGION = "centralindia";
    assert.equal(translateConfigProblem(), null);
    process.env.AZURE_TRANSLATOR_ENDPOINT = "http://insecure.example";
    assert.match(translateConfigProblem() ?? "", /https/);
    process.env.AZURE_TRANSLATOR_ENDPOINT = "";
    process.env.AZURE_TRANSLATOR_REGION = "Central India";
    assert.match(translateConfigProblem() ?? "", /region name/);
  } finally {
    process.env = keep;
  }
});

test("the demo comes with Hindi for every English homework and remark it writes", () => {
  const english: string[] = [];
  for (const ideas of Object.values(HOMEWORK_IDEAS)) for (const h of ideas) english.push(h.title, ...(h.details ? [h.details] : []));
  for (const r of [...APPRECIATIONS, ...CONCERNS, LOW_ATTENDANCE_CONCERN]) english.push(r.note, ...(r.action ? [r.action] : []));
  for (const en of english) {
    const p = prepareSource(en);
    if (!needsHindi(p)) continue;
    assert.ok(DEMO_HINDI[p], `no Hindi for the demo text "${en}"`);
    assert.equal(needsHindi(prepareSource(DEMO_HINDI[p])), false, `the Hindi for "${en}" is mostly in English letters`);
  }
});

// The stored translations, against a real (embedded) PostgreSQL.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-translate-test-"));
process.env.PGLITE_DIR = dir;
delete process.env.DATABASE_URL;
let loaded: { client: typeof import("../../lib/db/client"); cache: typeof import("../../lib/translate/cache") } | undefined;
const mods = async () => (loaded ??= { client: await import("../../lib/db/client"), cache: await import("../../lib/translate/cache") });

after(async () => {
  if (loaded) await loaded.client.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("translations are kept by fingerprint, found again, kept once, and cleared when unused for 180 days", async () => {
  const { client, cache } = await mods();
  const db = await client.getDb();
  const a = prepareSource("Bring the school diary.");
  await cache.storeHindi(db, [{ prepared: a, text: "स्कूल की डायरी लाएँ।" }], "azure");
  await cache.storeHindi(db, [{ prepared: a, text: "a second answer is ignored" }], "azure");
  assert.equal((await cache.storedHindi(db, [a, "Something else"])).get(a), "स्कूल की डायरी लाएँ।");
  assert.equal(await cache.cachedHindi(db, "  Bring the school diary. "), "स्कूल की डायरी लाएँ।");
  assert.equal(await cache.cachedHindi(db, "कोई हिंदी पाठ"), null);
  assert.equal(await cache.cachedHindi(db, null), null);
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`update text_translations set used_at = now() - interval '200 days'`);
  await cache.touchHindi(db, [a]); // read again: kept
  assert.equal(await cache.purgeUnusedTranslations(db), 0);
  await db.execute(sql`update text_translations set used_at = now() - interval '200 days'`);
  assert.equal(await cache.purgeUnusedTranslations(db), 1);
  assert.equal(await cache.cachedHindi(db, a), null);
  // A deleted remark's translation goes at the next clean-up — unless the same words are read again first.
  const b = prepareSource("Spoke rudely to a classmate; we talked about it.");
  const c = prepareSource("Good work this week.");
  await cache.storeHindi(db, [{ prepared: b, text: "सहपाठी से बदतमीज़ी से बात की; हमने इस पर बात की।" }, { prepared: c, text: "इस सप्ताह अच्छा काम।" }], "azure");
  await cache.expireHindi(db, [` ${b} `, c, null]);
  await cache.touchHindi(db, [c]); // still shown elsewhere, and read
  assert.equal(await cache.purgeUnusedTranslations(db), 1);
  assert.equal(await cache.cachedHindi(db, b), null);
  assert.equal(await cache.cachedHindi(db, c), "इस सप्ताह अच्छा काम।");
});

test("texts are packed whole into requests of at most 100 lines and about 10,000 characters", () => {
  const p = (n: number, chars = 10) => ({ lines: Array(n).fill("x"), chars });
  assert.deepEqual(
    packRequests([p(60), p(50), p(10)]).map((r) => r.length),
    [1, 2],
  );
  assert.deepEqual(
    packRequests([p(1, 6000), p(1, 6000), p(1, 10)]).map((r) => r.length),
    [1, 2],
  );
});

/* ---------------------------------------------------------------- */
/* The engine: requests, waiting, failures (a fake service)          */
/* ---------------------------------------------------------------- */

type ServiceCall = { texts: string[] };
function fakeService(answer: (texts: string[], n: number) => Promise<(string | null)[]> | (string | null)[]) {
  const calls: ServiceCall[] = [];
  const translator: Translator = {
    name: "azure",
    async toHindi(texts) {
      calls.push({ texts });
      return answer(texts, calls.length);
    },
  };
  return { translator, calls };
}

async function engineWith(service: { translator: Translator }, opts: { waitMs?: number } = {}) {
  const { client } = await mods();
  let clock = Date.now();
  const logs: string[] = [];
  const background: Promise<unknown>[] = [];
  const state = newEngineState();
  const engine = createEngine(
    {
      translator: () => service.translator,
      db: client.getDb,
      background: (work) => void background.push(work()),
      phrasebook: async () => null,
      waitMs: () => opts.waitMs ?? 2000,
      log: (m) => void logs.push(m),
      now: () => clock,
    },
    state,
  );
  return { engine, state, logs, settle: () => Promise.all(background), tick: (ms: number) => void (clock += ms) };
}

const hi = (texts: string[]) => texts.map((t) => `हिंदी(${t})`);
const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2, 8)}`;

test("a family page gets its English texts in Hindi once; the next page reads them without asking again", async () => {
  const svc = fakeService(hi);
  const { engine } = await engineWith(svc);
  const a = unique("Bring the diary on Monday");
  const b = unique("Practice the table of 7");
  const say = await engine.familyTexts("hi", [a, b, "कविता याद करें", null]);
  assert.equal(svc.calls.length, 1);
  assert.deepEqual(say(a), { text: `हिंदी(${a})`, lang: "hi", original: a });
  assert.deepEqual(say("कविता याद करें"), { text: "कविता याद करें", lang: "hi" });
  assert.equal(say.translated, 2);
  const again = await engine.familyTexts("hi", [a, b]);
  assert.equal(svc.calls.length, 1, "kept, not asked again");
  assert.equal(again(b)?.text, `हिंदी(${b})`);
  // In English nothing is looked up.
  const en = await engine.familyTexts("en", [unique("Something new")]);
  assert.equal(en.translated, 0);
  assert.equal(svc.calls.length, 1);
});

test("only the English lines of a text are sent, and paragraphs come back as written", async () => {
  const svc = fakeService(hi);
  const { engine } = await engineWith(svc);
  const line = unique("Read page 5.");
  const say = await engine.familyTexts("hi", [`${line}\n\nकविता याद करें\n4.2, 1–10`]);
  assert.deepEqual(svc.calls[0].texts, [line]);
  assert.equal(say(`${line}\n\nकविता याद करें\n4.2, 1–10`)?.text, `हिंदी(${line})\n\nकविता याद करें\n4.2, 1–10`);
});

test("what each request brings back is kept even when a later request fails; the service then rests", async () => {
  // Five notices of about 4,000 characters go two to a request, in three requests; the second is refused as too many.
  const texts = [0, 1, 2, 3, 4].map((i) => `${unique(`Notice ${i}`)} ${"word ".repeat(790)}`.trim());
  const svc = fakeService((t, n) => {
    if (n === 2) throw new TranslateError("Microsoft Translator answered 429: Too many requests", "busy");
    return hi(t);
  });
  const { engine, state, logs, tick } = await engineWith(svc);
  const say = await engine.familyTexts("hi", texts);
  assert.equal(svc.calls.length, 2, "the third request isn't sent while the service rests");
  assert.deepEqual(svc.calls.map((c) => c.texts.length), [2, 2]);
  assert.equal(say(texts[0])?.lang, "hi");
  assert.equal(say(texts[1])?.lang, "hi");
  for (const t of texts.slice(2)) assert.equal(say(t)?.untranslated, true);
  assert.equal(say.untranslated, 3);
  assert.ok(state.restUntil > Date.now() && state.restUntil <= Date.now() + REST_MS.busy + 5_000);
  assert.ok(logs.some((l) => l.includes("429")));
  // While it rests, nothing is sent.
  await engine.familyTexts("hi", texts);
  assert.equal(svc.calls.length, 2);
  // Afterwards only what is missing goes.
  tick(REST_MS.busy + 1);
  const later = await engine.familyTexts("hi", texts);
  assert.deepEqual(svc.calls.slice(2).map((c) => c.texts), [[texts[2], texts[3]], [texts[4]]], "the kept ones aren't sent again");
  assert.equal(later.untranslated, 0);
});

test("a request the service refuses (a wrong address, say) rests it for ten minutes, and says what to check", async () => {
  const svc = fakeService(() => {
    throw new TranslateError("Microsoft Translator answered 404", "content");
  });
  const { engine, state, logs } = await engineWith(svc);
  const say = await engine.familyTexts("hi", [unique("Bring your library book"), unique("Exam timetable")]);
  assert.equal(say.untranslated, 2);
  assert.equal(svc.calls.length, 1);
  assert.ok(state.restUntil >= Date.now() + REST_MS.content - 5_000);
  assert.ok(logs.some((l) => l.includes("AZURE_TRANSLATOR_ENDPOINT")));
});

test("a refused key rests the service for ten minutes", async () => {
  const svc = fakeService(() => {
    throw new TranslateError("Microsoft Translator answered 401", "auth");
  });
  const { engine, state } = await engineWith(svc);
  const say = await engine.familyTexts("hi", [unique("Exam on Friday")]);
  assert.equal(say.untranslated, 1);
  assert.ok(state.restUntil >= Date.now() + REST_MS.auth - 5_000);
});

test("texts the service refuses are set aside for half an hour; the others carry on", async () => {
  const bad = unique("A text the service refuses");
  const good = unique("A text it translates");
  const svc = fakeService((t) => t.map((x) => (x === bad ? null : `हिंदी(${x})`)));
  const { engine, state, tick } = await engineWith(svc);
  const say = await engine.familyTexts("hi", [bad, good]);
  assert.equal(say(good)?.lang, "hi");
  assert.equal(say(bad)?.untranslated, true);
  assert.equal(state.restUntil, 0, "no rest for everyone");
  await engine.familyTexts("hi", [bad]);
  assert.equal(svc.calls.length, 1, "not sent again at once");
  tick(REFUSED_MS + 1);
  await engine.familyTexts("hi", [bad]);
  assert.equal(svc.calls.length, 2);
});

test("a slow service: the page waits only its budget, the translation arrives for the next visit, and two pages share one request", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const svc = fakeService(async (t) => {
    await gate;
    return hi(t);
  });
  const { engine, settle } = await engineWith(svc, { waitMs: 50 });
  const text = unique("Wear the school uniform tomorrow");
  const [first, second] = await Promise.all([engine.familyTexts("hi", [text]), engine.familyTexts("hi", [text])]);
  assert.equal(first(text)?.untranslated, true);
  assert.equal(second(text)?.untranslated, true);
  assert.equal(svc.calls.length, 1, "one request for both pages");
  release();
  await settle();
  const next = await engine.familyTexts("hi", [text]);
  assert.equal(next(text)?.lang, "hi");
  assert.equal(svc.calls.length, 1);
});

test("a request that never answers (and ignores its time limit) still ends, and the service rests", async () => {
  const svc = fakeService(() => new Promise<(string | null)[]>(() => {}));
  const { client } = await mods();
  const state = newEngineState();
  const engine = createEngine(
    { translator: () => svc.translator, db: client.getDb, background: () => {}, phrasebook: async () => null, waitMs: () => 5_000, log: () => {}, requestTimeoutMs: 50 },
    state,
  );
  const text = unique("Practice for the annual day");
  const say = await engine.familyTexts("hi", [text]);
  assert.equal(say(text)?.untranslated, true);
  assert.equal(state.inflight.size, 0);
  assert.ok(state.restUntil > Date.now());
});

test("prepareHindi translates newly written text ahead of families, and never throws", async () => {
  const svc = fakeService(hi);
  const { engine, settle } = await engineWith(svc);
  const text = unique("Sports day on Saturday");
  await engine.prepareHindi([text, null, "कल छुट्टी है"]);
  await settle();
  assert.deepEqual(svc.calls.map((c) => c.texts.length), [1]);
  const down = fakeService(() => {
    throw new Error("ECONNRESET");
  });
  const e2 = await engineWith(down);
  await e2.engine.prepareHindi([unique("Fee reminder")], { wait: true });
  assert.ok(e2.state.restUntil > 0);
});
