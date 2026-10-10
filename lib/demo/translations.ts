/**
 * The demo's English texts in Hindi (lib/demo/texts.ts), by the text as
 * lib/translate prepares it. Used only while the demo data is in the
 * database (demoDataPresent), so trying the portal shows homework and
 * remarks in Hindi without a translation service.
 */
import { prepareSource } from "@/lib/translate/text";
import { APPRECIATIONS, CONCERNS, HOMEWORK_IDEAS, LOW_ATTENDANCE_CONCERN } from "./texts";

function phrasebook(): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (en: string | undefined, hi: string | undefined) => {
    if (en && hi) out[prepareSource(en)] = hi;
  };
  for (const ideas of Object.values(HOMEWORK_IDEAS)) {
    for (const h of ideas) {
      add(h.title, h.titleHi);
      add(h.details, h.detailsHi);
    }
  }
  for (const r of [...APPRECIATIONS, ...CONCERNS, LOW_ATTENDANCE_CONCERN]) {
    add(r.note, r.noteHi);
    add(r.action, r.actionHi);
  }
  return out;
}

export const DEMO_HINDI: Readonly<Record<string, string>> = phrasebook();
