import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ScrollText } from "lucide-react";
import { DateField, FilterBar, SearchField } from "@/components/pickers";
import { EmptyState, PageHeader, Select, Table, Td, Th, buttonClasses } from "@/components/ui";
import { addDays, formatDate, formatDateTime, isValidIsoDate, todayIST } from "@/lib/dates";
import { officePage } from "@/lib/page";
import { LOG_AREAS, LOG_PAGE_SIZE, isLogArea, logPage, resolvePerson, type LogEntry } from "@/lib/queries/log";
import { getSchool } from "@/lib/queries/school";

export const metadata: Metadata = { title: "Activity log" };

type SP = { from?: string; to?: string; area?: string; person?: string; scope?: string; page?: string };

export default async function ActivityLogPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await officePage();
  const sp = await searchParams;
  const today = todayIST();
  let from = typeof sp.from === "string" && isValidIsoDate(sp.from) ? sp.from : addDays(today, -6);
  let to = typeof sp.to === "string" && isValidIsoDate(sp.to) ? sp.to : today;
  const swapped = from > to;
  if (swapped) [from, to] = [to, from];
  const area = isLogArea(sp.area) ? sp.area : null;
  const personInput = typeof sp.person === "string" ? sp.person.trim().slice(0, 40) : "";
  const isAesri = ctx.actor.role === "super_admin";
  const aesriScope = isAesri && sp.scope === "aesri";
  const schoolId = aesriScope ? null : ctx.schoolId;
  const school = await getSchool(ctx.schoolId);
  const person = personInput ? await resolvePerson(schoolId, personInput) : null;
  const page = Math.min(100_000, Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1));
  const { entries, total } = await logPage({ schoolId, from, to, area, person, page });
  const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));

  const query = (p: number) => {
    const u = new URLSearchParams();
    u.set("from", from);
    u.set("to", to);
    if (area) u.set("area", area);
    if (personInput) u.set("person", personInput);
    if (aesriScope) u.set("scope", "aesri");
    if (p > 1) u.set("page", String(p));
    return `/office/log?${u.toString()}`;
  };
  const range = from === to ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`;
  const scopeName = aesriScope ? "AESRI-level entries" : (school?.name ?? "this school");
  const firstShown = (page - 1) * LOG_PAGE_SIZE + 1;

  return (
    <>
      <PageHeader
        eyebrow="School office"
        title="Activity log"
        description="Who did what in the portal, and when. Every change to records, every slip printed and every sign-in is recorded here and can’t be edited."
      />
      <FilterBar action="/office/log">
        <DateField name="from" label="From" value={from} max={today} />
        <DateField name="to" label="To" value={to} max={today} />
        <div className="grid gap-1.5">
          <label htmlFor="pick-area" className="text-[0.85rem] font-semibold text-forest-900">
            Area
          </label>
          <Select id="pick-area" name="area" defaultValue={area ?? ""} className="min-w-48">
            <option value="">All areas</option>
            {LOG_AREAS.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </Select>
        </div>
        <SearchField name="person" value={personInput} label="Person (login ID)" placeholder="e.g. Arya7634 or AryaE3" />
        {isAesri ? (
          <div className="grid gap-1.5">
            <label htmlFor="pick-scope" className="text-[0.85rem] font-semibold text-forest-900">
              Entries for
            </label>
            <Select id="pick-scope" name="scope" defaultValue={aesriScope ? "aesri" : ""} className="min-w-56">
              <option value="">{school?.name ?? "This school"}</option>
              <option value="aesri">AESRI-level entries</option>
            </Select>
          </div>
        ) : null}
      </FilterBar>

      <p className="mb-3 text-[0.92rem] text-muted" role="status">
        {total ? `${total} ${total === 1 ? "entry" : "entries"}` : "No entries"} for {scopeName}, {range}
        {area ? ` · ${LOG_AREAS.find((a) => a.key === area)?.label}` : ""}
        {personInput ? ` · ${personInput}` : ""}.
        {total > LOG_PAGE_SIZE ? ` Showing ${firstShown}–${Math.min(total, page * LOG_PAGE_SIZE)}, newest first.` : total ? " Newest first." : ""}
        {swapped ? " (The dates were the wrong way round, so they have been swapped.)" : ""}
        {personInput && person && !person.accountId
          ? ` No account with the login ID ${personInput} was found ${aesriScope ? "among AESRI administrators" : "in this school"}, so only entries recorded under that ID are shown.`
          : ""}
      </p>

      {entries.length ? (
        <>
          <Table caption={`Activity log for ${scopeName}, ${range}`}>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>What</Th>
                <Th>Record</Th>
                <Th className="relative">
                  <span className="sr-only">Details</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <EntryRow key={e.id} e={e} />
              ))}
            </tbody>
          </Table>
          {pages > 1 ? (
            <nav aria-label="Pages of the activity log" className="mt-5 flex flex-wrap items-center justify-between gap-3">
              {page > 1 ? (
                <Link href={query(page - 1)} className={buttonClasses("secondary", "md")}>
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                  Newer entries
                </Link>
              ) : (
                <span />
              )}
              <p className="text-[0.92rem] text-muted">
                Page {Math.min(page, pages)} of {pages}
              </p>
              {page < pages ? (
                <Link href={query(page + 1)} className={buttonClasses("secondary", "md")}>
                  Older entries
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </>
      ) : (
        <EmptyState icon={<ScrollText className="h-5 w-5" aria-hidden />} title={page > 1 ? "No more entries" : "Nothing recorded for these choices"}>
          {page > 1 ? (
            <Link href={query(1)} className="font-semibold underline underline-offset-2">
              Go back to the newest entries
            </Link>
          ) : (
            <>
              Try a longer date range, another area or person, or{" "}
              <Link href="/office/log" className="font-semibold underline underline-offset-2">
                show the last 7 days
              </Link>
              .
            </>
          )}
        </EmptyState>
      )}
    </>
  );
}

function EntryRow({ e }: { e: LogEntry }) {
  return (
    <tr className="align-top">
      <Td className="min-w-36 whitespace-nowrap text-[0.9rem] tabular">
        <time dateTime={e.at.toISOString()}>{formatDateTime(e.at)}</time>
      </Td>
      <Td className="min-w-40">
        {e.who.name ? <span className="block font-semibold text-forest-900">{e.who.name}</span> : null}
        <span className={e.who.name ? "block text-[0.85rem] text-muted tabular" : "block text-forest-900"}>{e.who.loginId ?? "System"}</span>
      </Td>
      <Td className="min-w-72">
        {e.areaLabel ? <span className="block text-[0.72rem] font-bold uppercase tracking-[0.1em] text-muted">{e.areaLabel}</span> : null}
        <span className="text-forest-900">{e.text}</span>
      </Td>
      <Td className="min-w-32 text-[0.9rem]">
        {e.link ? (
          <Link href={e.link.href} className="inline-flex min-h-6 items-center font-semibold text-forest-800 underline underline-offset-2">
            {e.link.label}
          </Link>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
      <Td className="min-w-40 text-[0.88rem]">
        <details className="group">
          <summary className="inline-flex min-h-6 cursor-pointer items-center rounded font-semibold text-forest-800 underline-offset-2 hover:underline">Details</summary>
          <dl className="mt-2 grid max-w-[22rem] gap-1.5 break-words text-forest-900">
            <div>
              <dt className="text-muted">IP address</dt>
              <dd className="tabular">{e.ip ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt className="text-muted">Action</dt>
              <dd className="font-mono text-[0.82rem]">{e.action}</dd>
            </div>
            {e.facts.map(([k, v]) => (
              <div key={k}>
                <dt className="text-muted">{k}</dt>
                <dd className="whitespace-pre-line">{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      </Td>
    </tr>
  );
}
