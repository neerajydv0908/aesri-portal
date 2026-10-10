"use client";

import { FieldError, useFormResult } from "@/components/forms";
import { PasswordInput } from "@/components/ui/client";

/** A labelled password box whose error (from the last submit) is announced with it. */
export function PasswordField({
  name,
  label,
  hint,
  autoComplete,
  showLabel,
  hideLabel,
}: {
  name: string;
  label: string;
  hint?: string;
  autoComplete: "current-password" | "new-password";
  showLabel: string;
  hideLabel: string;
}) {
  const error = useFormResult()?.fields?.[name];
  const describedBy = [error ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-[0.92rem] font-semibold text-forest-900">
        {label}
        <span className="text-clay-600"> *</span>
      </label>
      <PasswordInput
        id={name}
        name={name}
        autoComplete={autoComplete}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        showLabel={showLabel}
        hideLabel={hideLabel}
      />
      {hint ? (
        <p id={`${name}-hint`} className="text-[0.85rem] text-muted">
          {hint}
        </p>
      ) : null}
      <FieldError name={name} />
    </div>
  );
}
