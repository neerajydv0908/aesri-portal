/** Forgiving parsers for values typed by office staff (forms and Excel). */
import { isValidIsoDate } from "@/lib/dates";

/** Indian mobile: 10 digits starting 6–9. Accepts +91, 0 prefix, spaces and dashes. */
export function parseMobile(input: unknown): string | null | "invalid" {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/[\s\-()]/g, "").replace(/\.0+$/, "");
  if (!s) return null;
  const digits = s.replace(/^(\+91|0091|91(?=\d{10}$)|0(?=\d{10}$))/, "");
  return /^[6-9]\d{9}$/.test(digits) ? digits : "invalid";
}

/** Dates as 2014-06-21, 21/06/2014, 21-06-2014, 21.06.2014 or an Excel date. */
export function parseDate(input: unknown): string | null | "invalid" {
  if (input === null || input === undefined || input === "") return null;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return "invalid";
    // Excel dates arrive as UTC midnight
    return input.toISOString().slice(0, 10);
  }
  const s = String(input).trim();
  if (!s) return null;
  if (isValidIsoDate(s)) return s;
  const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(s);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return isValidIsoDate(iso) ? iso : "invalid";
  }
  return "invalid";
}

export function parseGender(input: unknown): "M" | "F" | "O" | null | "invalid" {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (["m", "male", "boy", "b", "पुरुष", "लड़का", "बालक"].includes(s)) return "M";
  if (["f", "female", "girl", "g", "महिला", "लड़की", "बालिका"].includes(s)) return "F";
  if (["o", "other", "अन्य"].includes(s)) return "O";
  return "invalid";
}

export function parseYesNo(input: unknown): boolean | "invalid" {
  if (input === null || input === undefined) return false;
  const s = String(input).trim().toLowerCase();
  if (!s || ["no", "n", "false", "0", "नहीं"].includes(s)) return false;
  if (["yes", "y", "true", "1", "हाँ", "हां"].includes(s)) return true;
  return "invalid";
}

export function cleanText(input: unknown, max = 200): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

export function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}
