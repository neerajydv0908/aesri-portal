/**
 * Pure helpers for translating free text (no database, no network), so the
 * rules can be tested: what counts as the same text, which texts (and which
 * of their lines) need a Hindi translation, and how a text is cut into lines
 * and put back together.
 */
import crypto from "node:crypto";

/** Longest text sent for translation (a notice's body is at most 4,000 characters). */
export const TRANSLATE_MAX_CHARS = 5000;

/** The text as it is looked up and translated: Unicode NFC, without spaces at the ends or Windows line breaks. */
export function prepareSource(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

/** The fingerprint a translation is stored under (the original itself is not stored). */
export function sourceHash(prepared: string): string {
  return crypto.createHash("sha256").update(prepared, "utf8").digest("hex");
}

/** Quoted words and words in brackets: titles, quotations and glosses, not the sentence around them. */
const ASIDES = /“[^”]*”|"[^"]*"|‘[^’]*’|\([^)]*\)|\[[^\]]*\]/g;

/** Latin letters, and Devanagari letters (the vowel signs, virama and other marks don't count: they make Hindi words look longer). */
function letters(s: string): { latin: number; dev: number } {
  let latin = 0;
  let dev = 0;
  for (const ch of s) {
    if (/[A-Za-z]/.test(ch)) latin++;
    else if (/[ऄ-हऽॐक़-ॡॲ-ॿ]/.test(ch)) dev++;
  }
  return { latin, dev };
}

/**
 * Does a Hindi reader need this line translated? Yes when its sentence is
 * written in English letters — at least two of them, and more than the
 * Devanagari ones — not counting quoted words or words in brackets: "Learn
 * “जल ही जीवन है”" needs Hindi, "कविता याद करें (poem)" doesn't. Numbers,
 * dates and codes are shown as they are.
 */
export function lineNeedsHindi(line: string): boolean {
  const outside = letters(line.replace(ASIDES, " "));
  const { latin, dev } = outside.latin + outside.dev > 0 ? outside : letters(line);
  return latin >= 2 && latin > dev;
}

/** Does a Hindi reader need this (prepared) text translated: does any of its lines? */
export function needsHindi(prepared: string): boolean {
  if (!prepared || prepared.length > TRANSLATE_MAX_CHARS) return false;
  return prepared.split("\n").some(lineNeedsHindi);
}

/**
 * A text cut into its lines and the line breaks between them, so paragraphs
 * come back exactly as they were written. Only the lines that need Hindi are
 * translated; lines already in Hindi, blank ones and numbers stay as written.
 */
export function splitLines(prepared: string): { parts: string[]; translate: boolean[] } {
  const parts = prepared.split(/(\n+)/);
  return { parts, translate: parts.map((p, i) => i % 2 === 0 && lineNeedsHindi(p)) };
}

/** Put a text back together from its parts, with the translated lines in place. */
export function joinLines(parts: string[], translate: boolean[], translated: string[]): string {
  let k = 0;
  return parts.map((p, i) => (translate[i] ? (translated[k++] ?? p) : p)).join("");
}
