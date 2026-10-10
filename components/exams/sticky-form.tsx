"use client";

/**
 * A form for longer entries (papers, marks). It works like <ActionForm> but
 * keeps what people typed when the server says something needs fixing:
 * React clears every <form action={…}> after a submit, which would wipe a
 * whole list of marks because of one mistake.
 *
 * It submits through a transition instead of the form's action attribute,
 * so it needs JavaScript (staff screens only).
 */
import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { createContext, startTransition, useActionState, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Alert, buttonClasses, type ButtonSize, type ButtonVariant } from "@/components/ui";
import type { FormState } from "@/lib/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

const Ctx = createContext<{ state: FormState; pending: boolean; ready: boolean }>({ state: undefined, pending: false, ready: false });

export function useStickyForm() {
  return useContext(Ctx);
}

export function StickyForm({
  action,
  children,
  className,
  id,
  "aria-label": ariaLabel,
  onSubmitted,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  id?: string;
  "aria-label"?: string;
  /** Called just before each submit (e.g. to clear "edited since" flags). */
  onSubmitted?: () => void;
}) {
  const [state, dispatch, pending] = useActionState(action, undefined);
  // Until React is running, a click would submit the page the old way (and lose what was typed).
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const msgRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state?.error || state?.ok) msgRef.current?.focus();
  }, [state]);
  return (
    <Ctx.Provider value={{ state, pending, ready }}>
      <form
        id={id}
        aria-label={ariaLabel}
        noValidate
        className={clsx("grid gap-5", className)}
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          const submitter = (e.nativeEvent as SubmitEvent).submitter;
          const fd = new FormData(e.currentTarget, submitter instanceof HTMLElement ? submitter : null);
          onSubmitted?.();
          startTransition(() => dispatch(fd));
        }}
      >
        {state?.error || state?.ok ? (
          <div ref={msgRef} tabIndex={-1} className="outline-none">
            {state.error ? <Alert tone="red">{state.error}</Alert> : <Alert tone="green">{state.ok}</Alert>}
          </div>
        ) : null}
        {children}
      </form>
    </Ctx.Provider>
  );
}

/** The server's message for one field from the last submit, if any. */
export function StickyFieldError({ name, id }: { name: string; id?: string }) {
  const { state } = useStickyForm();
  const msg = state?.fields?.[name];
  return msg ? (
    <p id={id ?? `${name}-error`} className="text-[0.85rem] font-semibold text-clay-600">
      {msg}
    </p>
  ) : null;
}

export function StickySubmit({
  children,
  pendingLabel,
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { pendingLabel?: ReactNode; variant?: ButtonVariant; size?: ButtonSize }) {
  const { pending, ready } = useStickyForm();
  const off = !ready || pending || !!props.disabled;
  return (
    <button type="submit" {...props} disabled={off} aria-disabled={off} className={buttonClasses(variant, size, className)}>
      {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}
