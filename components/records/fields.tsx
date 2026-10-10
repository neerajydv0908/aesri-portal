"use client";

/**
 * Form fields for the records screens. Each one shows its label, hint and
 * error (tied to the input with aria-describedby and aria-invalid), and puts
 * back what was typed when the server answers with an error — also when the
 * form was posted without JavaScript. Use inside <ActionForm>.
 */
import clsx from "clsx";
import type { ComponentProps, ReactNode } from "react";
import { useFormResult } from "@/components/forms";
import { Field, Input, Select, describedBy } from "@/components/ui";
import type { Submitted } from "./form-state";

/** This field's error and, after a failed submit, what was typed into the form. */
export function useField(name: string) {
  const state = useFormResult();
  const error = state?.fields?.[name] ?? null;
  const values = state?.error ? ((state.data as { values?: Submitted } | undefined)?.values ?? null) : null;
  return { error, values };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const includes = (v: string | string[] | undefined, value: string) => (Array.isArray(v) ? v.includes(value) : v === value);

type Common = {
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  /** Defaults to the field name. */
  id?: string;
  className?: string;
};

export function TextField({
  name,
  label,
  hint,
  required,
  id,
  className,
  defaultValue,
  inputClassName,
  ...rest
}: Common & Omit<ComponentProps<"input">, "name" | "id" | "defaultValue" | "className" | "required"> & { defaultValue?: string | number | null; inputClassName?: string }) {
  const { error, values } = useField(name);
  const fid = id ?? name;
  const value = values ? (first(values[name]) ?? "") : (defaultValue ?? "");
  return (
    <Field label={label} htmlFor={fid} hint={hint} error={error} required={required} className={className}>
      <Input
        id={fid}
        name={name}
        defaultValue={String(value)}
        required={required}
        {...describedBy(fid, error, !!hint)}
        className={inputClassName}
        {...rest}
      />
    </Field>
  );
}

export function SelectField({
  name,
  label,
  hint,
  required,
  id,
  className,
  defaultValue,
  children,
  selectClassName,
  ...rest
}: Common &
  Omit<ComponentProps<"select">, "name" | "id" | "defaultValue" | "className" | "required" | "children"> & {
    defaultValue?: string | null;
    children: ReactNode;
    selectClassName?: string;
  }) {
  const { error, values } = useField(name);
  const fid = id ?? name;
  const value = values ? (first(values[name]) ?? "") : (defaultValue ?? "");
  return (
    <Field label={label} htmlFor={fid} hint={hint} error={error} required={required} className={className}>
      <Select id={fid} name={name} defaultValue={value} required={required} {...describedBy(fid, error, !!hint)} className={selectClassName} {...rest}>
        {children}
      </Select>
    </Field>
  );
}

/** One checkbox with its label (and an optional hint or error under it). */
export function CheckField({
  name,
  value = "yes",
  label,
  hint,
  id,
  className,
  defaultChecked,
  disabled,
}: Omit<Common, "required"> & { value?: string; defaultChecked?: boolean; disabled?: boolean }) {
  const { error, values } = useField(name);
  const fid = id ?? name;
  const checked = values ? includes(values[name], value) : !!defaultChecked;
  const described = [error ? `${fid}-error` : null, hint ? `${fid}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={clsx("grid gap-1.5", className)}>
      <label htmlFor={fid} className={clsx("flex cursor-pointer items-start gap-3 text-[0.95rem] text-forest-900", disabled && "cursor-not-allowed opacity-60")}>
        <input
          type="checkbox"
          id={fid}
          name={name}
          value={value}
          defaultChecked={checked}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          className="mt-0.5 h-6 w-6 shrink-0 cursor-pointer rounded-md accent-forest-700 disabled:cursor-not-allowed"
        />
        <span className="font-semibold">{label}</span>
      </label>
      {hint ? (
        <p id={`${fid}-hint`} className="pl-9 text-[0.85rem] text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${fid}-error`} className="pl-9 text-[0.85rem] font-semibold text-clay-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A group of checkboxes sharing one name (for example the subjects someone teaches). */
export function CheckGroup({
  name,
  legend,
  hint,
  options,
  defaultValues,
  className,
}: {
  name: string;
  legend: ReactNode;
  hint?: ReactNode;
  options: { value: string; label: ReactNode }[];
  defaultValues: string[];
  className?: string;
}) {
  const { error, values } = useField(name);
  const chosen = values ? values[name] : undefined;
  const described = [error ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <fieldset className={clsx("grid gap-2", className)} aria-describedby={described}>
      <legend className="mb-1 text-[0.92rem] font-semibold text-forest-900">{legend}</legend>
      {hint ? (
        <p id={`${name}-hint`} className="-mt-1 text-[0.85rem] text-muted">
          {hint}
        </p>
      ) : null}
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {options.map((o) => (
          <label key={o.value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-1 text-[0.95rem] text-forest-900 hover:bg-forest-900/[0.04]">
            <input
              type="checkbox"
              name={name}
              value={o.value}
              defaultChecked={values ? includes(chosen, o.value) : defaultValues.includes(o.value)}
              className="h-5 w-5 shrink-0 cursor-pointer accent-forest-700"
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {error ? (
        <p id={`${name}-error`} className="text-[0.85rem] font-semibold text-clay-600">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * A choice between a few options, shown as large radio cards with a
 * one-line explanation each. An option can be shown but not offered
 * (`disabled`), with `note` saying why — the server refuses it anyway.
 */
export function RadioCards({
  name,
  legend,
  hint,
  required,
  options,
  defaultValue,
  className,
  columns = "sm:grid-cols-2",
}: {
  name: string;
  legend: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  options: { value: string; label: ReactNode; hint?: ReactNode; disabled?: boolean; note?: ReactNode }[];
  defaultValue?: string | null;
  className?: string;
  columns?: string;
}) {
  const { error, values } = useField(name);
  const value = values ? (first(values[name]) ?? "") : (defaultValue ?? "");
  const described = [error ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <fieldset className={clsx("grid gap-2", className)} aria-describedby={described}>
      <legend className="mb-1.5 text-[0.92rem] font-semibold text-forest-900">
        {legend}
        {required ? <span className="text-clay-600"> *</span> : null}
      </legend>
      <div className={clsx("grid gap-2", columns)}>
        {options.map((o) => (
          <label
            key={o.value}
            className={clsx(
              "flex min-h-14 items-center gap-3 rounded-2xl px-3.5 py-2.5 transition-colors",
              o.disabled
                ? "cursor-not-allowed border border-dashed border-forest-900/30 bg-cream-100"
                : "cursor-pointer bg-cream-50 ring-1 ring-forest-900/15 hover:ring-forest-900/35 has-checked:bg-sage-50 has-checked:ring-2 has-checked:ring-forest-700 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ochre-500",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              defaultChecked={!o.disabled && value === o.value}
              disabled={o.disabled}
              required={required}
              aria-invalid={error ? true : undefined}
              className="h-5 w-5 shrink-0 accent-forest-700 disabled:cursor-not-allowed"
            />
            <span className="min-w-0">
              <span className="block font-semibold text-forest-900">{o.label}</span>
              {o.hint ? <span className="block text-[0.82rem] leading-snug text-muted">{o.hint}</span> : null}
              {o.disabled && o.note ? <span className="mt-0.5 block text-[0.82rem] font-semibold leading-snug text-forest-900">{o.note}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {hint ? (
        <p id={`${name}-hint`} className="text-[0.85rem] text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${name}-error`} className="text-[0.85rem] font-semibold text-clay-600">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
