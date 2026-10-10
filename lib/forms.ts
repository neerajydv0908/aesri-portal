/**
 * The result a form's Server Action returns: a success message, or an error
 * (optionally per field). Used with <ActionForm> from components/forms.tsx.
 */
export type FormState =
  | {
      ok?: string;
      error?: string;
      /** Field name → message, shown next to that field. */
      fields?: Record<string, string>;
      /** Increments on every successful submit so forms can reset. */
      nonce?: number;
      /** Anything extra a page wants to show after success (e.g. printed slip data). */
      data?: unknown;
    }
  | undefined;

export const fail = (error: string, fields?: Record<string, string>): FormState => ({ error, fields });
export const done = (ok: string, data?: unknown): FormState => ({ ok, nonce: Date.now(), data });

/** Turn an expected error (validation, "not found" in the domain) into a message; rethrow the rest. */
export function messageOf(err: unknown, known: (new (...args: never[]) => Error)[]): string {
  if (known.some((K) => err instanceof K)) return (err as Error).message;
  throw err;
}
