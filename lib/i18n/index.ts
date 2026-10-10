/** Two languages: English and Hindi. Pick a string with t("English", "हिंदी"). */
export type Lang = "en" | "hi";

export function tr(lang: Lang) {
  return (en: string, hi: string) => (lang === "hi" ? hi : en);
}

/**
 * The reader's language is remembered in this cookie for a year: set by the
 * EN / हिं switch (lib/actions/lang.ts), and by a link from the public
 * website that carries ?lang=hi or ?lang=en (proxy.ts). Read by getLang().
 */
export const LANG_COOKIE = "lang";
export const LANG_COOKIE_OPTIONS = { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: false } as const;

/**
 * The language a line of text is written in, from its script: "hi" when most
 * of its letters are Devanagari, else "en". For free text such as a
 * report-card remark, so screen readers and fonts treat each line right.
 */
export function langOfText(text: string): Lang {
  let dev = 0;
  let latin = 0;
  for (const ch of text) {
    if (/[ऀ-ॿ]/.test(ch)) dev++;
    else if (/[A-Za-z]/.test(ch)) latin++;
  }
  return dev > latin ? "hi" : "en";
}

/** The schools' places in Devanagari, for families reading Hindi ("Palana, Bikaner" → "पलाना, बीकानेर"). Other words stay as written. */
const PLACES_HI: Record<string, string> = { Palana: "पलाना", Udairamsar: "उदयरामसर", Bikaner: "बीकानेर", Rajasthan: "राजस्थान" };
export function placeIn(place: string, lang: Lang): string {
  return lang === "hi" ? place.replace(/[A-Za-z]+/g, (w) => PLACES_HI[w] ?? w) : place;
}
