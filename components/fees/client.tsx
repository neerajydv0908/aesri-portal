"use client";

/**
 * Small interactive helpers for the fee screens. Everything they do is a
 * convenience: the forms work without them, and the server recomputes and
 * checks every amount.
 */
import clsx from "clsx";
import Link from "next/link";
import { Printer } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type ComponentProps, type ReactNode } from "react";
import { useFormResult } from "@/components/forms";
import { buttonClasses, inputClasses } from "@/components/ui";
import type { SubmittedValues } from "./remember";

/** What was submitted, when the last submit of the surrounding <ActionForm> failed. */
function useSubmitted(): SubmittedValues | null {
  const state = useFormResult();
  if (!state?.error) return null;
  return (state.data as { values?: SubmittedValues } | undefined)?.values ?? null;
}

/** A text input that keeps its value when the form comes back with an error. */
export function RememberedInput({ name, defaultValue, className, ...props }: Omit<ComponentProps<"input">, "name" | "defaultValue"> & { name: string; defaultValue?: string }) {
  const sub = useSubmitted();
  const v = sub ? sub[name] : undefined;
  const value = sub ? (Array.isArray(v) ? v[0] : (v ?? "")) : defaultValue;
  const error = useFormResult()?.fields?.[name];
  return <input name={name} defaultValue={value} aria-invalid={error ? true : undefined} {...props} className={clsx(inputClasses, className)} />;
}

/** A checkbox or radio button that keeps its state when the form comes back with an error. */
export function RememberedChoice({
  name,
  value,
  defaultChecked,
  type = "checkbox",
  ...props
}: Omit<ComponentProps<"input">, "name" | "value" | "type"> & { name: string; value: string; type?: "checkbox" | "radio" }) {
  const sub = useSubmitted();
  const all = sub ? sub[name] : undefined;
  const checked = sub ? (Array.isArray(all) ? all.includes(value) : all === value) : defaultChecked;
  return <input type={type} name={name} value={value} defaultChecked={checked} {...props} />;
}

/**
 * A <details> that starts afresh — folded up, its fields back to their
 * defaults and any "Are you sure?" step reset — each time the surrounding
 * <ActionForm> saves (the form's message stays, above it). After an error it
 * stays as it is, open, with the highlighted fields in view.
 */
export function ClosingDetails({ children, className }: { children: ReactNode; className?: string }) {
  const state = useFormResult();
  const [round, setRound] = useState(0);
  const seen = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (state?.ok && state.nonce !== seen.current) {
      seen.current = state.nonce;
      setRound((r) => r + 1);
    }
  }, [state]);
  return (
    <details key={round} className={className}>
      {children}
    </details>
  );
}

/**
 * The confirmation question for a refund, with the amount typed in the
 * surrounding form: "Record a refund of ₹2,000 on receipt ARY/26-27/00012?"
 * It follows the amount box while the question shows, so a change made after
 * asking is what the question names (the server checks the amount itself).
 */
export function RefundQuestion({ receiptNo }: { receiptNo: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [amount, setAmount] = useState<string | null>(null);
  useEffect(() => {
    const input = ref.current?.closest("form")?.elements.namedItem("amount");
    if (!(input instanceof HTMLInputElement)) return;
    const update = () => {
      const raw = input.value.replace(/[₹,\s]/g, "");
      const n = Number(raw);
      setAmount(/^\d+(\.\d{1,2})?$/.test(raw) && n > 0 ? `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : null);
    };
    update();
    input.addEventListener("input", update);
    return () => input.removeEventListener("input", update);
  }, []);
  return <span ref={ref}>{amount ? `Record a refund of ${amount} on receipt ${receiptNo}?` : `Record this refund on receipt ${receiptNo}?`}</span>;
}

/** A header checkbox that ticks or unticks a whole column of checkboxes (data-col) in its form. */
export function ColumnToggle({ column, label }: { column: string; label: string }) {
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const on = e.currentTarget.checked;
    e.currentTarget.form?.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][data-col="${CSS.escape(column)}"]:not(:disabled)`).forEach((cb) => {
      cb.checked = on;
    });
  };
  return (
    <label className="mt-1.5 inline-flex min-h-8 cursor-pointer items-center gap-2 text-[0.78rem] font-semibold normal-case tracking-normal text-forest-800">
      <input type="checkbox" onChange={onChange} className="h-5 w-5 cursor-pointer accent-forest-700" />
      {label}
    </label>
  );
}

/** After a payment is recorded: a link to print its receipt (from the action's result). */
export function ReceiptLinkFromResult({ base }: { base: string }) {
  const state = useFormResult();
  const data = state?.data as { paymentId?: string; receiptNo?: string } | undefined;
  if (!data?.paymentId) return null;
  return (
    <Link href={`${base}/${data.paymentId}`} className={buttonClasses("secondary", "md", "w-full sm:w-auto")}>
      <Printer className="h-4 w-4" aria-hidden />
      Print receipt {data.receiptNo}
    </Link>
  );
}

/** "10,000" or "10000.50" → paise (0 when empty or not an amount). Display only: the server parses again. */
function paiseOf(text: string): number {
  const s = text.replace(/[₹,\s]/g, "");
  return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : 0;
}

/**
 * The total of the family's "Pay fees" form: the admission fee when its box
 * (data-amount) is ticked, plus the tuition typed into the input named
 * `tuitionName`. Display only — the server works out the amount itself.
 */
export function PayTotal({ initial, tuitionName, label, emptyLabel }: { initial: number; tuitionName: string; label: string; emptyLabel: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [total, setTotal] = useState(initial);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const update = () => {
      let sum = 0;
      form.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-amount]').forEach((cb) => {
        if (cb.checked) sum += Number(cb.dataset.amount) || 0;
      });
      const tuition = form.querySelector<HTMLInputElement>(`input[name="${CSS.escape(tuitionName)}"]`);
      if (tuition) sum += paiseOf(tuition.value);
      setTotal(sum);
    };
    form.addEventListener("change", update);
    form.addEventListener("input", update);
    update();
    return () => {
      form.removeEventListener("change", update);
      form.removeEventListener("input", update);
    };
  }, [tuitionName]);
  const r = total / 100;
  return (
    <p ref={ref} aria-live="polite" className="font-display text-[1.6rem] leading-none text-forest-900 tabular">
      {total > 0 ? (
        <>
          <span className="sr-only">{label} </span>₹{r.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}
        </>
      ) : (
        <span className="text-[1rem] font-semibold text-muted">{emptyLabel}</span>
      )}
    </p>
  );
}

/**
 * Buttons that fill in a ready amount ("Due now ₹9,000") in the input named
 * `target` of the same form — easier than typing on a phone. Without
 * JavaScript they do nothing and the amount is typed.
 */
export function AmountChips({ target, choices, label }: { target: string; choices: { label: string; paise: number }[]; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  if (!choices.length) return null;
  const fill = (paise: number) => {
    const input = ref.current?.closest("form")?.querySelector<HTMLInputElement>(`input[name="${CSS.escape(target)}"]`);
    if (!input) return;
    input.value = String(paise / 100);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };
  return (
    <div ref={ref} role="group" aria-label={label} className="flex flex-wrap gap-2">
      {choices.map((c) => (
        <button
          key={`${c.label}-${c.paise}`}
          type="button"
          onClick={() => fill(c.paise)}
          className="inline-flex min-h-11 items-center rounded-full bg-cream-50 px-4 text-[0.92rem] font-semibold text-forest-800 ring-1 ring-forest-900/15 hover:bg-sage-50 hover:ring-forest-700/40"
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** Seconds until an order times out, shown as mm:ss. */
export function Countdown({ until, expiredLabel }: { until: string; expiredLabel: string }) {
  const end = Date.parse(until);
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [end]);
  if (left === null) return null;
  if (left === 0) return <span className="font-semibold text-clay-600">{expiredLabel}</span>;
  return (
    <span className="tabular">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </span>
  );
}
