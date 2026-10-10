/**
 * The boxes shared by "Add a student" and a student's "Edit details" form.
 * (The SR no. is only typed once, when the student is added.)
 */
import type { ReactNode } from "react";
import { SelectField, TextField } from "./fields";

export type StudentDefaults = {
  name?: string | null;
  gender?: string | null;
  dob?: string | null;
  admittedOn?: string | null;
  fatherName?: string | null;
  motherName?: string | null;
  guardianName?: string | null;
  guardianMobile?: string | null;
  mobile2?: string | null;
  address?: string | null;
};

/** A titled group of boxes in a long form. */
export function FormGroup({ title, children, hint, divider = true }: { title: string; children: ReactNode; hint?: ReactNode; divider?: boolean }) {
  return (
    <fieldset className={divider ? "grid gap-5 border-t border-forest-900/10 pt-6" : "grid gap-5"}>
      <legend className="sr-only">{title}</legend>
      <p aria-hidden className="font-display text-[1.25rem] leading-tight text-forest-900">
        {title}
      </p>
      {hint ? <p className="-mt-3 text-[0.9rem] text-muted">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

/** Full name, gender, date of birth and admission date. */
export function StudentPersonFields({ defaults, today, before }: { defaults: StudentDefaults; today: string; before?: ReactNode }) {
  return (
    <>
      {before}
      <TextField name="name" label="Full name" required defaultValue={defaults.name} maxLength={80} autoComplete="off" hint="As in the admission register (2 to 80 characters)." />
      <div className="grid gap-5 sm:grid-cols-2">
        <SelectField name="gender" label="Gender" defaultValue={defaults.gender ?? ""}>
          <option value="">Not given</option>
          <option value="F">Girl</option>
          <option value="M">Boy</option>
          <option value="O">Other</option>
        </SelectField>
        <TextField name="dob" label="Date of birth" type="date" max={today} min="1990-01-01" defaultValue={defaults.dob} />
      </div>
      <TextField
        name="admittedOn"
        label="Admission date"
        type="date"
        max={today}
        min="1990-01-01"
        defaultValue={defaults.admittedOn}
        hint="The date of admission to this school."
        className="sm:max-w-[calc(50%-0.625rem)]"
      />
    </>
  );
}

/** Parents, guardian, mobiles and address. */
export function FamilyFields({ defaults }: { defaults: StudentDefaults }) {
  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField name="fatherName" label="Father’s name" defaultValue={defaults.fatherName} maxLength={80} autoComplete="off" />
        <TextField name="motherName" label="Mother’s name" defaultValue={defaults.motherName} maxLength={80} autoComplete="off" />
      </div>
      <TextField
        name="guardianName"
        label="Guardian’s name"
        defaultValue={defaults.guardianName}
        maxLength={80}
        autoComplete="off"
        hint="Only if the child lives with someone other than the parents."
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          name="guardianMobile"
          label="Parent’s mobile"
          required
          type="tel"
          inputMode="numeric"
          autoComplete="off"
          maxLength={16}
          defaultValue={defaults.guardianMobile}
          hint="10 digits. The school calls this number."
          inputClassName="tabular"
        />
        <TextField
          name="mobile2"
          label="Second mobile"
          type="tel"
          inputMode="numeric"
          autoComplete="off"
          maxLength={16}
          defaultValue={defaults.mobile2}
          hint="Optional."
          inputClassName="tabular"
        />
      </div>
      <TextField name="address" label="Village or address" defaultValue={defaults.address} maxLength={200} autoComplete="off" />
    </>
  );
}
