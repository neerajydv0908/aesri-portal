"use client";

/**
 * Report-card remarks for one section and exam: a box per student, written
 * by the teacher, with the student's records this session shown under the
 * name. Nothing is saved until the teacher presses "Save remarks".
 */
import clsx from "clsx";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Alert, buttonClasses, inputClasses } from "@/components/ui";
import type { FormState } from "@/lib/forms";

export type RemarkRow = {
  studentId: string;
  name: string;
  rollNo: number | null;
  /** The records this session, in words ("Attendance 92% · homework done 85% · Half-yearly 74% · …"). */
  facts: string;
  saved: string;
};

export function RemarksEditor({
  examId,
  sectionId,
  rows,
  version,
  max,
  saveAction,
  caption,
}: {
  examId: string;
  sectionId: string;
  rows: RemarkRow[];
  /** Changes whenever the saved remarks change (after a save), so the boxes reload them. */
  version: string;
  max: number;
  saveAction: (prev: FormState, fd: FormData) => Promise<FormState>;
  caption: string;
}) {
  const fromProps = () => Object.fromEntries(rows.map((r) => [r.studentId, r.saved]));
  const [boxes, setBoxes] = useState<Record<string, string>>(fromProps);
  const [ver, setVer] = useState(version);
  if (ver !== version) {
    setVer(version);
    setBoxes(fromProps());
  }

  const [state, dispatch, saving] = useActionState(saveAction, undefined);
  const msgRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state?.error || state?.ok) msgRef.current?.focus();
  }, [state]);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const changed = rows.filter((r) => boxes[r.studentId].trim() !== r.saved.trim());
  useEffect(() => {
    if (!changed.length) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed.length]);

  const setText = (id: string, text: string) => setBoxes((cur) => ({ ...cur, [id]: text }));
  const busy = saving || !ready;

  return (
    <div className="grid gap-6">
      <form
        aria-label={caption}
        noValidate
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          const fd = new FormData();
          fd.set("exam", examId);
          fd.set("section", sectionId);
          for (const r of changed) fd.set(`r:${r.studentId}`, boxes[r.studentId]);
          startTransition(() => dispatch(fd));
        }}
      >
        {state?.error || state?.ok ? (
          <div ref={msgRef} tabIndex={-1} className="outline-none">
            {state.error ? <Alert tone="red">{state.error}</Alert> : <Alert tone="green">{state.ok}</Alert>}
          </div>
        ) : null}
        <ol className="grid gap-3">
          {rows.map((r) => {
            const text = boxes[r.studentId];
            const id = `remark-${r.studentId}`;
            const len = text.trim().length;
            const serverError = state?.fields?.[`r:${r.studentId}`];
            const tooLong = len > max;
            const isChanged = changed.some((c) => c.studentId === r.studentId);
            const describedBy = [`${id}-facts`, `${id}-count`, tooLong || serverError ? `${id}-error` : ""].filter(Boolean).join(" ");
            return (
              <li key={r.studentId} className={clsx("card grid gap-2 p-4 sm:p-5", isChanged && "ring-2 ring-ochre-500/40")}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <label htmlFor={id} className="font-semibold text-forest-900">
                    {r.rollNo ? <span className="tabular text-muted">{r.rollNo}. </span> : null}
                    {r.name}
                  </label>
                  {isChanged ? <span className="text-[0.8rem] font-semibold text-ochre-600">Not saved</span> : null}
                </div>
                <p id={`${id}-facts`} className="text-[0.85rem] text-muted">
                  {r.facts}
                </p>
                <textarea
                  id={id}
                  value={text}
                  onChange={(e) => setText(r.studentId, e.target.value)}
                  rows={3}
                  spellCheck
                  aria-invalid={tooLong || serverError ? true : undefined}
                  aria-describedby={describedBy}
                  className={clsx(inputClasses, "min-h-24 py-2.5 leading-snug")}
                />
                <div className="flex flex-wrap justify-between gap-2 text-[0.82rem]">
                  <span id={`${id}-count`} className={clsx("tabular", tooLong ? "font-semibold text-clay-600" : "text-muted")}>
                    {len} of {max} characters
                  </span>
                </div>
                {tooLong || serverError ? (
                  <p id={`${id}-error`} className="text-[0.85rem] font-semibold text-clay-600">
                    {serverError ?? `Shorten this remark to ${max} characters so it fits on the report card.`}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-cream-100/95 px-3 py-3 shadow-[0_-10px_24px_-18px_rgba(19,39,28,0.45)] ring-1 ring-forest-900/10 backdrop-blur">
          <p className="text-[0.92rem] text-forest-900">
            <span className="font-semibold">
              {rows.filter((r) => boxes[r.studentId].trim()).length} of {rows.length}
            </span>{" "}
            written
            {changed.length ? (
              <span className="font-semibold text-ochre-600">
                {" "}
                · {changed.length} not saved
              </span>
            ) : (
              <span className="text-muted"> · all saved</span>
            )}
          </p>
          <button type="submit" disabled={busy || !changed.length} aria-disabled={busy || !changed.length} className={buttonClasses("primary", "md")}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            {saving ? "Saving…" : "Save remarks"}
          </button>
        </div>
      </form>
    </div>
  );
}
