"use client";

/**
 * <ActionForm> runs a Server Action with useActionState and shows its
 * success or error message. Fields inside can show their own error with
 * <FieldError name="…" />, and read the last result with useFormResult().
 *
 * What people type is kept when the server answers with an error: React
 * clears a form after its `action` runs, so once the page is interactive we
 * submit through a transition ourselves (React then skips the reset but
 * still shows the pending state to <SubmitButton>). Without JavaScript the
 * form still posts the ordinary way through `action`.
 */
import clsx from "clsx";
import { createContext, startTransition, useActionState, useContext, useEffect, useRef, type ReactNode } from "react";
import { Alert } from "@/components/ui";
import type { FormState } from "@/lib/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

const Ctx = createContext<FormState>(undefined);

export function useFormResult(): FormState {
  return useContext(Ctx);
}

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  id,
  messagePosition = "top",
  "aria-label": ariaLabel,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  /** Clear the fields after a successful save (for "add another" forms). */
  resetOnSuccess?: boolean;
  id?: string;
  messagePosition?: "top" | "bottom" | "none";
  "aria-label"?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const ref = useRef<HTMLFormElement>(null);
  const msgRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state?.nonce && resetOnSuccess) ref.current?.reset();
    if (state?.error || state?.ok) msgRef.current?.focus();
  }, [state, resetOnSuccess]);
  const message =
    messagePosition !== "none" && (state?.error || state?.ok) ? (
      <div ref={msgRef} tabIndex={-1} className="outline-none">
        {state?.error ? <Alert tone="red">{state.error}</Alert> : <Alert tone="green">{state?.ok}</Alert>}
      </div>
    ) : null;
  return (
    <Ctx.Provider value={state}>
      <form
        ref={ref}
        id={id}
        aria-label={ariaLabel}
        action={formAction}
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return; // one submit at a time (no double payments or duplicate records)
          // Include the clicked button's name/value, as a normal submit would.
          const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter ?? null);
          startTransition(() => formAction(data));
        }}
        className={clsx("grid gap-5", className)}
        noValidate
      >
        {messagePosition === "top" ? message : null}
        {children}
        {messagePosition === "bottom" ? message : null}
      </form>
    </Ctx.Provider>
  );
}

/** The error for one field, from the last submit (if any). */
export function FieldError({ name, id }: { name: string; id?: string }) {
  const state = useFormResult();
  const msg = state?.fields?.[name];
  return msg ? (
    <p id={id ?? `${name}-error`} className="text-[0.85rem] font-semibold text-clay-600">
      {msg}
    </p>
  ) : null;
}
