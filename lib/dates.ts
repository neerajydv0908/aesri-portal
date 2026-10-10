/** Dates are handled as YYYY-MM-DD strings in Indian Standard Time. */

export function todayIST(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const monthsEn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthsLongEn = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthsHi = ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"];
const daysEn = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const daysHi = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];

export type Lang = "en" | "hi";

export function formatDate(iso: string | null | undefined, lang: Lang = "en", opts: { long?: boolean; weekday?: boolean } = {}): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const month = lang === "hi" ? monthsHi[m - 1] : opts.long ? monthsLongEn[m - 1] : monthsEn[m - 1];
  const base = `${d} ${month} ${y}`;
  if (!opts.weekday) return base;
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${lang === "hi" ? daysHi[wd] : daysEn[wd]}, ${base}`;
}

/** Hindi time of day, as people say it: सुबह (morning) 4 to 12, दोपहर 12 to 4, शाम 4 to 8, रात 8 to 4. */
function dayPeriodHi(hour: number): string {
  if (hour >= 4 && hour < 12) return "सुबह";
  if (hour >= 12 && hour < 16) return "दोपहर";
  if (hour >= 16 && hour < 20) return "शाम";
  return "रात";
}

/** "29 Sep 2026, 4:18 pm" · "29 सितंबर 2026, शाम 4:18" (Indian time). */
export function formatDateTime(date: Date | null | undefined, lang: Lang = "en"): string {
  if (!date) return "—";
  const iso = todayIST(date);
  if (lang === "hi") {
    const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(date)
      .split(":")
      .map(Number);
    return `${formatDate(iso, lang)}, ${dayPeriodHi(h)} ${h % 12 || 12}:${String(m).padStart(2, "0")}`;
  }
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(date);
  return `${formatDate(iso, lang)}, ${time}`;
}

export function monthName(index: number, lang: Lang = "en"): string {
  return lang === "hi" ? monthsHi[index] : monthsLongEn[index];
}

/** Every date from `from` to `to` inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}
