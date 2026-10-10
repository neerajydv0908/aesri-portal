/**
 * The portal's UI kit: calm, legible building blocks in the AESRI palette.
 * Server-safe (no hooks); interactive pieces live in ./client.tsx.
 */
import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "light";
export type ButtonSize = "sm" | "md" | "lg";

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
  return clsx(
    "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-60",
    size === "sm" && "min-h-9 px-3.5 text-[0.85rem]",
    size === "md" && "min-h-11 px-5 text-[0.95rem]",
    size === "lg" && "min-h-12 px-6 text-base",
    variant === "primary" && "bg-forest-800 text-cream-50 hover:bg-forest-700",
    variant === "secondary" && "bg-cream-50 text-forest-900 ring-1 ring-forest-900/15 hover:ring-forest-900/35",
    variant === "ghost" && "text-forest-800 hover:bg-forest-900/[0.06]",
    variant === "danger" && "bg-clay-600 text-cream-50 hover:bg-clay-500",
    variant === "light" && "bg-cream-50 text-forest-900 hover:bg-cream-200",
    className,
  );
}

export function ButtonLink({
  variant,
  size,
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link {...props} className={buttonClasses(variant, size, className)} />;
}

export function Button({ variant, size, className, type = "button", ...props }: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} {...props} className={buttonClasses(variant, size, className)} />;
}

/* ------------------------------------------------------------------ */
/* Layout pieces                                                       */
/* ------------------------------------------------------------------ */

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={clsx("rise-in flex flex-col gap-5 pb-8 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className="mt-2 text-[clamp(1.9rem,3.2vw,2.6rem)] text-forest-900">{title}</h1>
        {description ? <div className="mt-2 max-w-2xl text-[1rem] text-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div> : null}
    </header>
  );
}

export function Card({ children, className, as: As = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" }) {
  return <As className={clsx("card p-6 sm:p-7", className)}>{children}</As>;
}

export function CardTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx("mb-4 flex items-center justify-between gap-3", className)}>
      <h2 className="font-display text-[1.35rem] leading-tight text-forest-900">{children}</h2>
      {action}
    </div>
  );
}

export function Stat({ label, value, hint, tone = "default", href }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone; href?: string }) {
  const body = (
    <>
      <p className="eyebrow">{label}</p>
      <p className={clsx("mt-3 font-display text-[2.1rem] leading-none tabular", toneText[tone])}>{value}</p>
      {hint ? <p className="mt-2 text-[0.88rem] text-muted">{hint}</p> : null}
    </>
  );
  const cls = "card block p-5 sm:p-6";
  return href ? (
    <Link href={href} className={clsx(cls, "transition-shadow hover:shadow-[0_0_0_1px_rgba(19,39,28,0.18),0_24px_40px_-30px_rgba(19,39,28,0.55)]")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/* ------------------------------------------------------------------ */
/* Badges and alerts                                                   */
/* ------------------------------------------------------------------ */

export type Tone = "default" | "green" | "amber" | "red" | "grey" | "blue";

const toneText: Record<Tone, string> = {
  default: "text-forest-900",
  green: "text-forest-700",
  amber: "text-ochre-600",
  red: "text-clay-600",
  grey: "text-muted",
  blue: "text-forest-800",
};

const toneBadge: Record<Tone, string> = {
  default: "bg-cream-200 text-forest-900",
  green: "bg-sage-100 text-forest-800",
  amber: "bg-ochre-50 text-ochre-600 ring-1 ring-ochre-500/30",
  red: "bg-clay-50 text-clay-600 ring-1 ring-clay-500/25",
  grey: "bg-cream-200 text-muted",
  blue: "bg-sage-50 text-forest-800 ring-1 ring-forest-700/20",
};

export function Badge({ tone = "default", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[0.78rem] font-semibold", toneBadge[tone], className)}>
      {children}
    </span>
  );
}

export function Alert({ tone = "blue", title, children, className }: { tone?: "green" | "amber" | "red" | "blue"; title?: ReactNode; children?: ReactNode; className?: string }) {
  const Icon = tone === "green" ? CheckCircle2 : tone === "amber" ? AlertTriangle : tone === "red" ? XCircle : Info;
  return (
    <div
      role={tone === "red" ? "alert" : "status"}
      className={clsx(
        "flex gap-3 rounded-2xl px-4 py-3.5 text-[0.95rem]",
        tone === "green" && "bg-sage-100 text-forest-900",
        tone === "amber" && "bg-ochre-50 text-forest-900 ring-1 ring-ochre-500/30",
        tone === "red" && "bg-clay-50 text-forest-900 ring-1 ring-clay-500/30",
        tone === "blue" && "bg-sage-50 text-forest-900 ring-1 ring-forest-700/15",
        className,
      )}
    >
      <Icon
        className={clsx("mt-0.5 h-5 w-5 shrink-0", tone === "green" ? "text-forest-700" : tone === "amber" ? "text-ochre-600" : tone === "red" ? "text-clay-600" : "text-forest-700")}
        aria-hidden
      />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={clsx(title && "mt-0.5", "text-forest-900/85")}>{children}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-[1.25rem] border border-dashed border-forest-900/15 px-6 py-12 text-center">
      {icon ? <span className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-sage-100 text-forest-700">{icon}</span> : null}
      <p className="font-display text-[1.3rem] text-forest-900">{title}</p>
      {children ? <div className="mt-2 max-w-md text-muted">{children}</div> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

export function Table({ children, caption, className }: { children: ReactNode; caption?: string; className?: string }) {
  // The scrolling wrapper is focusable so keyboard users can scroll wide tables sideways.
  return (
    <div className={clsx("card overflow-hidden", className)}>
      <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label={caption ?? "Table"}>
        <table className="w-full min-w-[36rem] border-collapse text-left text-[0.95rem]">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          {children}
        </table>
      </div>
    </div>
  );
}

export function Th({ children, className, ...props }: ComponentProps<"th">) {
  return (
    <th scope="col" {...props} className={clsx("border-b border-forest-900/10 bg-cream-200/50 px-4 py-3 text-[0.74rem] font-bold uppercase tracking-[0.1em] text-muted first:pl-6 last:pr-6", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className, ...props }: ComponentProps<"td">) {
  return (
    <td {...props} className={clsx("border-b border-forest-900/[0.06] px-4 py-3 first:pl-6 last:pr-6", className)}>
      {children}
    </td>
  );
}

/* ------------------------------------------------------------------ */
/* Form fields                                                         */
/* ------------------------------------------------------------------ */

export const inputClasses =
  "block w-full min-h-11 rounded-xl border-0 bg-cream-50 px-3.5 py-2 text-[1rem] text-ink ring-1 ring-forest-900/15 placeholder:text-muted/70 focus:outline-none focus:ring-2 focus:ring-forest-700 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-clay-500";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[0.92rem] font-semibold text-forest-900">
        {label}
        {required ? <span className="text-clay-600"> *</span> : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${htmlFor}-hint`} className="text-[0.85rem] text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-[0.85rem] font-semibold text-clay-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** aria props that tie an input to its hint/error text. */
export function describedBy(id: string, error?: string | null, hint?: boolean) {
  const ids = [error ? `${id}-error` : null, hint && !error ? `${id}-hint` : null].filter(Boolean).join(" ");
  return { "aria-invalid": error ? true : undefined, "aria-describedby": ids || undefined } as const;
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...props} className={clsx(inputClasses, className)} />;
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select {...props} className={clsx(inputClasses, "select-arrow appearance-none pr-10", className)}>
      {children}
    </select>
  );
}


export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={clsx(inputClasses, "min-h-28 py-3", className)} />;
}

export function Checkbox({ label, className, ...props }: ComponentProps<"input"> & { label: ReactNode }) {
  return (
    <label className={clsx("flex cursor-pointer items-start gap-3 text-[0.95rem] text-forest-900", className)}>
      <input type="checkbox" {...props} className="mt-0.5 h-6 w-6 shrink-0 cursor-pointer rounded-md accent-forest-700" />
      <span>{label}</span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function Money({ paise, className }: { paise: number; className?: string }) {
  const r = paise / 100;
  const text = `₹${r.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
  return <span className={clsx("tabular", className)}>{text}</span>;
}

export function Dl({ items, className }: { items: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={clsx("grid gap-x-8 gap-y-4 sm:grid-cols-2", className)}>
      {items.map((it, i) => (
        <div key={i}>
          <dt className="eyebrow">{it.label}</dt>
          <dd className="mt-1 text-[1rem] text-forest-900">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TabLinks({ tabs, current }: { tabs: { href: string; label: ReactNode; key: string }[]; current: string }) {
  return (
    <nav aria-label="Sections" className="mb-6 flex gap-1 overflow-x-auto rounded-full bg-cream-200/70 p-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={clsx(
            "whitespace-nowrap rounded-full px-4 py-2 text-[0.9rem] font-semibold transition-colors",
            t.key === current ? "bg-cream-50 text-forest-900 shadow-sm" : "text-muted hover:text-forest-900",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
