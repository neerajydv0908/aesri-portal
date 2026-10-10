"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { auditActor } from "@/lib/auth/dal";
import type { FormState } from "@/lib/forms";
import { officePage } from "@/lib/page";
import { cleanRegisterNumber } from "@/lib/ids";
import { todayIST } from "@/lib/dates";
import { str } from "@/lib/validation";
import { listSubjects } from "@/lib/queries/school";
import { staffByEmpNo } from "@/lib/queries/records";
import { ADMIN_ACCESS_TEXT, createStaff, isAdminAccess, isStaffAccess, mayManageAdminAccess, setStaffSubjects } from "@/lib/services/staff";
import { RecordError } from "@/lib/services/students";
import { failFields, failWith, isUniqueViolation } from "@/components/records/form-state";
import { readStaffDetails } from "../form-data";

/** A new staff member, their sign-in account (unless "No login") and the subjects they teach, together. */
export async function createStaffAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, schoolId } = await officePage();

  const access = str(formData, "access");
  // Only "No login" staff (drivers, helpers) may be added without a mobile number.
  const { fields, errors } = readStaffDetails(formData, todayIST(), { mobileNeeded: access !== "none" });

  const empRaw = str(formData, "empNo");
  const empNo = cleanRegisterNumber(empRaw);
  if (!empRaw) errors.empNo = "Enter the employee number from the staff register.";
  else if (!empNo || empNo === "0") errors.empNo = "The employee number is a number (digits only, up to 9), for example 12.";

  if (!isStaffAccess(access)) errors.access = "Choose what they can do in the portal.";
  // Principal and Office admin access is given by AESRI administrators only (the choice is shown greyed out to school admins).
  else if (isAdminAccess(access) && !mayManageAdminAccess(actor.role)) errors.access = ADMIN_ACCESS_TEXT.add;

  const known = new Set((await listSubjects(schoolId)).map((s) => s.id));
  const subjectIds = [...new Set(formData.getAll("subjects").filter((v): v is string => typeof v === "string"))];
  if (subjectIds.some((id) => !known.has(id))) errors.subjects = "One of the subjects is no longer in the list. Reload the page and tick them again.";

  if (empNo && !errors.empNo) {
    const dupe = await staffByEmpNo(schoolId, empNo);
    if (dupe) errors.empNo = `Employee no. ${empNo} is already used by ${dupe.name}. Check the staff register.`;
  }
  if (Object.keys(errors).length || !isStaffAccess(access) || !empNo) return failFields(formData, errors);

  const who = await auditActor(actor);
  const db = await getDb();
  let created: { id: string };
  try {
    created = await db.transaction(async (tx) => {
      const s = await createStaff(tx, schoolId, { empNo, access, ...fields }, who);
      if (subjectIds.length) await setStaffSubjects(tx, schoolId, s.id, subjectIds, who);
      return s;
    });
  } catch (err) {
    if (err instanceof RecordError) return failWith(formData, err.message, err.message.startsWith("Employee number") ? { empNo: err.message } : undefined);
    if (isUniqueViolation(err)) {
      const msg = `Employee no. ${empNo} was just used for someone else. Check the staff list before trying again.`;
      return failWith(formData, msg, { empNo: msg });
    }
    throw err;
  }
  redirect(`/office/staff/${created.id}?done=created`);
}
