"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { auditActor } from "@/lib/auth/dal";
import type { FormState } from "@/lib/forms";
import { officePage } from "@/lib/page";
import { cleanRegisterNumber } from "@/lib/ids";
import { todayIST } from "@/lib/dates";
import { str } from "@/lib/validation";
import { listSections } from "@/lib/queries/school";
import { studentBySrNo } from "@/lib/queries/records";
import { sessionBounds } from "@/lib/services/attendance";
import { currentPlan } from "@/lib/services/fees";
import { createStudent, RecordError } from "@/lib/services/students";
import { failFields, failWith, isUniqueViolation } from "@/components/records/form-state";
import { readRollNo, readStudentDetails } from "../form-data";

/** A new admission: the student, their class for the session, the family's account and their fee lines, together. */
export async function createStudentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, schoolId, sessionId } = await officePage();
  const today = todayIST();
  const { fields, errors } = readStudentDetails(formData, today);

  const srRaw = str(formData, "srNo");
  const srNo = cleanRegisterNumber(srRaw);
  if (!srRaw) errors.srNo = "Enter the SR no. from the admission register.";
  else if (!srNo || srNo === "0") errors.srNo = "The SR no. is a number (digits only, up to 9), for example 7634.";

  const sectionList = await listSections(schoolId, sessionId);
  const section = sectionList.find((s) => s.id === str(formData, "sectionId"));
  if (!section) errors.sectionId = "Choose the class and section.";
  const { rollNo, error: rollError } = readRollNo(formData);
  if (rollError) errors.rollNo = rollError;

  const rte = str(formData, "rte") === "yes";
  const db = await getDb();
  const [plan, bounds] = await Promise.all([currentPlan(db, schoolId), sessionBounds(sessionId)]);
  const fee = plan?.oneTime.find((o) => o.key === "admission");
  const chargeAdmissionFee = !rte && !!fee && str(formData, "admissionFee") === "yes";
  if (chargeAdmissionFee && !errors.admittedOn) {
    if (!fields.admittedOn) errors.admissionFee = "Enter the admission date: the admission fee is only for students admitted in this session.";
    else if (fields.admittedOn < bounds.startsOn || fields.admittedOn > bounds.endsOn) {
      errors.admissionFee = `The admission date is not in the ${sessionId} session, so no admission fee is due. Untick this box, or check the date.`;
    }
  }

  if (srNo && !errors.srNo) {
    const dupe = await studentBySrNo(schoolId, srNo);
    if (dupe) errors.srNo = `SR no. ${srNo} is already used by ${dupe.name}. Check the admission register.`;
  }
  if (Object.keys(errors).length) return failFields(formData, errors);

  const who = await auditActor(actor);
  let created: { id: string };
  try {
    created = await db.transaction((tx) =>
      createStudent(tx, schoolId, sessionId, { srNo: srNo!, ...fields, rte }, { sectionId: section!.id, rollNo }, who, { chargeAdmissionFee }),
    );
  } catch (err) {
    if (err instanceof RecordError) return failWith(formData, err.message, err.message.startsWith("SR number") ? { srNo: err.message } : undefined);
    if (isUniqueViolation(err)) {
      const msg = `SR no. ${srNo} was just used for another student. Check the student list before trying again.`;
      return failWith(formData, msg, { srNo: msg });
    }
    throw err;
  }
  redirect(`/office/students/${created.id}?done=created`);
}
