"use client";

/**
 * A labelled text box inside an <ActionForm>: its hint, and the error from
 * the last submit, are tied to it (aria-describedby, aria-invalid).
 */
import clsx from "clsx";
import type { ComponentProps, ReactNode } from "react";
import { FieldError, useFormResult } from "@/components/forms";
import { inputClasses } from "@/components/ui";

export function TextField({
  name,
  label,
  hint,
  required,
  className,
  inputClassName,
  ...props
}: Omit<ComponentProps<"input">, "name" | "id"> & { name: string; label: ReactNode; hint?: ReactNode; required?: boolean; inputClassName?: string }) {
  const error = useFormResult()?.fields?.[name];
  const id = `f-${name}`;
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[0.92rem] font-semibold text-forest-900">
        {label}
        {required ? <span className="text-clay-600"> *</span> : null}
      </label>
      <input
        id={id}
        name={name}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...props}
        className={clsx(inputClasses, inputClassName)}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-[0.85rem] text-muted">
          {hint}
        </p>
      ) : null}
      <FieldError name={name} id={`${id}-error`} />
    </div>
  );
}
