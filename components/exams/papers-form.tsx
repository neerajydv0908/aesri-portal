"use client";

/**
 * Maximum marks for each subject of one class, for one exam. An empty box
 * means the subject isn't examined. "Apply to all" sets the same maximum for
 * every subject taught in the class in one step.
 */
import clsx from "clsx";
import { useRef, useState } from "react";
import { inputClasses } from "@/components/ui";
import type { FormState } from "@/lib/forms";
import { StickyFieldError, StickyForm, StickySubmit, useStickyForm } from "./sticky-form";

/** The kit's input style without its full width. */
const boxClasses = inputClasses.replace(/\bw-full\b/, "");

export type PaperFormSubject = { subjectId: string; name: string; max: number | null; taught: boolean };

export function PapersForm({
  action,
  examId,
  classId,
  classLabel,
  subjects,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  examId: string;
  classId: string;
  classLabel: string;
  subjects: PaperFormSubject[];
}) {
  const saved = () => Object.fromEntries(subjects.map((s) => [s.subjectId, s.max === null ? "" : String(s.max)]));
  const version = subjects.map((s) => `${s.subjectId}=${s.max ?? ""}`).join("|");
  const [vals, setVals] = useState<Record<string, string>>(saved);
  const [ver, setVer] = useState(version);
  if (ver !== version) {
    setVer(version);
    setVals(saved());
  }
  return (
    <StickyForm action={action} aria-label={`Maximum marks for ${classLabel}`} className="gap-4">
      <input type="hidden" name="exam" value={examId} />
      <input type="hidden" name="class" value={classId} />
      <Fields classId={classId} classLabel={classLabel} subjects={subjects} vals={vals} setVals={setVals} />
    </StickyForm>
  );
}

function Fields({
  classId,
  classLabel,
  subjects,
  vals,
  setVals,
}: {
  classId: string;
  classLabel: string;
  subjects: PaperFormSubject[];
  vals: Record<string, string>;
  setVals: (fn: (cur: Record<string, string>) => Record<string, string>) => void;
}) {
  const { state } = useStickyForm();
  const apply = useRef<HTMLButtonElement>(null);
  const sameId = `same-${classId}`;
  return (
    <>
      <ul className="grid">
        {subjects.map((s) => {
          const id = `max-${classId}-${s.subjectId}`;
          const err = state?.fields?.[`max:${s.subjectId}`];
          return (
            <li key={s.subjectId} className="border-b border-forest-900/[0.07] py-1.5 last:border-b-0">
              <div className="flex min-h-12 items-center justify-between gap-4">
                <label htmlFor={id} className="min-w-0 text-[0.95rem] font-semibold text-forest-900">
                  {s.name}
                  {!s.taught ? <span className="block text-[0.8rem] font-normal text-ochre-600">No longer taught in this class — clear the box to remove</span> : null}
                </label>
                <input
                  id={id}
                  name={`max:${s.subjectId}`}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="—"
                  value={vals[s.subjectId] ?? ""}
                  onChange={(e) => setVals((cur) => ({ ...cur, [s.subjectId]: e.target.value }))}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? `${id}-error` : undefined}
                  className={clsx(boxClasses, "w-24 shrink-0 text-right tabular")}
                />
              </div>
              <StickyFieldError name={`max:${s.subjectId}`} id={`${id}-error`} />
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-t border-forest-900/10 pt-4">
        <StickySubmit pendingLabel="Saving…">Save {classLabel}</StickySubmit>
        <div className="grid gap-1.5">
          <label htmlFor={sameId} className="text-[0.85rem] font-semibold text-forest-900">
            Same maximum for all subjects
          </label>
          <div className="flex gap-2">
            <input
              id={sameId}
              name="same"
              inputMode="numeric"
              autoComplete="off"
              placeholder="e.g. 100"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit(apply.current);
                }
              }}
              aria-invalid={state?.fields?.same ? true : undefined}
              aria-describedby={state?.fields?.same ? `${sameId}-error` : undefined}
              className={clsx(boxClasses, "w-28 text-right tabular")}
            />
            <StickySubmit ref={apply} name="intent" value="same" variant="secondary" pendingLabel="Applying…" className="whitespace-nowrap">
              Apply to all
            </StickySubmit>
          </div>
          <StickyFieldError name="same" id={`${sameId}-error`} />
        </div>
      </div>
    </>
  );
}
