"use client";

/**
 * Pieces shared by the sign-in, activation and two-step forms (inside an
 * <ActionForm>): the error summary at the top, and each field's error from
 * the last submit.
 */
import { useEffect, useRef } from "react";
import { useFormResult } from "@/components/forms";
import { Alert } from "@/components/ui";
import type { AuthKeep } from "./actions";

/** The summary's id: fields whose problem is only described there point to it. */
export const SUMMARY_ID = "form-problem";

/** The last result: field errors, and what to put back in the boxes (used without JavaScript). */
export function useAuthResult(): { fields: Record<string, string>; keep: AuthKeep; nonce: unknown } {
  const state = useFormResult();
  return { fields: state?.fields ?? {}, keep: (state?.data as AuthKeep | undefined) ?? {}, nonce: state };
}

/**
 * What went wrong, at the top of the form: the message, then each box's
 * problem as a link to that box. Focused when it appears (or, with
 * `focusField`, that box is cleared and focused instead).
 */
export function ErrorSummary({ order, focusField }: { order?: string[]; focusField?: string }) {
  const state = useFormResult();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state?.error) return;
    const field = focusField && state.fields?.[focusField] ? (document.getElementById(focusField) as HTMLInputElement | null) : null;
    if (field) {
      field.value = "";
      field.focus();
    } else ref.current?.focus();
  }, [state, focusField]);
  if (!state?.error) return null;
  const fields = state.fields ?? {};
  const names = [...(order ?? []), ...Object.keys(fields).filter((k) => !order?.includes(k))].filter((k) => fields[k]);
  return (
    <div ref={ref} id={SUMMARY_ID} tabIndex={-1} className="outline-none">
      <Alert tone="red" title={state.error}>
        {names.length ? (
          <ul className="mt-1 grid gap-1">
            {names.map((k) => (
              <li key={k}>
                <a href={`#${k}`} className="font-semibold underline underline-offset-2">
                  {fields[k]}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </Alert>
    </div>
  );
}
