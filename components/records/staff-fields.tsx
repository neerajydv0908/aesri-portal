/**
 * The boxes shared by "Add a staff member" and a staff member's "Edit
 * details" form, and the portal access choice.
 */
import { addDays } from "@/lib/dates";
import { ACCESS_LABELS, type StaffAccess } from "@/lib/roles";
import { ADMIN_ACCESS_TEXT, isAdminAccess } from "@/lib/services/staff";
import { RadioCards, TextField } from "./fields";

export const DESIGNATIONS = ["Principal", "Teacher", "Mother teacher", "Office staff", "Accountant", "Director", "Driver", "Helper", "Other"];

/** What each portal access lets someone do, in one line. */
export const ACCESS_HINTS: Record<StaffAccess, string> = {
  teacher: "Attendance, homework, marks and remarks for their own classes.",
  principal: "Everything in this school: records, fees, results and notices.",
  office_admin: "Everything in this school, like the principal.",
  accounts: "Fees and receipts. Can look up students but not change them.",
  none: "Listed as staff, but can’t sign in (for example drivers and helpers).",
};

export const ACCESS_ORDER: StaffAccess[] = ["teacher", "principal", "office_admin", "accounts", "none"];

export type StaffDefaults = { name?: string | null; designation?: string | null; mobile?: string | null; email?: string | null; joinedOn?: string | null };

/**
 * Name, designation, mobile, email and date of joining. Render <DesignationList /> once on the page too.
 * `mobileRequired`: true for someone who signs in; false for "No login" staff; "depends" while the access is still being chosen.
 */
export function StaffDetailFields({ defaults, today, mobileRequired }: { defaults: StaffDefaults; today: string; mobileRequired: boolean | "depends" }) {
  return (
    <>
      <TextField name="name" label="Full name" required defaultValue={defaults.name} maxLength={80} autoComplete="off" />
      <TextField
        name="designation"
        label="Designation"
        defaultValue={defaults.designation}
        maxLength={60}
        autoComplete="off"
        list="designation-choices"
        hint="Choose from the list or type another, for example “Teacher” or “Driver”."
        inputClassName="sm:max-w-[calc(50%-0.625rem)]"
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          name="mobile"
          label="Mobile"
          required={mobileRequired === true}
          type="tel"
          inputMode="numeric"
          autoComplete="off"
          maxLength={16}
          defaultValue={defaults.mobile}
          hint={
            mobileRequired === true
              ? "10 digits."
              : mobileRequired === "depends"
                ? "10 digits. Needed for everyone who signs in; optional for “No login” staff."
                : "10 digits. Optional, because they don’t sign in."
          }
          inputClassName="tabular"
        />
        <TextField name="email" label="Email" type="email" autoComplete="off" maxLength={120} defaultValue={defaults.email} hint="Optional." />
      </div>
      <TextField
        name="joinedOn"
        label="Date of joining"
        type="date"
        min="1960-01-01"
        max={addDays(today, 365)}
        defaultValue={defaults.joinedOn}
        hint="Optional."
        className="sm:max-w-[calc(50%-0.625rem)]"
      />
    </>
  );
}

export function DesignationList() {
  return (
    <datalist id="designation-choices">
      {DESIGNATIONS.map((d) => (
        <option key={d} value={d} />
      ))}
    </datalist>
  );
}

/**
 * The portal access choice. With `adminLocked` (a school admin, not an AESRI
 * administrator), Principal and Office admin are shown but can't be chosen,
 * with the reason; the server refuses them too.
 */
export function AccessChoice({
  defaultValue,
  legend = "Portal access",
  columns,
  adminLocked = false,
}: {
  defaultValue?: StaffAccess | null;
  legend?: string;
  columns?: string;
  adminLocked?: boolean;
}) {
  return (
    <RadioCards
      name="access"
      legend={legend}
      required
      columns={columns}
      defaultValue={defaultValue ?? undefined}
      options={ACCESS_ORDER.map((a) => ({
        value: a,
        label: ACCESS_LABELS[a],
        hint: ACCESS_HINTS[a],
        disabled: adminLocked && isAdminAccess(a),
        note: "Given by the AESRI administrator only.",
      }))}
      hint={
        <>
          Principal, Office admin and Accounts also set up an authenticator app on their phone the first time they sign in.
          {adminLocked ? ` ${ADMIN_ACCESS_TEXT.hint}` : null}
        </>
      }
    />
  );
}
