/**
 * Each student's figures for one section — attendance, homework, exam
 * results and remark counts this session — for the "Needs support" view and
 * the report-card remarks page. A handful of grouped queries for the whole
 * section, whatever its size.
 *
 * Callers check first that the person may see the section (class teacher or
 * admin: lib/page.ts, canManageSection). Remark counts go through the same
 * RemarkReader rules as the Remarks pages (lib/services/remarks.ts).
 */
import "server-only";
import { and, asc, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { attendance, attendanceRegisters, examPapers, exams, homework, homeworkChecks, marks, remarks, schools, sections, subjects } from "@/lib/db/schema";
import { addDays, isValidIsoDate } from "@/lib/dates";
import { computeResult, tenthsFromDb, type MarkValue } from "@/components/exams/rules";
import { sessionBounds } from "@/lib/services/attendance";
import { isRemarkCategory, remarkReaderCondition, type RemarkCategory, type RemarkReader } from "@/lib/services/remarks";
import { sectionStudents } from "@/lib/queries/school";
import { emptyAttendance, emptyHomework, emptyRemarks, type ExamFigure, type StudentFigures } from "@/lib/support/figures";
import { DEFAULT_SUPPORT_RULE, SUPPORT_INFO, resolveSupportRule, type SupportRule, type Thresholds } from "@/lib/support/rules";

/** A checked YYYY-MM-DD date as an SQL literal. */
function dateLiteral(iso: string) {
  if (!isValidIsoDate(iso)) throw new Error(`Not a date: ${iso}`);
  return sql.raw(`'${iso}'::date`);
}

/** The school's pass mark and attendance warning level (Settings), with the usual defaults. */
export async function schoolThresholds(schoolId: string): Promise<Thresholds> {
  const db = await getDb();
  const [s] = await db.select({ settings: schools.settings }).from(schools).where(eq(schools.id, schoolId));
  const pass = Number(s?.settings?.passPercent);
  const warn = Number(s?.settings?.attendanceWarnPercent);
  return { passPercent: Number.isFinite(pass) && pass > 0 ? pass : 33, attendanceWarnPercent: Number.isFinite(warn) && warn > 0 ? warn : 75 };
}

/** The school's "Needs support" rule (Settings), with the defaults for anything not set. */
export async function schoolSupportRule(schoolId: string): Promise<SupportRule> {
  const db = await getDb();
  const [s] = await db.select({ settings: schools.settings }).from(schools).where(eq(schools.id, schoolId));
  return resolveSupportRule(s?.settings?.support);
}

export type FigureStudent = { id: string; name: string; srNo: string; rollNo: number | null; gender: string | null };

/**
 * The section's current students (roll order) and each one's figures.
 * `studentIds` narrows it to some of them (others are ignored).
 */
export async function sectionFigures(
  scope: { schoolId: string; sessionId: string },
  section: { id: string; classId: string },
  opts: { today: string; reader: RemarkReader; passPercent: number; studentIds?: string[]; concernDays?: number },
): Promise<{ students: FigureStudent[]; figures: Map<string, StudentFigures> }> {
  const roll = await sectionStudents(section.id);
  const students = opts.studentIds ? roll.filter((s) => opts.studentIds!.includes(s.id)) : roll;
  const figures = new Map<string, StudentFigures>();
  for (const s of students) {
    figures.set(s.id, {
      studentId: s.id,
      gender: s.gender,
      attendance: emptyAttendance(),
      attendanceRecent: emptyAttendance(),
      homework: emptyHomework(),
      exams: [],
      remarks: emptyRemarks(),
    });
  }
  if (!students.length) return { students, figures };

  const ids = students.map((s) => s.id);
  const db = await getDb();
  const b = await sessionBounds(scope.sessionId);
  const end = opts.today < b.endsOn ? opts.today : b.endsOn;
  // Concerns are counted over the school's window (7 days by default); "recent" attendance, for the trend, is the last 30 days.
  const since = addDays(opts.today, -((opts.concernDays ?? DEFAULT_SUPPORT_RULE.concernDays) - 1));
  const attendanceSince = addDays(opts.today, -(SUPPORT_INFO.attendanceTrendDays - 1));

  // The same text in SELECT and GROUP BY (a bound parameter would differ between the two): dates are checked, then written as literals.
  const recentAtt = sql<boolean>`(${attendance.date} >= ${dateLiteral(attendanceSince)})`;
  const inSessionRemark = sql<boolean>`(${remarks.recordedOn} >= ${dateLiteral(b.startsOn)})`;
  const recentRemark = sql<boolean>`(${remarks.recordedOn} >= ${dateLiteral(since)})`;

  const [attRows, hwRows, examRows, remarkRows] = await Promise.all([
    // Marks that count: the section's register was taken that day.
    db
      .select({ studentId: attendance.studentId, status: attendance.status, recent: recentAtt, n: count() })
      .from(attendance)
      .innerJoin(attendanceRegisters, and(eq(attendanceRegisters.sectionId, attendance.sectionId), eq(attendanceRegisters.date, attendance.date)))
      .where(and(inArray(attendance.studentId, ids), gte(attendance.date, b.startsOn), lte(attendance.date, end)))
      .groupBy(attendance.studentId, attendance.status, recentAtt),
    db
      .select({ studentId: homeworkChecks.studentId, status: homeworkChecks.status, n: count() })
      .from(homeworkChecks)
      .innerJoin(homework, eq(homework.id, homeworkChecks.homeworkId))
      .innerJoin(sections, eq(sections.id, homework.sectionId))
      .where(and(inArray(homeworkChecks.studentId, ids), eq(sections.sessionId, scope.sessionId)))
      .groupBy(homeworkChecks.studentId, homeworkChecks.status),
    db
      .select({ id: exams.id, name: exams.name, sortOrder: exams.sortOrder })
      .from(exams)
      .where(and(eq(exams.schoolId, scope.schoolId), eq(exams.sessionId, scope.sessionId)))
      .orderBy(asc(exams.sortOrder), asc(exams.createdAt)),
    db
      .select({ studentId: remarks.studentId, kind: remarks.kind, category: remarks.category, inSession: inSessionRemark, recent: recentRemark, n: count() })
      .from(remarks)
      .where(
        and(
          eq(remarks.schoolId, scope.schoolId),
          inArray(remarks.studentId, ids),
          gte(remarks.recordedOn, since < b.startsOn ? since : b.startsOn),
          lte(remarks.recordedOn, opts.today),
          remarkReaderCondition(db, opts.reader),
        ),
      )
      .groupBy(remarks.studentId, remarks.kind, remarks.category, inSessionRemark, recentRemark),
  ]);

  for (const r of attRows) {
    const f = figures.get(r.studentId);
    if (!f) continue;
    const n = Number(r.n);
    for (const a of r.recent ? [f.attendance, f.attendanceRecent] : [f.attendance]) {
      a[r.status] += n;
      a.days += n;
    }
  }

  for (const r of hwRows) {
    const f = figures.get(r.studentId);
    if (!f) continue;
    const n = Number(r.n);
    if (r.status === "done") f.homework.done += n;
    else if (r.status === "late") f.homework.late += n;
    else if (r.status === "not_done") f.homework.notDone += n;
    else f.homework.excused += n;
  }

  for (const r of remarkRows) {
    const f = figures.get(r.studentId);
    if (!f) continue;
    const n = Number(r.n);
    const category: RemarkCategory = isRemarkCategory(r.category) ? r.category : "other";
    if (r.inSession) {
      if (r.kind === "appreciation") {
        f.remarks.appreciations += n;
        if (!f.remarks.appreciationAreas.includes(category)) f.remarks.appreciationAreas.push(category);
      } else {
        f.remarks.concerns += n;
        if (!f.remarks.concernAreas.includes(category)) f.remarks.concernAreas.push(category);
      }
    }
    if (r.recent && r.kind === "concern") f.remarks.concernsRecent += n;
  }

  // Exams: this class's papers, the students' marks, and each student's result per exam.
  if (examRows.length) {
    const examIds = examRows.map((e) => e.id);
    const [paperRows, markRows] = await Promise.all([
      db
        .select({ examId: examPapers.examId, subjectId: examPapers.subjectId, name: subjects.name, maxMarks: examPapers.maxMarks })
        .from(examPapers)
        .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
        .where(and(inArray(examPapers.examId, examIds), eq(examPapers.classId, section.classId)))
        .orderBy(asc(subjects.sortOrder), asc(subjects.name)),
      db
        .select({ examId: marks.examId, studentId: marks.studentId, subjectId: marks.subjectId, marks: marks.marks, absent: marks.absent })
        .from(marks)
        .where(and(inArray(marks.examId, examIds), inArray(marks.studentId, ids))),
    ]);
    const byStudentExam = new Map<string, Map<string, MarkValue>>();
    for (const m of markRows) {
      const key = `${m.studentId}:${m.examId}`;
      const map = byStudentExam.get(key) ?? new Map<string, MarkValue>();
      map.set(m.subjectId, { tenths: m.absent ? null : tenthsFromDb(m.marks), absent: m.absent });
      byStudentExam.set(key, map);
    }
    for (const e of examRows) {
      const papers = paperRows.filter((p) => p.examId === e.id).map((p) => ({ subjectId: p.subjectId, name: p.name, maxMarks: p.maxMarks }));
      if (!papers.length) continue;
      for (const s of students) {
        const m = byStudentExam.get(`${s.id}:${e.id}`);
        if (!m?.size) continue;
        const result = computeResult(papers, m, opts.passPercent);
        const exam: ExamFigure = {
          examId: e.id,
          name: e.name,
          sortOrder: e.sortOrder,
          percent: result.percent,
          subjects: result.lines.map((l) => ({
            subjectId: l.subjectId,
            name: l.name,
            maxMarks: l.maxMarks,
            percent: l.percent,
            absent: l.outcome === "absent",
            belowPass: l.outcome === "below",
          })),
        };
        if (exam.subjects.some((x) => x.percent !== null || x.absent)) figures.get(s.id)!.exams.push(exam);
      }
    }
  }

  return { students, figures };
}
