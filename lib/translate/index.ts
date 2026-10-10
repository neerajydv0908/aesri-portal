/**
 * Hindi for families: text that teachers and the office wrote in English —
 * homework, remarks, notices without a Hindi version, report-card remarks,
 * the school's note on a declined payment — shown in Hindi to families who
 * chose हिं.
 *
 *  - Pages call familyTexts(lang, [...texts]) once with every text they
 *    will show, then look each one up. In English nothing changes.
 *  - A translation is made once, by the translation service
 *    (lib/translate/providers.ts), when a Hindi reader first needs it — or
 *    straight after a teacher saves the text (prepareHindi, from the save's
 *    Server Action) — and kept (lib/translate/cache.ts).
 *  - A page waits at most TRANSLATE_WAIT_MS for new translations. Whatever
 *    isn't ready by then is shown as written, marked "written in English",
 *    and finished in the background for the next visit.
 *  - When the service is off or fails, families see the text as written: a
 *    page never fails because of translation (lib/translate/engine.ts says
 *    how failures are handled).
 *  - The demo's own texts come with their Hindi (lib/demo/translations.ts).
 *
 * Only the text itself is sent to the service — the portal adds nothing to
 * it (no names, IDs or records).
 */
import "server-only";
import { after } from "next/server";
import { getDb } from "@/lib/db/client";
import { demoDataPresent } from "@/lib/queries/app";
import { DEMO_HINDI } from "@/lib/demo/translations";
import { azureSettings, translateProviderName, translateWaitMs, TRANSLATE_PROVIDER_LABELS } from "./config";
import { azureTranslator, type Translator } from "./providers";
import { createEngine, newEngineState, type EngineState } from "./engine";

export type { FamilyTextLookup, FamilyTextValue } from "./engine";

const g = globalThis as unknown as {
  __translator?: { stamp: string; translator: Translator | null };
  __translateState?: EngineState;
};

/** The translation service as set up now (null: off). */
function translator(): Translator | null {
  const name = translateProviderName();
  const s = azureSettings();
  const stamp = `${name}|${s?.endpoint ?? ""}|${s?.region ?? ""}|${s?.key.length ?? 0}`;
  if (g.__translator?.stamp !== stamp) g.__translator = { stamp, translator: name === "azure" && s ? azureTranslator(s) : null };
  return g.__translator.translator;
}

/** Is a translation service set up? (Staff forms say whether families get a Hindi translation.) */
export function translationOn(): boolean {
  return translator() !== null;
}

export function translationProviderLabel(): string {
  return TRANSLATE_PROVIDER_LABELS[translator()?.name ?? "off"];
}

/** Run work after the response has gone (or simply let it run, outside a request). */
function inBackground(work: () => Promise<unknown>) {
  const safe = () => work().catch((err: unknown) => console.error(`[translate] ${err instanceof Error ? err.message : String(err)}`));
  try {
    after(safe);
  } catch {
    void safe();
  }
}

const engine = createEngine(
  {
    translator,
    db: getDb,
    background: inBackground,
    phrasebook: async () => ((await demoDataPresent()) ? DEMO_HINDI : null),
    waitMs: translateWaitMs,
  },
  (g.__translateState ??= newEngineState()),
);

/**
 * Every text a family page will show, looked up once. In English each text
 * is shown as written; in Hindi, English text comes back translated (with
 * the original), or as written marked `untranslated`.
 */
export const familyTexts = engine.familyTexts;

/**
 * Get the Hindi of newly written text ready, so families don't wait for it
 * (call from a Server Action, after saving). Does nothing when the service
 * is off. `wait`: finish before returning (a notice, whose text message is
 * written in Hindi straight away); otherwise it runs after the response.
 */
export const prepareHindi = engine.prepareHindi;
