/**
 * Small GET forms for choosing what a page shows (section, date, month…).
 * They work without JavaScript and keep the choice in the URL, so a page can
 * be bookmarked or shared with a colleague.
 */
import type { ReactNode } from "react";
import { Button, Input, Select } from "@/components/ui";
import type { SectionRow } from "@/lib/queries/school";

type Hidden = Record<string, string | undefined | null>;

function HiddenInputs({ values }: { values?: Hidden }) {
  if (!values) return null;
  return (
    <>
      {Object.entries(values).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
    </>
  );
}

export function FilterBar({ children, action, hidden, submitLabel = "Show" }: { children: ReactNode; action?: string; hidden?: Hidden; submitLabel?: string }) {
  return (
    <form method="get" action={action} className="no-print mb-6 flex flex-wrap items-end gap-3">
      <HiddenInputs values={hidden} />
      {children}
      <Button type="submit" variant="secondary">
        {submitLabel}
      </Button>
    </form>
  );
}

export function SectionField({
  sections,
  value,
  name = "section",
  label = "Class",
  allowAll,
  allLabel = "All classes",
}: {
  sections: SectionRow[];
  value?: string | null;
  name?: string;
  label?: string;
  allowAll?: boolean;
  allLabel?: string;
}) {
  const id = `pick-${name}`;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[0.85rem] font-semibold text-forest-900">
        {label}
      </label>
      <Select id={id} name={name} defaultValue={value ?? ""} className="min-w-44">
        {allowAll ? <option value="">{allLabel}</option> : null}
        {sections.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
            {s.stream ? ` (${s.stream})` : ""}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function DateField({ value, name = "date", label = "Date", max, min }: { value: string; name?: string; label?: string; max?: string; min?: string }) {
  const id = `pick-${name}`;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[0.85rem] font-semibold text-forest-900">
        {label}
      </label>
      <Input id={id} type="date" name={name} defaultValue={value} max={max} min={min} className="min-w-44" />
    </div>
  );
}

export function MonthField({ value, name = "month", label = "Month", min, max }: { value: string; name?: string; label?: string; min?: string; max?: string }) {
  const id = `pick-${name}`;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[0.85rem] font-semibold text-forest-900">
        {label}
      </label>
      <Input id={id} type="month" name={name} defaultValue={value} min={min} max={max} className="min-w-44" />
    </div>
  );
}

export function SearchField({ value, name = "q", label = "Search", placeholder }: { value?: string; name?: string; label?: string; placeholder?: string }) {
  const id = `pick-${name}`;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[0.85rem] font-semibold text-forest-900">
        {label}
      </label>
      <Input id={id} type="search" name={name} defaultValue={value ?? ""} placeholder={placeholder} className="min-w-56" />
    </div>
  );
}
