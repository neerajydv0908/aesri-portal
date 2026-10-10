"use server";

import { refresh } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { auditActor } from "@/lib/auth/dal";
import { done, fail, type FormState } from "@/lib/forms";
import { officePage } from "@/lib/page";
import { classLabel } from "@/lib/classes";
import { formatDate, todayIST } from "@/lib/dates";
import { parseDate, str } from "@/lib/validation";
import { listSections } from "@/lib/queries/school";
import { isStudentStatus, sameRollNo, studentRecord } from "@/lib/queries/records";
import { PaymentError, rupees } from "@/lib/services/fees";
import { placeStudent, RecordError, updateStudent } from "@/lib/services/students";
import { STUDENT_STATUS_LABELS } from "@/components/records/badges";
import { failFields, failWith, listText, plural } from "@/components/records/form-state";
import { readRollNo, readStudentDetails } from "../form-data";
import { setFamilySmsOff } from "@/lib/sms/outbox";

/** The student (of the office's school) the form is about, or "not found". */
async function load(studentId: string) {
  const ctx = await officePage();
  const s = await studentRecord(ctx.schoolId, ctx.sessionId, studentId);
  if (!s) notFound();
  return { ...ctx, s, who: await auditActor(ctx.actor) };
}

const ONLY_CURRENT = "This student is not current. Mark them as current again first (under Status).";

/** Name, dates, family and contact details. */
export async function saveDetailsAction(studentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { schoolId, sessionId, s, who } = await load(studentId);
  const { fields, errors } = readStudentDetails(formData, todayIST());
  if (Object.keys(errors).length) return failFields(formData, errors);
  const db = await getDb();
  let changed: string[];
  try {
    ({ changed } = await db.transaction((tx) => updateStudent(tx, schoolId, sessionId, s.id, fields, who)));
  } catch (err) {
    if (err instanceof RecordError) return failWith(formData, err.message);
    throw err;
  }
  refresh();
  return done(changed.length ? "The details were saved." : "Nothing had changed, so there was nothing to save.");
}

/** Class, section and roll number for this session. A change of class re-prices the session's fee instalments. */
export async function placeAction(studentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { schoolId, sessionId, s, who } = await load(studentId);
  if (s.status !== "active") return fail(ONLY_CURRENT);
  const errors: Record<string, string> = {};
  const section = (await listSections(schoolId, sessionId)).find((x) => x.id === str(formData, "sectionId"));
  if (!section) errors.sectionId = "Choose the class and section.";
  const { rollNo, error } = readRollNo(formData);
  if (error) errors.rollNo = error;
  if (!section || Object.keys(errors).length) return failFields(formData, errors);

  const before = s.placement;
  if (before && before.sectionId === section.id && before.rollNo === rollNo) return done("Nothing had changed, so there was nothing to save.");
  const db = await getDb();
  let others: { name: string }[];
  try {
    others = await db.transaction(async (tx) => {
      await placeStudent(tx, schoolId, sessionId, s.id, section.id, rollNo, who);
      return rollNo ? sameRollNo(tx, section.id, rollNo, s.id) : [];
    });
  } catch (err) {
    if (err instanceof RecordError || err instanceof PaymentError) return failWith(formData, err.message);
    throw err;
  }
  refresh();

  const newClass = classLabel(section.className, section.stream);
  let msg: string;
  if (!before) msg = `Placed in ${section.label}${rollNo ? `, roll no. ${rollNo}` : ""}. This session’s fee lines follow the fee for ${newClass}.`;
  else if (before.classId !== section.classId) msg = `Moved to ${section.label}${rollNo ? `, roll no. ${rollNo}` : ""}. This session’s fee instalments now follow the fee for ${newClass}.`;
  else if (before.sectionId !== section.id) msg = `Moved to ${section.label}${rollNo ? `, roll no. ${rollNo}` : ""}. The fees don’t change.`;
  else msg = rollNo ? `The roll no. is now ${rollNo}.` : "The roll no. was removed.";
  if (others.length) msg += ` Roll no. ${rollNo} in ${section.label} is also given to ${listText(others.map((o) => o.name))} — please check.`;
  return done(msg);
}

/** RTE seat on or off: waives or restores only this session's unpaid fee lines. */
export async function rteAction(studentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { schoolId, sessionId, s, who } = await load(studentId);
  if (s.status !== "active") return fail(ONLY_CURRENT);
  const want = str(formData, "rte") === "yes";
  if (s.rte === want) return done(want ? "This student already has an RTE seat." : "This student doesn’t have an RTE seat.");
  const db = await getDb();
  let result;
  try {
    result = await db.transaction((tx) => updateStudent(tx, schoolId, sessionId, s.id, { rte: want }, who));
  } catch (err) {
    if (err instanceof RecordError || err instanceof PaymentError) return fail(err.message);
    throw err;
  }
  refresh();
  const n = result.rte?.changed ?? 0;
  const paid = result.rte?.alreadyPaid ?? 0;
  if (want) {
    return done(
      `RTE seat recorded. ${n ? `${plural(n, "unpaid fee line was", "unpaid fee lines were")} waived` : "There were no unpaid fee lines to waive this session"}` +
        (paid ? `; ${rupees(paid)} already paid stays on record (any refund is handled by the office).` : "."),
    );
  }
  return done(
    `RTE seat removed. ${n ? `${plural(n, "fee line that was waived for the RTE seat is", "fee lines that were waived for the RTE seat are")} due again.` : "No fee lines had been waived for the RTE seat this session."}`,
  );
}

/** No longer at the school (left, transferred, passed out) — or a correction of that status or date. */
export async function statusAction(studentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { schoolId, sessionId, s, who } = await load(studentId);
  const errors: Record<string, string> = {};
  const status = str(formData, "status");
  if (!isStudentStatus(status) || status === "active") errors.status = "Choose left, transferred or passed out.";
  const leftOn = parseDate(str(formData, "leftOn"));
  const today = todayIST();
  if (!leftOn) errors.leftOn = "Enter the date the student left the school.";
  else if (leftOn === "invalid") errors.leftOn = "Enter the date as a date, for example 30/09/2026.";
  else if (leftOn > today) errors.leftOn = "The date can’t be in the future.";
  else if (s.admittedOn && leftOn < s.admittedOn) errors.leftOn = `The date can’t be before the admission date (${formatDate(s.admittedOn)}).`;
  else if (leftOn < "1990-01-01") errors.leftOn = "Check the year.";
  if (Object.keys(errors).length || !isStudentStatus(status) || !leftOn || leftOn === "invalid") return failFields(formData, errors);
  const db = await getDb();
  let result;
  try {
    result = await db.transaction((tx) => updateStudent(tx, schoolId, sessionId, s.id, { status, leftOn }, who));
  } catch (err) {
    if (err instanceof RecordError) return failWith(formData, err.message);
    throw err;
  }
  refresh();
  if (!result.changed.length) return done("Nothing had changed, so there was nothing to save.");
  const label = STUDENT_STATUS_LABELS[status].toLowerCase();
  if (s.status === "active") {
    return done(
      `${s.name} is now marked as ${label} (${formatDate(leftOn)}).` +
        (result.signIn === "disabled" ? " The family’s sign-in is turned off and they have been signed out." : "") +
        " Fee records stay as they are: waive on the fee page anything that should no longer be charged.",
    );
  }
  return done(`The status was corrected: ${label}, ${formatDate(leftOn)}.`);
}

/** Back at the school: current again, and the family's sign-in works again. */
export async function currentAgainAction(studentId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const { schoolId, sessionId, s, who } = await load(studentId);
  if (s.status === "active") redirect(`/office/students/${s.id}`); // already current (e.g. saved from another tab)
  const db = await getDb();
  try {
    await db.transaction((tx) => updateStudent(tx, schoolId, sessionId, s.id, { status: "active" }, who));
  } catch (err) {
    if (err instanceof RecordError) return fail(err.message);
    throw err;
  }
  redirect(`/office/students/${s.id}?done=current`);
}

/** The family asked not to get text messages — or asked for them again. Audited; stopping withdraws messages still waiting. */
export async function smsOffAction(studentId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { schoolId, s, who } = await load(studentId);
  const off = str(formData, "smsOff") === "yes";
  const db = await getDb();
  const result = await db.transaction((tx) => setFamilySmsOff(tx, { schoolId, studentId: s.id, off }, who));
  if (!result.changed) return done(off ? "Text messages to this family were already stopped." : "This family already gets text messages.");
  refresh();
  if (off) {
    return done(
      `Text messages to ${s.name}’s family are stopped.${result.withdrawn ? ` ${plural(result.withdrawn, "message that was waiting was", "messages that were waiting were")} withdrawn.` : ""} They still see everything in the portal.`,
    );
  }
  return done(`${s.name}’s family will get text messages again.`);
}
