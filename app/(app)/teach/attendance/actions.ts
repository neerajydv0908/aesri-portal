"use server";

import { refresh } from "next/cache";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { auditActor, canManageSection } from "@/lib/auth/dal";
import { formatDate, isValidIsoDate, todayIST } from "@/lib/dates";
import { done, fail, messageOf, type FormState } from "@/lib/forms";
import { teacherPage } from "@/lib/page";
import { sectionStudents } from "@/lib/queries/school";
import { RecordError } from "@/lib/services/students";
import {
  ATTENDANCE_STATUSES,
  TEACHER_EDIT_DAYS,
  isAttendanceStatus,
  registerWindow,
  saveRegister,
  sessionBounds,
  type RegisterMark,
} from "@/lib/services/attendance";
import { delayWords } from "@/lib/sms/config";
import type { AttendanceSmsResult } from "@/lib/sms/outbox";
import { str } from "@/lib/validation";

/** "3 absent", "3 absent and 1 late", "3 absent, 1 late and 36 present". */
function andList(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : (items[0] ?? "");
}

/** What the teacher is told about the families' text messages after saving. */
function smsSentence(sms: AttendanceSmsResult): string {
  const q = sms.queued;
  const when = delayWords(sms.delaySeconds);
  const parts: string[] = [];
  const marks = [q.absent ? `${q.absent} absent` : "", q.late ? `${q.late} late` : "", q.leave ? `${q.leave} on leave` : "", q.present ? `${q.present} present` : ""].filter(Boolean);
  const total = q.absent + q.late + q.leave + q.present;
  if (total) {
    parts.push(
      marks.length === 1
        ? `The ${total === 1 ? "family" : "families"} of ${total} ${total === 1 ? "student" : "students"} marked ${marks[0].replace(/^\d+ /, "")} will get a text message ${when}.`
        : `Text messages go to the families ${when}: ${andList(marks)}.`,
    );
  }
  if (sms.corrections) parts.push(`${sms.corrections} ${sms.corrections === 1 ? "family who was" : "families who were"} already told will get a correction ${when}.`);
  if (sms.unreachable) parts.push(`${sms.unreachable} ${sms.unreachable === 1 ? "family doesn’t" : "families don’t"} get text messages (no mobile number, or they asked not to).`);
  if (total || sms.corrections) parts.push("If you change a mark before then, only the new mark is sent.");
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export async function saveAttendanceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await teacherPage();
  const sectionId = str(formData, "section");
  const section = ctx.classTeacherSections.find((s) => s.id === sectionId);
  if (!section || !(await canManageSection(ctx.actor, sectionId, "class_teacher"))) notFound();

  const date = str(formData, "date");
  if (!isValidIsoDate(date)) return fail("Choose a valid date, then save again.");
  const today = todayIST();
  if (date > today) return fail("You can't take attendance for a future date.");
  const bounds = await sessionBounds(ctx.sessionId);
  const win = registerWindow(bounds, today, ctx.isAdmin);
  if (date < win.from || date > win.to) {
    return fail(
      ctx.isAdmin
        ? `That date is outside the ${bounds.id} session.`
        : `Teachers can take or change attendance for today and the ${TEACHER_EDIT_DAYS} days before. For an older date, please ask the school office.`,
    );
  }

  // Only students on the roll now are read from the form; any other IDs are ignored.
  const roll = await sectionStudents(sectionId);
  const shown = new Set(str(formData, "roster").split(",").filter(Boolean));
  const added = roll.filter((s) => !shown.has(s.id));
  if (added.length) {
    refresh();
    return fail(
      `The class list has changed since you opened this page: ${added.map((s) => s.name).join(", ")} ${added.length === 1 ? "was" : "were"} added. ` +
        "Please check the list below and save again.",
    );
  }
  const marks: RegisterMark[] = [];
  const unmarked: string[] = [];
  for (const s of roll) {
    const v = str(formData, `st_${s.id}`);
    if (isAttendanceStatus(v)) marks.push({ studentId: s.id, status: v });
    else unmarked.push(s.name);
  }
  if (unmarked.length) return fail(`Choose ${ATTENDANCE_STATUSES.map((x) => x[0].toUpperCase() + x.slice(1)).join(", ")} for ${unmarked.join(", ")}.`);

  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  const db = await getDb();
  let result;
  try {
    result = await db.transaction((tx) => saveRegister(tx, { schoolId: ctx.schoolId, sectionId, date, marks }, who));
  } catch (err) {
    return fail(messageOf(err, [RecordError]));
  }
  refresh();
  const c = result.counts;
  const when = date === today ? "today" : `on ${formatDate(date, "en", { weekday: true })}`;
  return done(
    `Attendance saved for ${section.label} ${when}: ${c.present} present, ${c.absent} absent, ${c.late} late, ${c.leave} on leave.` +
      (result.firstSave ? "" : result.changed ? ` ${result.changed} ${result.changed === 1 ? "mark" : "marks"} changed.` : " Nothing had changed.") +
      smsSentence(result.sms),
  );
}
