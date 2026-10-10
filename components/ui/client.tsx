"use client";

import clsx from "clsx";
import { Eye, EyeOff, Loader2, Printer } from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonClasses, inputClasses, type ButtonSize, type ButtonVariant } from "./index";

/** Submit button that shows progress and blocks double submission. */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { pendingLabel?: ReactNode; variant?: ButtonVariant; size?: ButtonSize }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" {...props} disabled={pending || props.disabled} aria-disabled={pending || props.disabled} className={buttonClasses(variant, size, className)}>
      {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}

/** Password field with a show/hide button. Pasting is always allowed (accessible authentication). */
export function PasswordInput({ id, showLabel = "Show password", hideLabel = "Hide password", className, ...props }: ComponentProps<"input"> & { showLabel?: string; hideLabel?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input id={id} type={visible ? "text" : "password"} {...props} className={clsx(inputClasses, "pr-12", className)} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-forest-900/[0.06] hover:text-forest-900"
      >
        {visible ? <EyeOff className="h-4.5 w-4.5" aria-hidden /> : <Eye className="h-4.5 w-4.5" aria-hidden />}
      </button>
    </div>
  );
}

export function PrintButton({ label = "Print", className, variant = "secondary" }: { label?: string; className?: string; variant?: ButtonVariant }) {
  return (
    <button type="button" onClick={() => window.print()} className={buttonClasses(variant, "md", clsx("no-print", className))}>
      <Printer className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}

/**
 * A two-step button for actions that are hard to undo: the first click asks
 * for confirmation inline (no browser dialogs). Focus moves to the confirm
 * button (which is described by the question) and back again on Cancel.
 */
export function ConfirmSubmit({
  children,
  confirmLabel,
  question,
  variant = "danger",
  size = "sm",
  cancelLabel = "Cancel",
}: {
  children: ReactNode;
  confirmLabel: ReactNode;
  question: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  cancelLabel?: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const questionId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (asking) confirmRef.current?.focus();
    else if (cancelled.current) {
      cancelled.current = false;
      startRef.current?.focus();
    }
  }, [asking]);
  if (!asking) {
    return (
      <button ref={startRef} type="button" onClick={() => setAsking(true)} className={buttonClasses(variant === "danger" ? "secondary" : variant, size)}>
        {children}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span id={questionId} className="text-[0.9rem] font-semibold text-forest-900">
        {question}
      </span>
      <SubmitButton ref={confirmRef} variant={variant} size={size} aria-describedby={questionId}>
        {confirmLabel}
      </SubmitButton>
      <button
        type="button"
        onClick={() => {
          cancelled.current = true;
          setAsking(false);
        }}
        className={buttonClasses("ghost", size)}
      >
        {cancelLabel}
      </button>
    </span>
  );
}
