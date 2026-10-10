/**
 * Form results for the records screens. On an error the action sends back
 * what was typed, so the fields in ./fields.tsx can put it back even when
 * the form was posted without JavaScript (React clears a posted form).
 */
import type { FormState } from "@/lib/forms";

export type Submitted = Record<string, string | string[]>;

export function submittedValues(formData: FormData): Submitted {
  const out: Submitted = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string" || key.startsWith("$ACTION")) continue;
    const prev = out[key];
    out[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  return out;
}

/** Like fail(), but keeps what the person typed. */
export function failWith(formData: FormData, error: string, fields?: Record<string, string>): FormState {
  return { error, fields, data: { values: submittedValues(formData) } };
}

/** Problems with several boxes: one problem is repeated at the top, several get a general line. */
export function failFields(formData: FormData, errors: Record<string, string>): FormState {
  const messages = Object.values(errors);
  return failWith(formData, messages.length === 1 ? messages[0] : "Please check the highlighted boxes.", errors);
}

/** "1 unpaid fee line", "2 unpaid fee lines". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "V-A", "V-A and VI-A", "V-A, VI-A and VII-A". */
export function listText(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Was this unique-constraint error raised by the database (two people saving the same number at once)? */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}
