/**
 * React 19 resets a form's fields after every action — including one that
 * returns an error — so a mistake in one field would wipe everything else
 * (an accountant's amount, cheque number and class-wide ticks). Actions
 * return what was submitted with the error; the Remembered* inputs in
 * ./client put it back.
 */
import type { FormState } from "@/lib/forms";

export type SubmittedValues = Record<string, string | string[]>;

export function submittedValues(formData: FormData): SubmittedValues {
  const out: SubmittedValues = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string" || key.startsWith("$ACTION")) continue;
    const prev = out[key];
    out[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  return out;
}

/** Like fail(), but keeps what the person typed. */
export function failKeeping(formData: FormData, error: string, fields?: Record<string, string>): FormState {
  return { error, fields, data: { values: submittedValues(formData) } };
}
