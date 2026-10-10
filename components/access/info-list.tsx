/** A one-column list of labelled facts (label above value), for narrow cards. */
import clsx from "clsx";
import type { ReactNode } from "react";

export function InfoList({ items, className }: { items: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={clsx("grid gap-4", className)}>
      {items.map((it, i) => (
        <div key={i}>
          <dt className="eyebrow">{it.label}</dt>
          <dd className="mt-1 text-[1rem] text-forest-900">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
