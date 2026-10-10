/** Class names: "Nursery", "LKG", "UKG", "I" … "XII". */

export const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

/**
 * Read a class the way an office might type it in Excel:
 * "5", "5th", "Class 5", "V", "class v", "LKG", "L.K.G.", "11 Arts" → canonical name.
 */
export function normalizeClassName(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/\./g, "").replace(/\b(class|std|standard|grade|kaksha|कक्षा)\b/g, "").replace(/\b(arts|science|commerce)\b/g, "").trim();
  s = s.replace(/(st|nd|rd|th)$/, "").trim();
  if (["nursery", "nur", "nurs", "नर्सरी"].includes(s)) return "Nursery";
  if (["lkg", "l k g", "एलकेजी"].includes(s)) return "LKG";
  if (["ukg", "u k g", "यूकेजी"].includes(s)) return "UKG";
  if (/^\d{1,2}$/.test(s)) {
    const n = Number(s);
    return n >= 1 && n <= 12 ? ROMAN[n - 1] : null;
  }
  const upper = s.toUpperCase();
  return ROMAN.includes(upper) ? upper : null;
}

/** "Class V", "LKG", "Class XI (Arts)"; with a section: "Class V-B", "LKG-A", "Class XI-A (Arts)". */
export function classLabel(name: string, stream?: string | null, section?: string | null): string {
  const base = ["Nursery", "LKG", "UKG"].includes(name) ? name : `Class ${name}`;
  const withSection = section ? `${base}-${section}` : base;
  return stream ? `${withSection} (${stream})` : withSection;
}

/**
 * The class in Hindi: "कक्षा 4", "एलकेजी", "कक्षा 11 (कला)". With a section,
 * the same form as the English "Class IV – A" everywhere families read it:
 * "कक्षा 4 – A", "कक्षा 11 (कला) – A".
 */
/** Hindi labels in the same shape: "कक्षा 5", "एलकेजी", "कक्षा 11 (कला)"; with a section "कक्षा 5-B", "कक्षा 11-A (कला)". */
export function classLabelHi(name: string, stream?: string | null, section?: string | null): string {
  const map: Record<string, string> = { Nursery: "नर्सरी", LKG: "एलकेजी", UKG: "यूकेजी" };
  const idx = ROMAN.indexOf(name);
  const base = map[name] ?? (idx >= 0 ? `कक्षा ${idx + 1}` : name);
  const withSection = section ? `${base}-${section}` : base;
  return stream ? `${withSection} (${stream === "Arts" ? "कला" : stream})` : withSection;
}

/** Short section label: "V-A", "LKG-A". */
export function sectionLabel(className: string, sectionName: string): string {
  return `${className}-${sectionName}`;
}
