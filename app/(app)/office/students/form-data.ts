/**
 * Reading the student forms ("Add a student" and "Edit details"): every box
 * is checked and tidied, and each problem is described next to its box.
 */
import { addDays } from "@/lib/dates";
import { cleanText, parseDate, parseGender, parseMobile, str } from "@/lib/validation";
import type { StudentFields } from "@/lib/services/students";

/** Names are 2 to 80 characters with a letter, as in the Excel import; the address up to 200. */
export const LIMITS = { name: 80, person: 80, address: 200 } as const;

/** What is wrong with a typed name (null: fine). */
function nameProblem(name: string, who: "student" | "person"): string | null {
  if (name.length > LIMITS.name) return `The name is longer than ${LIMITS.name} characters. Shorten it, for example by leaving out a middle name.`;
  if (name.length < 2 || !/\p{L}/u.test(name)) {
    return who === "student" ? "Enter the student’s full name as in the admission register (2 to 80 characters)." : "Enter the full name (2 to 80 characters), or leave this empty.";
  }
  return null;
}

export type DetailFields = Required<Pick<StudentFields, "name" | "gender" | "dob" | "admittedOn" | "fatherName" | "motherName" | "guardianName" | "guardianMobile" | "mobile2" | "address">>;

/** Everything on the "Edit details" form (the SR no., class, RTE seat and status are changed elsewhere). */
export function readStudentDetails(formData: FormData, today: string): { fields: DetailFields; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const name = cleanText(formData.get("name"), 200);
  if (!name) errors.name = "Enter the student’s full name.";
  else {
    const p = nameProblem(name, "student");
    if (p) errors.name = p;
  }
  // Parents' and guardian's names are optional; when given, the same rule as the student's.
  const person = (key: "fatherName" | "motherName" | "guardianName") => {
    const v = cleanText(formData.get(key), 200);
    const p = v ? nameProblem(v, "person") : null;
    if (p) errors[key] = p;
    return v;
  };
  const fatherName = person("fatherName");
  const motherName = person("motherName");
  const guardianName = person("guardianName");

  const genderRaw = str(formData, "gender");
  const gender = genderRaw ? parseGender(genderRaw) : null;
  if (gender === "invalid") errors.gender = "Choose boy, girl or other.";

  const dob = parseDate(str(formData, "dob"));
  if (dob === "invalid") errors.dob = "Enter the date of birth as a date, for example 21/06/2016.";
  else if (dob && dob >= today) errors.dob = "The date of birth must be before today.";
  else if (dob && dob < addDays(today, -30 * 365)) errors.dob = "Check the year of birth.";

  const admittedOn = parseDate(str(formData, "admittedOn"));
  if (admittedOn === "invalid") errors.admittedOn = "Enter the admission date as a date, for example 01/04/2026.";
  else if (admittedOn && admittedOn > today) errors.admittedOn = "The admission date can’t be in the future.";
  else if (admittedOn && admittedOn < "1990-01-01") errors.admittedOn = "Check the year of admission.";
  else if (admittedOn && dob && dob !== "invalid" && admittedOn <= dob) errors.admittedOn = "The admission date must be after the date of birth.";

  const guardianMobile = parseMobile(str(formData, "guardianMobile"));
  if (!guardianMobile) errors.guardianMobile = "Enter the parent’s mobile number. The school uses it to contact the family.";
  else if (guardianMobile === "invalid") errors.guardianMobile = "Enter a 10-digit mobile number that starts with 6, 7, 8 or 9.";

  const mobile2 = parseMobile(str(formData, "mobile2"));
  if (mobile2 === "invalid") errors.mobile2 = "Enter a 10-digit mobile number that starts with 6, 7, 8 or 9, or leave this empty.";
  else if (mobile2 && mobile2 === guardianMobile) errors.mobile2 = "This is the same as the parent’s mobile. Leave it empty, or enter another number.";

  return {
    fields: {
      name: name ?? "",
      gender: gender === "invalid" ? null : gender,
      dob: dob === "invalid" ? null : dob,
      admittedOn: admittedOn === "invalid" ? null : admittedOn,
      fatherName,
      motherName,
      guardianName,
      guardianMobile: guardianMobile === "invalid" ? null : guardianMobile,
      mobile2: mobile2 === "invalid" ? null : mobile2,
      address: cleanText(formData.get("address"), LIMITS.address),
    },
    errors,
  };
}

/** A roll number: empty (none yet) or a whole number from 1 to 999. */
export function readRollNo(formData: FormData, key = "rollNo"): { rollNo: number | null; error: string | null } {
  const raw = str(formData, key);
  if (!raw) return { rollNo: null, error: null };
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1) return { rollNo: null, error: "Enter the roll number as a whole number, for example 12, or leave it empty." };
  return { rollNo: Number(raw), error: null };
}
