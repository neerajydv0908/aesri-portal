/**
 * What Stud-AI is told about a student, worked out from the portal's own
 * records (pure arithmetic: no database, no "server-only"; the queries are
 * in lib/studai/estimates.ts).
 *
 * For each subject of the student's class:
 *   tests       each exam's marks as a percentage of that paper's maximum
 *               marks (Unit Test 18.5/25 → 74), oldest exam first. Absent
 *               or not entered: left out. Stud-AI reads the latest 5.
 *   homework    (done + late) ÷ (done + late + not done) for that subject's
 *               homework this session, once at least 3 are checked;
 *               otherwise unknown. Excused doesn't count.
 *   attendance  the whole-day attendance this session (the portal has no
 *               per-subject attendance), once 10 register days are
 *               recorded; otherwise unknown.
 *
 * Unknown values are sent as null: Stud-AI then uses a typical value and
 * says so, and never gives it as a reason.
 */
import crypto from "node:crypto";
import { percentTenths } from "@/components/exams/rules";
import { MIN_ATTENDANCE_DAYS, attendancePercent, homeworkPercent, type AttendanceFigure, type HomeworkFigure } from "@/lib/support/figures";
import { CONTRACT, type SubjectInput } from "./contract";
import { studAiName } from "./coverage";

/** Homework checks a subject needs before its homework percentage is used. */
export const MIN_HOMEWORK_CHECKS = 3;

export type PaperMark = {
  /** The exam's place in the year (exams.sort_order, then created_at): smaller is earlier. */
  examOrder: number;
  maxMarks: number;
  /** Marks in tenths (18.5 → 185); null when not entered. */
  tenths: number | null;
  absent: boolean;
};

/** Test scores as percentages with one decimal, oldest first (absent and not-entered marks are left out). */
export function testPercents(marks: PaperMark[]): number[] {
  return [...marks]
    .sort((a, b) => a.examOrder - b.examOrder)
    .filter((m) => !m.absent && m.tenths !== null && m.maxMarks > 0)
    .map((m) => Math.min(100, percentTenths(m.tenths!, m.maxMarks) / 10));
}

/** One subject's homework percentage, or null with fewer than MIN_HOMEWORK_CHECKS checked. */
export function subjectHomework(h: HomeworkFigure | undefined): number | null {
  return h ? homeworkPercent(h, MIN_HOMEWORK_CHECKS) : null;
}

/** Whole-day attendance percentage, or null with fewer than MIN_ATTENDANCE_DAYS register days. */
export function attendanceInput(a: AttendanceFigure): number | null {
  return attendancePercent(a, MIN_ATTENDANCE_DAYS);
}

/**
 * One student's inputs: a subject is included when it has test scores or a
 * homework percentage (a subject with neither tells Stud-AI nothing).
 */
export function studentInputs(
  subjects: { id: string; name: string }[],
  marks: Map<string, PaperMark[]>,
  homework: Map<string, HomeworkFigure>,
  attendance: AttendanceFigure,
): SubjectInput[] {
  const att = attendanceInput(attendance);
  const out: SubjectInput[] = [];
  for (const s of subjects) {
    const tests = testPercents(marks.get(s.id) ?? []).slice(-5);
    const hw = subjectHomework(homework.get(s.id));
    if (!tests.length && hw === null) continue;
    out.push({ key: s.id, name: s.name, tests, attendance: att, homework: hw });
  }
  return out;
}

/** True when at least one subject has a test score, so Stud-AI can estimate something. */
export const canEstimate = (inputs: SubjectInput[]) => inputs.some((s) => s.tests.length > 0);

/**
 * A fingerprint of everything an estimate depends on: the inputs (subject
 * names included, both as the school writes them and as Stud-AI is told
 * them), the contract and the model file. Estimates are worked out again
 * only when it changes.
 */
export function fingerprint(modelSha: string, inputs: SubjectInput[]): string {
  const canonical = [...inputs]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((s) => [s.key, s.name, studAiName(s.name), s.tests, s.attendance, s.homework]);
  return crypto.createHash("sha256").update(JSON.stringify([CONTRACT, modelSha, canonical])).digest("hex");
}
