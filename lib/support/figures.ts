/**
 * A student's figures from the portal's own records — attendance, homework,
 * exam results and remark counts — as used by the "Needs support" view
 * (lib/support/rules.ts) and the report-card remarks page. Read from the
 * database by lib/queries/student-figures.ts.
 *
 * Pure types and arithmetic only (no database, no "server-only"), so the
 * unit tests can check them.
 */
import type { RemarkCategory } from "@/lib/services/remarks";

export type AttendanceFigure = { days: number; present: number; late: number; absent: number; leave: number };
export type HomeworkFigure = { done: number; late: number; notDone: number; excused: number };

export type SubjectFigure = {
  subjectId: string;
  name: string;
  maxMarks: number;
  /** Tenths of a percent (74.5% → 745); null when absent or not entered. */
  percent: number | null;
  absent: boolean;
  /** Below the school's pass mark, by the exact check the results and report cards use (not the rounded percentage). */
  belowPass?: boolean;
};

export type ExamFigure = {
  examId: string;
  name: string;
  sortOrder: number;
  /** Overall percentage in tenths; null without marks. */
  percent: number | null;
  subjects: SubjectFigure[];
};

export type RemarkFigure = {
  /** This session. */
  appreciations: number;
  concerns: number;
  appreciationAreas: RemarkCategory[];
  concernAreas: RemarkCategory[];
  /** In the concern window (the last 7 days by default: the school's "Needs support" rule). */
  concernsRecent: number;
};

export type StudentFigures = {
  studentId: string;
  /** As on the record: "M", "F", "O" or null. */
  gender: string | null;
  /** This session so far. */
  attendance: AttendanceFigure;
  /** The last 30 days (for trends). */
  attendanceRecent: AttendanceFigure;
  /** This session so far. */
  homework: HomeworkFigure;
  /** This session's exams in which the student has marks, in exam order. */
  exams: ExamFigure[];
  remarks: RemarkFigure;
};

export const emptyAttendance = (): AttendanceFigure => ({ days: 0, present: 0, late: 0, absent: 0, leave: 0 });
export const emptyHomework = (): HomeworkFigure => ({ done: 0, late: 0, notDone: 0, excused: 0 });
export const emptyRemarks = (): RemarkFigure => ({ appreciations: 0, concerns: 0, appreciationAreas: [], concernAreas: [], concernsRecent: 0 });

/** Fewest register days before an attendance percentage is used (fewer: not enough to go on). */
export const MIN_ATTENDANCE_DAYS = 10;

/** 92.34 → 92.3 */
export const round1 = (n: number) => Math.round(n * 10) / 10;

/** (present + late) ÷ days taken, one decimal; null with fewer than MIN_ATTENDANCE_DAYS days. */
export function attendancePercent(a: AttendanceFigure, minDays = MIN_ATTENDANCE_DAYS): number | null {
  return a.days >= minDays && a.days > 0 ? round1(((a.present + a.late) / a.days) * 100) : null;
}

/** Homework checked: done, late and not done (excused doesn't count). */
export const homeworkChecked = (h: HomeworkFigure) => h.done + h.late + h.notDone;

/** (done + late) ÷ (done + late + not done), one decimal; null when nothing was checked (or fewer than `minChecked`). */
export function homeworkPercent(h: HomeworkFigure, minChecked = 1): number | null {
  const n = homeworkChecked(h);
  return n >= Math.max(1, minChecked) ? round1(((h.done + h.late) / n) * 100) : null;
}

/** 74 → "74%", 74.5 → "74.5%". */
export function pct(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

/** The exam whose subject marks count: the latest one (in exam order) with any subject mark. */
export function latestExam(exams: ExamFigure[]): ExamFigure | null {
  for (let i = exams.length - 1; i >= 0; i--) if (exams[i].subjects.some((s) => s.percent !== null)) return exams[i];
  return null;
}

/**
 * Each subject's most recent exam result: for every subject, the latest exam
 * (in exam order) in which the student has a mark or was marked absent in it.
 * A later exam that doesn't have that subject, or whose marks for it aren't
 * entered yet, doesn't hide an earlier result.
 */
export function latestSubjectResults(exams: ExamFigure[]): { exam: ExamFigure; subject: SubjectFigure }[] {
  const seen = new Set<string>();
  const out: { exam: ExamFigure; subject: SubjectFigure }[] = [];
  for (let i = exams.length - 1; i >= 0; i--) {
    for (const s of exams[i].subjects) {
      if (seen.has(s.subjectId) || (s.percent === null && !s.absent)) continue;
      seen.add(s.subjectId);
      out.push({ exam: exams[i], subject: s });
    }
  }
  return out;
}

/** Points an overall percentage must move between exams to count as "improving" or "declining". */
export const TREND_POINTS = 5;

/**
 * The portal's trend rule: the overall percentage in an exam against the
 * exam before it (in exam order) with results — up by TREND_POINTS or more
 * is "improving", down by as much "declining", otherwise "steady"; null
 * without two exams to compare.
 */
export function examTrend(exams: ExamFigure[], examId?: string): { trend: "improving" | "steady" | "declining"; current: ExamFigure; previous: ExamFigure } | null {
  const idx = examId ? exams.findIndex((e) => e.examId === examId) : exams.length - 1;
  const current = idx >= 0 ? exams[idx] : null;
  if (!current || current.percent === null) return null;
  let previous: ExamFigure | null = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (exams[i].percent !== null) {
      previous = exams[i];
      break;
    }
  }
  if (!previous || previous.percent === null) return null;
  const diff = (current.percent - previous.percent) / 10;
  return { trend: diff >= TREND_POINTS ? "improving" : diff <= -TREND_POINTS ? "declining" : "steady", current, previous };
}

export const REMARK_AREA_WORDS: Record<RemarkCategory, string> = {
  studies: "studies",
  homework: "homework",
  behaviour: "behaviour",
  attendance: "attendance and punctuality",
  participation: "participation and activities",
  other: "other",
};
