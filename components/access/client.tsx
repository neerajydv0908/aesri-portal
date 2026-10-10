"use client";

/**
 * Interactive pieces of "Slips & sign-in" and the AESRI administrators page.
 * They are conveniences: the server checks every rule again, and asks for a
 * confirmation itself before it resets anyone's password.
 */
import clsx from "clsx";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode, type Ref } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, Loader2, Printer } from "lucide-react";
import { ActionForm, useFormResult } from "@/components/forms";
import { Alert, buttonClasses, type ButtonSize, type ButtonVariant } from "@/components/ui";
import { PrintButton, SubmitButton } from "@/components/ui/client";
import type { FormState } from "@/lib/forms";
import { SlipSheets } from "./slips";
import { bulkKey, bulkNeedsConfirm, LARGE_PRINT, sheetsFor, type BulkIntent, type SlipActionData, type SlipBatch } from "./slip-types";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const noop = () => () => {};
/** False while the server renders the page (and without JavaScript), true once it runs in the browser. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

function dataOf(state: FormState): SlipActionData {
  return (state?.data as SlipActionData | undefined) ?? {};
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ */
/* A form whose result holds one-time codes                            */
/* ------------------------------------------------------------------ */

type FormAction = (prev: FormState, formData: FormData) => Promise<FormState>;

/**
 * <ActionForm> for actions that print slips. React normally sends a form's
 * previous result back with its next submit (and, without JavaScript, keeps
 * it in a hidden field). That result holds the printed one-time codes, so
 * here the Server Action is always called without it: the codes reach the
 * browser once and never travel back. Printing therefore needs JavaScript.
 */
export function SlipsForm({ action, children, ...props }: Omit<ComponentProps<typeof ActionForm>, "action"> & { action: FormAction }) {
  const withoutPrevious = useCallback<FormAction>((_prev, formData) => action(undefined, formData), [action]);
  return (
    <ActionForm action={withoutPrevious} {...props}>
      <noscript>
        <Alert tone="amber" title="Printing slips needs JavaScript">
          Please turn JavaScript on in your browser, then reload this page.
        </Alert>
      </noscript>
      {children}
    </ActionForm>
  );
}

/* ------------------------------------------------------------------ */
/* Which rows are ticked                                               */
/* ------------------------------------------------------------------ */

type Selection = { selected: number; resets: number };

function boxesOf(formId: string): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="accountId"][form="${CSS.escape(formId)}"]`)];
}

function countSelection(formId: string): Selection {
  let selected = 0;
  let resets = 0;
  for (const b of boxesOf(formId)) {
    if (!b.checked || b.disabled) continue;
    selected++;
    if (b.dataset.reset === "1") resets++;
  }
  return { selected, resets };
}

/** Counts the ticked rows (and how many of them would be reset), kept up to date as ticks change. */
function useSelection(formId: string, refreshKey: unknown): Selection {
  const [sel, setSel] = useState<Selection>({ selected: 0, resets: 0 });
  useEffect(() => {
    const recount = () => setSel(countSelection(formId));
    const later = () => window.setTimeout(recount, 0);
    recount();
    document.addEventListener("change", recount);
    document.addEventListener("access:selection", recount);
    const form = document.getElementById(formId);
    form?.addEventListener("reset", later);
    return () => {
      document.removeEventListener("change", recount);
      document.removeEventListener("access:selection", recount);
      form?.removeEventListener("reset", later);
    };
  }, [formId, refreshKey]);
  return sel;
}

/** The header checkbox: tick or untick every row that can be ticked. */
export function SelectAllBox({ formId, label = "Select everyone shown" }: { formId: string; label?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const hydrated = useHydrated();
  useEffect(() => {
    const sync = () => {
      const boxes = boxesOf(formId).filter((b) => !b.disabled);
      const on = boxes.filter((b) => b.checked).length;
      if (!ref.current) return;
      ref.current.checked = boxes.length > 0 && on === boxes.length;
      ref.current.indeterminate = on > 0 && on < boxes.length;
    };
    sync();
    document.addEventListener("change", sync);
    document.addEventListener("access:selection", sync);
    const form = document.getElementById(formId);
    const later = () => window.setTimeout(sync, 0);
    form?.addEventListener("reset", later);
    return () => {
      document.removeEventListener("change", sync);
      document.removeEventListener("access:selection", sync);
      form?.removeEventListener("reset", later);
    };
  }, [formId, hydrated]);
  if (!hydrated) return <span className="sr-only">Select</span>;
  return (
    <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        className="h-6 w-6 cursor-pointer accent-forest-700"
        onChange={(e) => {
          const on = e.currentTarget.checked;
          for (const b of boxesOf(formId)) if (!b.disabled) b.checked = on;
          document.dispatchEvent(new Event("access:selection"));
        }}
      />
      <span className="sr-only">{label}</span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* The result of printing: messages, confirmation, slips               */
/* ------------------------------------------------------------------ */

/**
 * Shows what the last print returned: an error, the printed slips (with the
 * "shown only now" warning and a Print button), or nothing. Everything
 * except the slips themselves is hidden when printing.
 */
export function SlipResult({ children }: { children?: ReactNode }) {
  const state = useFormResult();
  // A question (reset, or a long print) is asked by the print controls themselves, not shown as an error.
  const { batch, confirm: resetQuestion, bulk } = dataOf(state);
  const confirm = resetQuestion ?? bulk;
  const errorRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLDivElement>(null);
  const slipsRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  // The printed slips stay on screen after a later message (say, pressing Print again by mistake),
  // until the next slips are printed or the office removes them from the screen.
  const [kept, setKept] = useState<{ batch: SlipBatch; note: string | undefined } | null>(null);
  const [removed, setRemoved] = useState<FormState>(undefined);
  const [justRemoved, setJustRemoved] = useState(false);
  const removedRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (justRemoved) removedRef.current?.focus();
  }, [justRemoved]);
  useEffect(() => setJustRemoved(false), [state]);
  const fresh = state?.ok && batch?.slips.length && removed !== state ? { batch, note: state.ok } : null;
  useEffect(() => {
    if (fresh) setKept(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const shown = fresh ?? kept;
  useEffect(() => {
    if (!state) return;
    if (state.ok && batch?.slips.length) slipsRef.current?.focus();
    else if (state.ok) okRef.current?.focus();
    else if (state.error && !confirm) errorRef.current?.focus();
  }, [state, batch, confirm]);

  const count = shown?.batch.slips.length ?? 0;
  return (
    <>
      {state?.error && !confirm ? (
        <div ref={errorRef} tabIndex={-1} className="no-print outline-none">
          <Alert tone="red">{state.error}</Alert>
        </div>
      ) : null}
      {state?.ok && !batch?.slips.length ? (
        <div ref={okRef} tabIndex={-1} className="no-print outline-none">
          <Alert tone="green">{state.ok}</Alert>
        </div>
      ) : null}
      {justRemoved && !shown ? (
        <p ref={removedRef} tabIndex={-1} role="status" className="no-print text-[0.92rem] text-muted outline-none">
          The printed codes have been removed from the screen.
        </p>
      ) : null}
      {shown && count ? (
        <section aria-labelledby={headingId} className="card p-5 sm:p-7 print:rounded-none print:bg-transparent print:p-0">
          <div className="no-print mb-5 grid gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id={headingId} ref={slipsRef} tabIndex={-1} className="font-display text-[1.45rem] text-forest-900 outline-none">
                  {count === 1 ? "1 slip ready to print" : `${count} slips ready to print`}
                </h2>
                {shown.note ? <p className="mt-1 text-forest-900/85">{shown.note}</p> : null}
              </div>
              <PrintButton label={count === 1 ? "Print the slip" : "Print slips"} variant="primary" />
            </div>
            <Alert tone="amber" title="These codes are shown only now">
              Print them before leaving this page. If you lose them, print new slips — the old codes stop working.
            </Alert>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[0.9rem] text-muted">
                <Printer className="mr-1 inline h-4 w-4 align-[-0.2em]" aria-hidden />
                Prints on A4, {count > 8 ? `${sheetsFor(count).toLocaleString("en-IN")} sheets, ` : ""}8 slips to a sheet. Cut along the dashed lines.
              </p>
              <button
                type="button"
                onClick={() => {
                  setKept(null);
                  setRemoved(state);
                  setJustRemoved(true);
                }}
                className={buttonClasses("ghost", "sm")}
              >
                Printed? Remove the codes from the screen
              </button>
            </div>
          </div>
          <SlipSheets batch={shown.batch} />
        </section>
      ) : null}
      {children}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* "Print slips for selected", with a confirmation before any reset     */
/* ------------------------------------------------------------------ */

/**
 * The print controls under "Slips & sign-in". When any ticked person has
 * already activated, the first press asks for confirmation and says how
 * many passwords will be reset. The server asks again if the page was out
 * of date (someone activated in the meantime).
 */
export function PrintSelectedControls({ formId, shortcut }: { formId: string; shortcut?: ReactNode }) {
  const state = useFormResult();
  const hydrated = useHydrated();
  const { selected, resets } = useSelection(formId, state);
  const serverConfirm = state?.error ? dataOf(state).confirm : undefined;
  const [asking, setAsking] = useState(false);
  const [dismissed, setDismissed] = useState<FormState>(undefined);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const printRef = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);

  // A change of ticks cancels a question about the previous ticks.
  const last = useRef({ selected, resets });
  useEffect(() => {
    if (last.current.selected !== selected || last.current.resets !== resets) {
      last.current = { selected, resets };
      setAsking(false);
      if (serverConfirm) setDismissed(state);
    }
  }, [selected, resets, serverConfirm, state]);

  // After a successful print the question is over.
  useEffect(() => {
    if (state?.ok) setAsking(false);
  }, [state]);

  const showServer = !!serverConfirm && dismissed !== state;
  const confirming = asking || showServer;
  useEffect(() => {
    if (confirming) questionRef.current?.focus();
    else if (cancelled.current) {
      cancelled.current = false;
      printRef.current?.focus();
    }
  }, [confirming, state]);

  const k = showServer ? serverConfirm!.resets : resets;
  const n = showServer ? serverConfirm!.total : selected;

  return (
    <div className="no-print grid gap-3">
      {confirming ? (
        <div role="group" aria-labelledby="reset-question" className="grid gap-3 rounded-2xl bg-ochre-50 p-4 ring-1 ring-ochre-500/30">
          <p id="reset-question" ref={questionRef} tabIndex={-1} className="flex gap-2.5 text-forest-900 outline-none">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-ochre-600" aria-hidden />
            <span>
              <strong className="font-semibold">
                {k === n ? (k === 1 ? "This person has" : `All ${n} of them have`) : `${k} of the ${n} people you ticked ${k === 1 ? "has" : "have"}`} already activated.
              </strong>{" "}
              A new slip resets {k === 1 ? "their password" : "their passwords"} (and any authenticator app) and signs them out on every device. They will need the new
              slip to sign in again.
            </span>
          </p>
          <input type="hidden" name="confirmReset" value={k} />
          <div className="flex flex-wrap gap-2">
            <SubmitButton name="intent" value="selected" variant="danger" pendingLabel="Printing…">
              Yes, reset {k === 1 ? "1 password" : `${k} passwords`} and print {n === 1 ? "the slip" : `${n} slips`}
            </SubmitButton>
            <button
              type="button"
              onClick={() => {
                cancelled.current = true;
                setAsking(false);
                setDismissed(state);
              }}
              className={buttonClasses("ghost", "md")}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {resets > 0 ? (
            <button ref={printRef} type="button" onClick={() => setAsking(true)} className={buttonClasses("primary", "md")}>
              <Printer className="h-4 w-4" aria-hidden />
              Print slips for selected{hydrated ? ` (${selected})` : ""}
            </button>
          ) : (
            <SubmitButton ref={printRef} name="intent" value="selected" pendingLabel="Printing…">
              <Printer className="h-4 w-4" aria-hidden />
              Print slips for selected{hydrated ? ` (${selected})` : ""}
            </SubmitButton>
          )}
          {shortcut}
        </div>
      )}
      <p className="text-[0.88rem] text-muted" aria-live="polite">
        {hydrated
          ? selected
            ? `${plural(selected, "person", "people")} ticked${resets ? `, ${resets} of them already activated (their password will be reset)` : ""}.`
            : "Tick the people who need a slip in the table below."
          : "Tick the people who need a slip in the table below."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Printing for many people at once                                    */
/* ------------------------------------------------------------------ */

const num = (x: number) => x.toLocaleString("en-IN");

/**
 * "Print slips for everyone not yet activated (412)" — everyone waiting in
 * the school, or everyone an Excel import added. Says beforehand how many
 * slips and A4 sheets it makes. A long print (more than five sheets), or
 * one that would cancel slips that still work, asks first; the server
 * checks the numbers again and asks again if the list changed since the
 * page was opened. It never resets anyone: people who have activated are
 * not in the list. Place it inside the <SlipsForm>.
 */
export function BulkPrintButton({
  intent,
  total,
  replaced,
  label,
  order,
  note,
  showCount = true,
  variant = "secondary",
}: {
  intent: BulkIntent;
  /** Add the number of slips to the label, e.g. "(412)". */
  showCount?: boolean;
  /** How many slips, as the page counted them. */
  total: number;
  /** How many of those people hold an unused slip that still works. */
  replaced: number;
  /** "Print slips for everyone not yet activated" (the count is added). */
  label: string;
  /** "in order of class, section and roll number" */
  order: string;
  /** A last sentence for the line under the button. */
  note?: string;
  variant?: ButtonVariant;
}) {
  const state = useFormResult();
  const asked = state?.error ? dataOf(state).bulk : undefined;
  const server = asked && asked.intent === intent ? asked : undefined;
  const [asking, setAsking] = useState(false);
  const [dismissed, setDismissed] = useState<FormState>(undefined);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  const hintId = useId();
  const questionId = useId();

  // After a successful print the question is over.
  useEffect(() => {
    if (state?.ok) setAsking(false);
  }, [state]);

  const showServer = !!server && dismissed !== state;
  const confirming = asking || showServer;
  useEffect(() => {
    if (confirming) questionRef.current?.focus();
    else if (cancelled.current) {
      cancelled.current = false;
      triggerRef.current?.focus();
    }
  }, [confirming, state]);

  // The numbers the next press is about: the server's, once it has answered with newer ones.
  const t = showServer ? server!.total : total;
  const r = showServer ? server!.replaced : replaced;
  const sheets = sheetsFor(t);
  const slipsWord = t === 1 ? "1 slip" : `${num(t)} slips`;
  const sheetsWord = sheets === 1 ? "1 A4 sheet" : `${num(sheets)} A4 sheets`;
  const who = r === t ? (t === 1 ? "This person already has" : `All ${num(t)} already have`) : `${num(r)} of them already ${r === 1 ? "has" : "have"}`;
  const replacedText = r
    ? `${who} a slip that hasn’t been used yet. ${r === 1 ? "That slip stops" : "Those slips stop"} working, so hand out the new ${r === 1 ? "one" : "ones"} instead.`
    : "";
  const pendingLabel = t > LARGE_PRINT ? `Printing ${slipsWord}… this can take a minute` : "Printing…";
  const seen = <input type="hidden" name="bulkSeen" value={bulkKey(t, r)} />;

  if (confirming) {
    return (
      <div role="group" aria-labelledby={questionId} className="grid basis-full gap-3 rounded-2xl bg-ochre-50 p-4 ring-1 ring-ochre-500/30">
        <p id={questionId} ref={questionRef} tabIndex={-1} className="flex gap-2.5 text-forest-900 outline-none">
          <Printer className="mt-0.5 h-5 w-5 shrink-0 text-ochre-600" aria-hidden />
          <span>
            {showServer && server!.changed ? "The list has changed since this page was opened. " : ""}
            <strong className="font-semibold">
              Print {slipsWord} on {sheetsWord}?
            </strong>{" "}
            They come out {order}. {replacedText}
          </span>
        </p>
        {seen}
        <input type="hidden" name="bulkConfirmed" value="1" />
        <div className="flex flex-wrap gap-2">
          <ChoiceButton value={intent} pendingLabel={pendingLabel}>
            Yes, print {slipsWord}
          </ChoiceButton>
          {r > 0 && r < t ? (
            // Keep the slips already handed out working: print only for the others.
            <ChoiceButton value={`${intent}+new`} variant="secondary" pendingLabel={t - r > LARGE_PRINT ? `Printing ${num(t - r)} slips… this can take a minute` : "Printing…"}>
              Print only the {num(t - r)} without a working slip
            </ChoiceButton>
          ) : null}
          <button
            type="button"
            onClick={() => {
              cancelled.current = true;
              setAsking(false);
              setDismissed(state);
            }}
            className={buttonClasses("ghost", "md")}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const text = showCount ? `${label} (${num(t)})` : label;
  return (
    <>
      {bulkNeedsConfirm(t, r) ? (
        <button ref={triggerRef} type="button" aria-describedby={hintId} onClick={() => setAsking(true)} className={buttonClasses(variant, "md", "py-2.5 text-left")}>
          <Printer className="h-4 w-4 shrink-0" aria-hidden />
          {text}
        </button>
      ) : (
        <ChoiceButton ref={triggerRef} value={intent} variant={variant} describedBy={hintId} pendingLabel={pendingLabel}>
          {text}
        </ChoiceButton>
      )}
      {seen}
      <p id={hintId} className="basis-full text-[0.88rem] text-muted">
        {slipsWord} on {sheetsWord}, {order}.{r ? ` ${replacedText}` : ""}
        {note ? ` ${note}` : ""}
      </p>
    </>
  );
}

/** One of several submit buttons of the same form ("intent"): only the one pressed shows that it is working. */
function ChoiceButton({
  value,
  children,
  pendingLabel,
  variant = "primary",
  describedBy,
  ref,
}: {
  value: string;
  children: ReactNode;
  pendingLabel: ReactNode;
  variant?: ButtonVariant;
  describedBy?: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  const { pending, data } = useFormStatus();
  const mine = pending && data?.get("intent") === value;
  return (
    <button
      ref={ref}
      type="submit"
      name="intent"
      value={value}
      disabled={pending}
      aria-disabled={pending}
      aria-describedby={describedBy}
      className={buttonClasses(variant, "md", "py-2.5 text-left")}
    >
      {mine ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden /> : <Printer className="h-4 w-4 shrink-0" aria-hidden />}
      {mine ? pendingLabel : children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* A two-step button that can submit a form elsewhere on the page       */
/* ------------------------------------------------------------------ */

/**
 * Like ConfirmSubmit, but the final button submits the form named by
 * `form` (so it can sit in a table row, outside that form).
 */
export function ConfirmButton({
  form,
  name,
  value,
  children,
  question,
  confirmLabel,
  variant = "danger",
  size = "sm",
}: {
  form: string;
  name: string;
  value: string;
  children: ReactNode;
  question: ReactNode;
  confirmLabel: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const [asking, setAsking] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (asking) confirmRef.current?.focus();
    else if (cancelled.current) {
      cancelled.current = false;
      triggerRef.current?.focus();
    }
  }, [asking]);
  if (!asking) {
    return (
      <button ref={triggerRef} type="button" onClick={() => setAsking(true)} className={buttonClasses("secondary", size, "whitespace-nowrap")}>
        {children}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-[0.9rem] font-semibold text-forest-900">{question}</span>
      <button ref={confirmRef} type="submit" form={form} name={name} value={value} className={buttonClasses(variant, size, "whitespace-nowrap")}>
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => {
          cancelled.current = true;
          setAsking(false);
        }}
        className={buttonClasses("ghost", size)}
      >
        Cancel
      </button>
    </span>
  );
}

/** A plain submit button for a form elsewhere on the page. */
export function FormButton({
  form,
  name,
  value,
  children,
  variant = "secondary",
  size = "sm",
  className,
}: {
  form: string;
  name: string;
  value: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  return (
    <button type="submit" form={form} name={name} value={value} className={buttonClasses(variant, size, clsx("whitespace-nowrap", className))}>
      {children}
    </button>
  );
}

/** Messages of a form whose buttons live elsewhere (row actions): focused when they appear. */
export function RowActionMessages() {
  const state = useFormResult();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state?.ok || state?.error) ref.current?.focus();
  }, [state]);
  if (!state?.ok && !state?.error) return null;
  return (
    <div ref={ref} tabIndex={-1} className="no-print outline-none">
      {state.error ? <Alert tone="red">{state.error}</Alert> : <Alert tone="green">{state.ok}</Alert>}
    </div>
  );
}
