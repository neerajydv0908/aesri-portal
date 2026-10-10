"use client";

/**
 * The marks grid: one row per student with a marks box and an Absent tick.
 *
 * - Only rows the teacher changed are sent; empty boxes are simply "not
 *   entered yet", so a list can be saved part-way and finished later.
 * - Mistakes are shown as you type and again by the server, which checks
 *   every value; nothing typed is lost when a save is refused.
 * - Enter moves to the next student (like a register); on the last row it saves.
 */
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { inputClasses } from "@/components/ui";
import type { FormState } from "@/lib/forms";
import { parseMarkInput } from "./rules";
import { StickyForm, StickySubmit, useStickyForm } from "./sticky-form";

export type GridRow = {
  studentId: string;
  name: string;
  srNo: string;
  rollNo: number | null;
  /** Saved marks as shown ("18.5"), or "" when none. */
  saved: string;
  savedAbsent: boolean;
};

type Val = { value: string; absent: boolean };
type Vals = Record<string, Val>;

const shown = (v: Val) => (v.absent ? "AB" : v.value.trim());
/** The kit's input style without its full width (the grid sets its own). */
const boxClasses = inputClasses.replace(/\bw-full\b/, "");

export function MarksGrid({
  action,
  examId,
  sectionId,
  subjectId,
  rows,
  max,
  caption,
  version,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  examId: string;
  sectionId: string;
  subjectId: string;
  rows: GridRow[];
  max: number;
  caption: string;
  /** Changes whenever the saved marks change, so the grid reloads them. */
  version: string;
}) {
  const fromProps = (): Vals => Object.fromEntries(rows.map((r) => [r.studentId, { value: r.saved, absent: r.savedAbsent }]));
  const [vals, setVals] = useState<Vals>(fromProps);
  const [ver, setVer] = useState(version);
  const [edited, setEdited] = useState<Set<string>>(() => new Set());
  if (ver !== version) {
    // Saved marks changed on the server (after a save): show what is stored now.
    setVer(version);
    setVals(fromProps());
    setEdited(new Set());
  }

  const setVal = (id: string, v: Val) => {
    setVals((cur) => ({ ...cur, [id]: v }));
    setEdited((cur) => (cur.has(id) ? cur : new Set(cur).add(id)));
  };

  const dirty = rows.filter((r) => shown(vals[r.studentId]) !== (r.savedAbsent ? "AB" : r.saved)).length;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <StickyForm action={action} onSubmitted={() => setEdited(new Set())} aria-label={caption} className="gap-4">
      <input type="hidden" name="exam" value={examId} />
      <input type="hidden" name="section" value={sectionId} />
      <input type="hidden" name="subject" value={subjectId} />
      <Rows rows={rows} vals={vals} setVal={setVal} edited={edited} max={max} caption={caption} dirty={dirty} />
    </StickyForm>
  );
}

function Rows({
  rows,
  vals,
  setVal,
  edited,
  max,
  caption,
  dirty,
}: {
  rows: GridRow[];
  vals: Vals;
  setVal: (id: string, v: Val) => void;
  edited: Set<string>;
  max: number;
  caption: string;
  dirty: number;
}) {
  const { state } = useStickyForm();
  const inputs = useRef(new Map<string, HTMLInputElement>());

  const problems = new Map<string, string>();
  for (const r of rows) {
    const v = vals[r.studentId];
    const p = parseMarkInput(v.value, v.absent, max);
    const server = edited.has(r.studentId) ? undefined : state?.fields?.[`m:${r.studentId}`];
    const msg = !p.ok ? p.error : server;
    if (msg) problems.set(r.studentId, msg);
  }
  const done = rows.filter((r) => {
    const v = vals[r.studentId];
    const p = parseMarkInput(v.value, v.absent, max);
    return p.ok && (p.absent || p.tenths !== null);
  }).length;

  const focusNext = (index: number, form: HTMLFormElement | null) => {
    for (let j = index + 1; j < rows.length; j++) {
      const el = inputs.current.get(rows[j].studentId);
      if (el && !el.disabled) {
        el.focus();
        el.select();
        return;
      }
    }
    form?.requestSubmit();
  };

  const cell = "border-b border-forest-900/[0.06] px-2.5 py-2 align-top sm:px-4";
  const head = "border-b border-forest-900/10 bg-cream-200/50 px-2.5 py-3 text-[0.74rem] font-bold uppercase tracking-[0.1em] text-muted sm:px-4";

  return (
    <>
      {state?.error && problems.size ? (
        <div className="rounded-2xl bg-clay-50 px-4 py-3 ring-1 ring-clay-500/30">
          <p className="font-semibold text-forest-900">Please check {problems.size === 1 ? "this entry" : `these ${problems.size} entries`}:</p>
          <ul className="mt-1.5 grid gap-1 text-[0.92rem]">
            {rows
              .filter((r) => problems.has(r.studentId))
              .map((r) => (
                <li key={r.studentId}>
                  <a href={`#m-${r.studentId}`} className="font-semibold text-clay-600 underline underline-offset-2">
                    {r.name}
                  </a>
                  : {problems.get(r.studentId)}
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[0.95rem]">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                <th scope="col" className={clsx(head, "w-12 sm:pl-6")}>
                  Roll
                </th>
                <th scope="col" className={head}>
                  Student
                </th>
                <th scope="col" className={clsx(head, "w-32 sm:w-60")}>
                  Marks <span className="normal-case tracking-normal">/ {max}</span>
                </th>
                <th scope="col" className={clsx(head, "w-20 sm:w-28 sm:pr-6")}>
                  Absent
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const v = vals[r.studentId];
                const err = problems.get(r.studentId);
                const inputId = `m-${r.studentId}`;
                const changed = shown(v) !== (r.savedAbsent ? "AB" : r.saved);
                return (
                  <tr key={r.studentId} className={clsx(changed && "bg-ochre-50/60")}>
                    <td className={clsx(cell, "tabular pt-4 text-muted sm:pl-6")}>{r.rollNo ?? "—"}</td>
                    <th scope="row" className={clsx(cell, "pt-3.5 text-left font-semibold text-forest-900")}>
                      <span className="block leading-snug">{r.name}</span>
                      <span className="block text-[0.8rem] font-normal text-muted">
                        SR {r.srNo}
                        {changed ? <span className="ml-1.5 font-semibold text-ochre-600">· not saved</span> : null}
                      </span>
                    </th>
                    <td className={cell}>
                      <label htmlFor={inputId} className="sr-only">
                        Marks for {r.name}
                        {r.rollNo ? `, roll ${r.rollNo}` : ""}, out of {max}
                      </label>
                      <input
                        ref={(el) => {
                          if (el) inputs.current.set(r.studentId, el);
                          else inputs.current.delete(r.studentId);
                        }}
                        id={inputId}
                        name={`m:${r.studentId}`}
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        enterKeyHint={i === rows.length - 1 ? "done" : "next"}
                        value={v.absent ? "" : v.value}
                        placeholder={v.absent ? "AB" : "—"}
                        disabled={v.absent}
                        onChange={(e) => setVal(r.studentId, { value: e.target.value, absent: false })}
                        onBlur={(e) => {
                          const p = parseMarkInput(e.target.value, false, max);
                          if (p.ok && p.absent) setVal(r.studentId, { value: "", absent: true });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const p = parseMarkInput(e.currentTarget.value, false, max);
                            if (p.ok && p.absent) setVal(r.studentId, { value: "", absent: true });
                            focusNext(i, e.currentTarget.form);
                          }
                        }}
                        aria-invalid={err ? true : undefined}
                        aria-describedby={err ? `${inputId}-error` : undefined}
                        className={clsx(boxClasses, "w-24 text-right tabular disabled:bg-cream-200/60 disabled:text-muted")}
                      />
                      {err ? (
                        <p id={`${inputId}-error`} className="mt-1 text-[0.82rem] font-semibold leading-snug text-clay-600">
                          {err}
                        </p>
                      ) : null}
                      <input type="hidden" name={`o:${r.studentId}`} value={r.savedAbsent ? "AB" : r.saved} />
                    </td>
                    <td className={clsx(cell, "sm:pr-6")}>
                      <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-[0.92rem] text-forest-900">
                        <input
                          type="checkbox"
                          name={`a:${r.studentId}`}
                          checked={v.absent}
                          onChange={(e) => setVal(r.studentId, { value: e.target.checked ? "" : v.value, absent: e.target.checked })}
                          className="h-6 w-6 shrink-0 cursor-pointer rounded-md accent-forest-700"
                        />
                        <span>
                          <span className="sr-only sm:not-sr-only">Absent</span>
                          <span aria-hidden className="font-semibold sm:hidden">
                            AB
                          </span>
                          <span className="sr-only">: {r.name}</span>
                        </span>
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-cream-100/95 px-3 py-3 shadow-[0_-10px_24px_-18px_rgba(19,39,28,0.45)] ring-1 ring-forest-900/10 backdrop-blur">
        <p className="text-[0.92rem] text-forest-900">
          <span className="font-semibold">
            {done} of {rows.length}
          </span>{" "}
          entered
          {dirty ? (
            <span className="font-semibold text-ochre-600">
              {" "}
              · {dirty} unsaved {dirty === 1 ? "change" : "changes"}
            </span>
          ) : (
            <span className="text-muted"> · all changes saved</span>
          )}
        </p>
        <StickySubmit pendingLabel="Saving…">Save marks</StickySubmit>
      </div>
    </>
  );
}
