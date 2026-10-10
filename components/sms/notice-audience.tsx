/**
 * Choosing who a notice is for.
 *
 *  - <NoticeTargetPicker>: the office's first step, a small GET form: the
 *    whole school, staff only, or one class (so the class's students can be
 *    listed below without JavaScript).
 *  - <ClassAudienceFields>: inside a notice form for one class: "The whole
 *    class" or "Chosen students", with a tick box for each student. The
 *    list hides while "The whole class" is chosen (where the browser
 *    supports :has(); otherwise it simply stays visible and is ignored).
 *
 * The server checks every ticked student is on the class's roll.
 */
import type { ReactNode } from "react";
import clsx from "clsx";
import { Users, UserCheck } from "lucide-react";
import { Button, Select } from "@/components/ui";
import { FieldError } from "@/components/forms";
import type { SectionRow } from "@/lib/queries/school";

export function NoticeTargetPicker({ action, value, sections, hidden }: { action: string; value: string; sections: SectionRow[]; hidden?: Record<string, string> }) {
  return (
    <form method="get" action={action} className="no-print grid gap-2 rounded-2xl bg-cream-100/70 p-4 ring-1 ring-forest-900/10 sm:p-5">
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label htmlFor="pick-to" className="text-[0.92rem] font-semibold text-forest-900">
        Who is it for?
      </label>
      <p id="pick-to-hint" className="-mt-1 text-[0.85rem] text-muted">
        Choose this first: changing it reloads the form. For some students only, choose their class, then tick them below.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Select id="pick-to" name="to" defaultValue={value} aria-describedby="pick-to-hint" className="min-w-64 sm:max-w-md">
          <option value="school">Whole school: every family, and all staff</option>
          <option value="staff">Staff only</option>
          <optgroup label="One class, or chosen students of it">
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
                {s.stream ? ` (${s.stream})` : ""} · {s.studentCount} {s.studentCount === 1 ? "student" : "students"}
              </option>
            ))}
          </optgroup>
        </Select>
        <Button type="submit" variant="secondary">
          Choose
        </Button>
      </div>
    </form>
  );
}

function ScopeOption({ id, value, label, hint, checked, icon }: { id: string; value: "section" | "students"; label: string; hint: string; checked: boolean; icon: ReactNode }) {
  return (
    <label
      htmlFor={id}
      className={clsx(
        "flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl bg-cream-50 px-3.5 py-2.5 ring-1 ring-forest-900/15 transition-colors hover:ring-forest-900/35",
        "has-checked:bg-sage-50 has-checked:ring-2 has-checked:ring-forest-700 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ochre-500",
      )}
    >
      <input id={id} type="radio" name="scope" value={value} defaultChecked={checked} className="h-5 w-5 shrink-0 accent-forest-700" />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 font-semibold text-forest-900">
          {icon}
          {label}
        </span>
        <span className="block text-[0.82rem] leading-snug text-muted">{hint}</span>
      </span>
    </label>
  );
}

export function ClassAudienceFields({
  sectionLabel,
  roll,
  defaultScope = "section",
  defaultChosen = [],
}: {
  sectionLabel: string;
  roll: { id: string; name: string; rollNo: number | null }[];
  defaultScope?: "section" | "students";
  defaultChosen?: string[];
}) {
  return (
    <fieldset className="group/aud grid gap-3">
      <legend className="mb-1.5 text-[0.92rem] font-semibold text-forest-900">
        Who in {sectionLabel}?<span className="text-clay-600"> *</span>
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <ScopeOption
          id="scope-section"
          value="section"
          label="The whole class"
          hint={`Every family of ${sectionLabel}`}
          checked={defaultScope !== "students"}
          icon={<Users className="h-4 w-4" aria-hidden />}
        />
        <ScopeOption
          id="scope-students"
          value="students"
          label="Chosen students"
          hint="Only the families of the students you tick"
          checked={defaultScope === "students"}
          icon={<UserCheck className="h-4 w-4" aria-hidden />}
        />
      </div>
      <fieldset aria-describedby="students-error" className="grid gap-1 rounded-2xl bg-cream-100/70 p-3 ring-1 ring-forest-900/10 group-has-[#scope-section:checked]/aud:hidden sm:p-4">
        <legend className="px-1 text-[0.92rem] font-semibold text-forest-900">Students of {sectionLabel}</legend>
        {roll.length ? (
          <ul className="grid gap-x-4 sm:grid-cols-2">
            {roll.map((s) => (
              <li key={s.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-1 text-[0.95rem] text-forest-900 hover:bg-forest-900/[0.04]">
                  <input type="checkbox" name="students" value={s.id} defaultChecked={defaultChosen.includes(s.id)} className="h-5 w-5 shrink-0 cursor-pointer accent-forest-700" />
                  <span>
                    {s.rollNo ? <span className="tabular text-muted">{s.rollNo}. </span> : null}
                    {s.name}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-1 text-[0.92rem] text-muted">There are no students in {sectionLabel} yet.</p>
        )}
      </fieldset>
      <FieldError name="students" id="students-error" />
    </fieldset>
  );
}
