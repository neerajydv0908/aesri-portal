/**
 * A row of large radio "buttons" for one student (attendance, homework
 * checks). Real radio inputs, so it works without JavaScript and with the
 * keyboard (arrow keys move between choices). The chosen one is filled and
 * gets a tick, so the choice never depends on colour alone.
 */
import clsx from "clsx";
import type { ReactNode } from "react";
import { Check } from "lucide-react";

export type ChoiceTone = "green" | "red" | "amber" | "slate" | "plain";

export type Choice = {
  value: string;
  label: string;
  tone: ChoiceTone;
  /** Show only this icon on phones (the label stays readable by screen readers, and shows from `sm` up). */
  compactIcon?: ReactNode;
};

const chosen: Record<ChoiceTone, string> = {
  green: "has-checked:bg-forest-700 has-checked:text-cream-50 has-checked:ring-forest-700",
  red: "has-checked:bg-clay-600 has-checked:text-cream-50 has-checked:ring-clay-600",
  amber: "has-checked:bg-ochre-600 has-checked:text-cream-50 has-checked:ring-ochre-600",
  slate: "has-checked:bg-muted has-checked:text-cream-50 has-checked:ring-muted",
  // The neutral choice ("not checked yet"): a dashed outline instead of a fill and tick.
  plain: "border-2 border-transparent has-checked:border-dashed has-checked:border-muted has-checked:bg-cream-200 has-checked:ring-0",
};

export function StatusRadios({
  name,
  labelledBy,
  choices,
  value,
  markAllGroup,
  className,
}: {
  name: string;
  /** id of the element that names the group (the student's name). */
  labelledBy: string;
  choices: Choice[];
  value: string | null;
  /** Lets a "mark all" button find these inputs. */
  markAllGroup?: string;
  /** Grid columns, e.g. "grid-cols-4". */
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className={clsx("grid gap-1.5", className)}>
      {choices.map((c) => (
        <label
          key={c.value}
          className={clsx(
            "group relative flex min-h-11 cursor-pointer select-none items-center justify-center gap-1 rounded-xl bg-cream-50 px-1.5 py-1 text-center text-[0.84rem] font-semibold leading-tight text-forest-900 ring-1 ring-forest-900/15 transition-colors hover:ring-forest-900/40",
            "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ochre-500",
            chosen[c.tone],
          )}
        >
          {/* The scroll margin keeps a focused choice clear of the sticky Save bar (WCAG 2.4.11). */}
          <input
            type="radio"
            name={name}
            value={c.value}
            defaultChecked={value === c.value}
            className="sr-only scroll-mt-24 scroll-mb-28"
            data-mark-all={markAllGroup}
          />
          {c.tone !== "plain" ? <Check className="hidden h-3.5 w-3.5 shrink-0 group-has-checked:block" strokeWidth={3} aria-hidden /> : null}
          {c.compactIcon ? (
            <>
              <span className="sm:hidden" aria-hidden>
                {c.compactIcon}
              </span>
              <span className="sr-only sm:not-sr-only">{c.label}</span>
            </>
          ) : (
            <span>{c.label}</span>
          )}
        </label>
      ))}
    </div>
  );
}
