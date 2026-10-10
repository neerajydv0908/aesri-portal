"use client";

/**
 * Small live helpers for the records forms. Each is a convenience only: the
 * forms work without JavaScript, and the server checks everything again.
 */
import { useEffect, useRef, useState } from "react";
import { useField } from "./fields";

/** The form element that holds `el`, and one of its fields by name. */
function formField<T extends Element>(el: Element | null, name: string): T | null {
  const form = el?.closest("form");
  const f = form?.elements.namedItem(name);
  return f instanceof Element ? (f as unknown as T) : null;
}

/**
 * "The family's login ID will be Arya7634": follows what is typed in the
 * number box (the SR no. or employee no.).
 */
export function LoginIdPreview({ prefix, field, who, example }: { prefix: string; field: string; who: string; example: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [digits, setDigits] = useState<string | null>(null);
  useEffect(() => {
    const input = formField<HTMLInputElement>(ref.current, field);
    if (!input) return;
    const update = () => {
      const v = input.value.trim();
      setDigits(/^\d{1,9}$/.test(v) ? String(Number(v)) : null);
    };
    update();
    input.addEventListener("input", update);
    return () => input.removeEventListener("input", update);
  }, [field]);
  return (
    <span ref={ref}>
      {digits ? (
        <>
          {who} login ID will be <strong className="font-semibold text-forest-900 tabular">{`${prefix}${digits}`}</strong>.
        </>
      ) : (
        <>
          {who} login ID will be {prefix} followed by this number, for example <span className="tabular">{example}</span>.
        </>
      )}
    </span>
  );
}

/**
 * The "Add the admission fee" box on a new admission: ticked when the
 * admission date falls in this session, unticked otherwise, and not offered
 * for an RTE seat.
 */
export function AdmissionFeeChoice({
  label,
  hint,
  defaultChecked,
  sessionStart,
  sessionEnd,
  name = "admissionFee",
  dateField = "admittedOn",
  rteField = "rte",
}: {
  label: string;
  hint: string;
  defaultChecked: boolean;
  sessionStart: string;
  sessionEnd: string;
  name?: string;
  dateField?: string;
  rteField?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const [rte, setRte] = useState(false);
  const { error, values } = useField(name);
  const checked = values ? values[name] === "yes" : defaultChecked;

  useEffect(() => {
    const date = formField<HTMLInputElement>(ref.current, dateField);
    const rteBox = formField<HTMLInputElement>(ref.current, rteField);
    const onDate = () => {
      if (!box.current || !date) return;
      const v = date.value;
      box.current.checked = !!v && v >= sessionStart && v <= sessionEnd;
    };
    const onRte = () => setRte(!!rteBox?.checked);
    onRte();
    date?.addEventListener("change", onDate);
    rteBox?.addEventListener("change", onRte);
    return () => {
      date?.removeEventListener("change", onDate);
      rteBox?.removeEventListener("change", onRte);
    };
  }, [dateField, rteField, sessionStart, sessionEnd]);

  const described = [error ? `${name}-error` : null, `${name}-hint`].filter(Boolean).join(" ");
  return (
    <div ref={ref} className="grid gap-1.5">
      <label htmlFor={name} className={rte ? "flex cursor-not-allowed items-start gap-3 text-[0.95rem] text-forest-900 opacity-60" : "flex cursor-pointer items-start gap-3 text-[0.95rem] text-forest-900"}>
        <input
          ref={box}
          type="checkbox"
          id={name}
          name={name}
          value="yes"
          defaultChecked={checked}
          disabled={rte}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          className="mt-0.5 h-6 w-6 shrink-0 cursor-pointer rounded-md accent-forest-700 disabled:cursor-not-allowed"
        />
        <span className="font-semibold">{label}</span>
      </label>
      <p id={`${name}-hint`} className="pl-9 text-[0.85rem] text-muted" aria-live="polite">
        {rte ? "No admission fee is charged for an RTE seat." : hint}
      </p>
      {error ? (
        <p id={`${name}-error`} className="pl-9 text-[0.85rem] font-semibold text-clay-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Under the "make class teacher of" choice: who is class teacher of the
 * chosen section now, and so who will be replaced.
 */
export function ClassTeacherNote({ field, person, sections }: { field: string; person: string; sections: Record<string, { label: string; teacher: string | null }> }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [chosen, setChosen] = useState<string>("");
  useEffect(() => {
    const select = formField<HTMLSelectElement>(ref.current, field);
    if (!select) return;
    const update = () => setChosen(select.value);
    update();
    select.addEventListener("change", update);
    return () => select.removeEventListener("change", update);
  }, [field]);
  const s = chosen ? sections[chosen] : undefined;
  return (
    <p ref={ref} aria-live="polite" className="text-[0.88rem] text-forest-900">
      {s ? (
        s.teacher ? (
          <>
            <strong className="font-semibold">{s.teacher}</strong> is the class teacher of {s.label} now. Saving makes {person} the class teacher instead.
          </>
        ) : (
          <>{s.label} has no class teacher yet.</>
        )
      ) : null}
    </p>
  );
}
