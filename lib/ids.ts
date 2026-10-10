/**
 * Login IDs.
 *
 *   Students: school prefix + SR number        → Arya7634, Aadhar1234
 *   Staff:    school prefix + "E" + employee no → AryaE12,  AadharE12
 *
 * IDs are matched case-insensitively and leading zeros are ignored, so
 * "arya07634" and "Arya7634" are the same account. The common misspelling
 * "Aadhaar" is accepted too, because parents may type it by habit.
 */

export const LOGIN_PREFIXES = ["Arya", "Aadhar"] as const;
export type LoginPrefix = (typeof LOGIN_PREFIXES)[number];

const PATTERN = /^(arya|aadhar)(e?)0*(\d+)$/;

/** Numbers in registers are digits only. Returns the number without leading zeros, or null if invalid. */
export function cleanRegisterNumber(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().replace(/\.0+$/, ""); // Excel sometimes gives 7634.0
  if (!/^\d{1,9}$/.test(s)) return null;
  return String(Number(s));
}

export function studentLoginId(prefix: string, srNo: string): string {
  return normalizeLoginId(`${prefix}${srNo}`);
}

export function staffLoginId(prefix: string, empNo: string): string {
  return normalizeLoginId(`${prefix}E${empNo}`);
}

/** Canonical stored form: lower case, no spaces, no leading zeros. */
export function normalizeLoginId(input: string): string {
  const s = input
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]+/g, "")
    .replace(/^aadhaar/, "aadhar");
  const m = PATTERN.exec(s);
  if (!m) return s;
  return `${m[1]}${m[2]}${String(Number(m[3]))}`;
}

/** How an ID is printed and shown: Arya7634, AadharE12. */
export function displayLoginId(normalized: string): string {
  const m = PATTERN.exec(normalized);
  if (!m) return normalized;
  const prefix = m[1] === "arya" ? "Arya" : "Aadhar";
  return `${prefix}${m[2] ? "E" : ""}${m[3]}`;
}

export function isStaffLoginId(normalized: string): boolean {
  const m = PATTERN.exec(normalized);
  return !!m && m[2] === "e";
}
