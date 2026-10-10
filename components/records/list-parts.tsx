/** Pieces of the records lists: a labelled choice for filter bars, and Previous/Next page links. */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ButtonLink, Input, Select } from "@/components/ui";

/** A labelled <select> for a GET filter bar (see components/pickers). */
export function ChoiceField({ name, label, value, options }: { name: string; label: string; value: string; options: { value: string; label: string }[] }) {
  const id = `pick-${name}`;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[0.85rem] font-semibold text-forest-900">
        {label}
      </label>
      <Select id={id} name={name} defaultValue={value} className="min-w-40">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** The search box of a filter bar: full width on a phone, roomy enough for its hint on a computer. */
export function SearchBox({ value, name = "q", label = "Search", placeholder }: { value: string; name?: string; label?: string; placeholder?: string }) {
  const id = `pick-${name}`;
  return (
    <div className="grid w-full gap-1.5 sm:w-auto">
      <label htmlFor={id} className="text-[0.85rem] font-semibold text-forest-900">
        {label}
      </label>
      <Input id={id} type="search" name={name} defaultValue={value} placeholder={placeholder} autoComplete="off" className="sm:min-w-80" />
    </div>
  );
}

/** "Showing 51–100 of 230" with Previous and Next links that keep the filters. */
export function Pager({ page, pages, total, perPage, href, noun }: { page: number; pages: number; total: number; perPage: number; href: (page: number) => string; noun: string }) {
  if (pages <= 1) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  return (
    <nav aria-label="Pages" className="no-print mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-[0.9rem] text-muted tabular">
        Showing {from}–{to} of {total} {noun} · page {page} of {pages}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <ButtonLink href={href(page - 1)} variant="secondary" rel="prev">
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Previous<span className="sr-only"> page</span>
          </ButtonLink>
        ) : null}
        {page < pages ? (
          <ButtonLink href={href(page + 1)} variant="secondary" rel="next">
            Next<span className="sr-only"> page</span>
            <ChevronRight className="h-4 w-4" aria-hidden />
          </ButtonLink>
        ) : null}
      </div>
    </nav>
  );
}
