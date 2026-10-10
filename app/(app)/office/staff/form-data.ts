/** Reading the staff forms: every box is checked and tidied, with each problem described next to its box. */
import { addDays } from "@/lib/dates";
import { cleanText, parseDate, parseMobile, str } from "@/lib/validation";

export type StaffDetails = { name: string; designation: string | null; mobile: string | null; email: string | null; joinedOn: string | null };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Names: 2 to 80 characters with at least one letter (the same rule as the Excel import). */
export const NAME_LIMITS = { min: 2, max: 80 } as const;

export function nameProblem(name: string): string | null {
  if (name.length > NAME_LIMITS.max) return `The name is longer than ${NAME_LIMITS.max} characters. Shorten it, for example by leaving out a middle name.`;
  if (name.length < NAME_LIMITS.min || !/\p{L}/u.test(name)) return `Enter the full name (${NAME_LIMITS.min} to ${NAME_LIMITS.max} characters).`;
  return null;
}

/**
 * The details boxes of "Add a staff member" and "Edit details". A mobile
 * number is needed for staff who sign in to the portal; for "No login"
 * staff (drivers, helpers) it is optional, as in the Excel import.
 */
export function readStaffDetails(formData: FormData, today: string, opts: { mobileNeeded: boolean }): { fields: StaffDetails; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = cleanText(formData.get("name"), 200);
  if (!name) errors.name = "Enter the staff member’s full name.";
  else {
    const p = nameProblem(name);
    if (p) errors.name = p;
  }

  const designation = cleanText(formData.get("designation"), 60);

  const mobile = parseMobile(str(formData, "mobile"));
  if (!mobile && opts.mobileNeeded) errors.mobile = "Enter their mobile number (10 digits). It is needed for everyone who signs in to the portal.";
  else if (mobile === "invalid") errors.mobile = `Enter a 10-digit mobile number that starts with 6, 7, 8 or 9${opts.mobileNeeded ? "" : ", or leave this empty"}.`;

  const email = cleanText(formData.get("email"), 120);
  if (email && !EMAIL.test(email)) errors.email = "Enter an email address like name@example.com, or leave this empty.";

  const joinedOn = parseDate(str(formData, "joinedOn"));
  if (joinedOn === "invalid") errors.joinedOn = "Enter the date of joining as a date, for example 01/07/2024.";
  else if (joinedOn && joinedOn > addDays(today, 365)) errors.joinedOn = "The date of joining is more than a year ahead. Check the year.";
  else if (joinedOn && joinedOn < "1960-01-01") errors.joinedOn = "Check the year of joining.";

  return {
    fields: {
      name: name ?? "",
      designation,
      mobile: mobile === "invalid" ? null : mobile,
      email,
      joinedOn: joinedOn === "invalid" ? null : joinedOn,
    },
    errors,
  };
}
