import { addDays, isValidIsoDate, todayIST } from "@/lib/dates";

/** The date range of the collections report (default: today), shared by the page and the CSV download. */
export function collectionRange(sp: { from?: string | null; to?: string | null; opening?: string | null }) {
  const today = todayIST();
  let from = sp.from && isValidIsoDate(sp.from) ? sp.from : today;
  let to = sp.to && isValidIsoDate(sp.to) ? sp.to : today;
  let note: string | null = null;
  if (from > to) [from, to] = [to, from];
  if (to > today) to = today;
  if (from > today) from = today;
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) {
    from = addDays(to, -365);
    note = "A report covers at most one year, so the start date was moved.";
  }
  return { from, to, includeOpening: sp.opening === "1", note };
}
