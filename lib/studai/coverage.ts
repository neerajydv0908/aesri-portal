/**
 * Which of the school's subjects Stud-AI covers, for Settings. A subject it
 * wasn't trained on is shown to teachers as "Not enough data as of now" and
 * never decides a student's colour on its own (lib/support/rules.ts), so a
 * subject that IS covered must not end up there by its name alone ("English
 * Core", "Mathematics (Standard)"). This lists the school's subjects Stud-AI
 * won't cover and points out names that look like one it does, so the office
 * can rename them in Classes & subjects.
 *
 * Names are matched the way Stud-AI matches them (stud_ai/features.py,
 * normalise_subject: lower case, "_" read as a space, spaces collapsed, and
 * its aliases), after the clean-up the portal applies before sending them
 * (studAiName). The colour rule uses the same look-alike check: a result for a
 * look-alike name counts as unsure, never as "not covered" (lib/studai/estimates.ts
 * supportContext). Pure: no database, no Node modules.
 */

/**
 * A subject's name as Stud-AI is told it. Stud-AI matches names to the
 * subjects it was trained on, so text that looks the same must read the same:
 * Unicode compatibility forms are normalised (NFKC), invisible formatting
 * characters (zero-width spaces and joiners, often pasted in with a name) and
 * trailing punctuation ("Maths.") are removed, and spaces are collapsed. The
 * portal still shows the name exactly as the school wrote it.
 */
export function studAiName(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/[\s.,;:!]+$/u, "")
    .trim();
  return cleaned || name;
}

/** Stud-AI's own aliases (stud_ai/features.py normalise_subject). Keep in step with it. */
const STUD_AI_ALIASES: Record<string, string> = { maths: "mathematics", math: "mathematics", evs: "environmental studies" };

/** The subject as Stud-AI reads it ("Maths." → "mathematics"). */
export function studAiSubjectKey(name: string): string {
  const s = studAiName(name).toLowerCase().replace(/_/g, " ").split(/\s+/u).filter(Boolean).join(" ");
  return STUD_AI_ALIASES[s] ?? s;
}

/** Words that describe a paper or level without making it a different subject. */
const QUALIFIERS = new Set(["core", "language", "literature", "lit", "and", "standard", "std", "basic", "advanced", "elective", "general", "compulsory", "paper", "i", "ii", "iii", "1", "2", "3"]);

/**
 * The covered subject a name seems to mean, when Stud-AI won't recognise the
 * name itself: "English Core" → "english", "Mathematics (Standard)" →
 * "mathematics". Null when the name is covered as it is, or looks like no
 * covered subject ("Social Science", "Environmental Science").
 */
export function lookalike(name: string, trained: string[]): string | null {
  const known = trained.map((t) => t.toLowerCase());
  const key = studAiSubjectKey(name);
  if (known.includes(key)) return null;
  const words = key
    .replace(/\([^()]*\)/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .filter((w) => w && !QUALIFIERS.has(w));
  const core = words.join(" ");
  const k = STUD_AI_ALIASES[core] ?? core;
  return k && k !== key && known.includes(k) ? k : null;
}

/**
 * The school's subjects that Stud-AI covers, those it doesn't (with the
 * covered subject each one seems to mean, if any), and subjects that read as
 * the same subject to Stud-AI ("Maths" and "Mathematics", "Hindi" and
 * "Hindi."): in a class that has both, Stud-AI can answer for only one.
 */
export function subjectCoverage(
  names: string[],
  trained: string[],
): { covered: string[]; notCovered: { name: string; like: string | null }[]; sameSubject: { key: string; names: string[] }[] } {
  const known = trained.map((t) => t.toLowerCase());
  const covered: string[] = [];
  const notCovered: { name: string; like: string | null }[] = [];
  const byKey = new Map<string, string[]>();
  for (const name of names) {
    const key = studAiSubjectKey(name);
    byKey.set(key, [...(byKey.get(key) ?? []), name]);
    if (known.includes(key)) covered.push(name);
    else notCovered.push({ name, like: lookalike(name, known) });
  }
  const sameSubject = [...byKey].filter(([, list]) => list.length > 1).map(([key, list]) => ({ key, names: list }));
  return { covered, notCovered, sameSubject };
}
