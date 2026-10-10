/**
 * Exams, marks and results.
 *
 * An exam ("Unit Test 1", "Half-yearly") belongs to a school and session. Its
 * papers say which subjects are examined in each class and out of how many
 * marks. Teachers enter marks per (section, subject); the class teacher sends
 * the section's results to the office, which publishes them to families.
 * Published results are locked until an admin reopens them with a reason.
 *
 *   open  ──send to office──▶  submitted  ──publish──▶  published
 *     ▲                                                    │
 *     └──────────────── reopen (reason, audited) ──────────┘
 *
 * Writes take a transaction and an AuditActor and write an audit entry in the
 * same transaction. They check that every ID belongs to the given school and
 * session, but not WHO is asking: pages and actions do that first
 * (lib/page.ts, lib/auth/dal.ts). Reads use the shared connection.
 *
 * Nothing here imports "server-only" code, so scripts and tests can use it.
 */
import { and, asc, count, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import {
  academicSessions,
  accounts,
  attendance,
  attendanceRegisters,
  auditLog,
  classSubjects,
  classes,
  enrolments,
  examPapers,
  examResults,
  exams,
  marks,
  reportRemarks,
  schools,
  sections,
  staff,
  students,
  subjects,
  teachingAssignments,
} from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { classLabel, sectionLabel } from "@/lib/classes";
import {
  MAX_PAPER_MARKS,
  averagePercent,
  computeResult,
  formatMarks,
  tenthsFromDb,
  tenthsToDb,
  type MarkValue,
  type OverallOutcome,
  type StudentResult,
} from "@/components/exams/rules";
import { queueResults, withdrawResults, type SimpleSmsResult } from "@/lib/sms/outbox";
import { reportRemarksFor } from "./report-remarks";
import { RecordError } from "./students";

export { RecordError };

export type ResultStatus = "open" | "submitted" | "published";
type Scope = { schoolId: string; sessionId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** IDs from URLs and forms are checked before they reach a uuid column. */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Audit target for an exam's results in one section. */
const resultTarget = (examId: string, sectionId: string) => `${examId}:${sectionId}`;

/** Only marks that count as "done": a number, or absent. */
const markDone = or(eq(marks.absent, true), isNotNull(marks.marks));

/* ------------------------------------------------------------------ */
/* Scope checks                                                        */
/* ------------------------------------------------------------------ */

export type ExamRow = typeof exams.$inferSelect;

async function examInScope(tx: Tx, scope: Scope, examId: string): Promise<ExamRow> {
  if (!isUuid(examId)) throw new RecordError("That exam was not found. Reload the page and try again.");
  const [x] = await tx
    .select()
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.schoolId, scope.schoolId), eq(exams.sessionId, scope.sessionId)));
  if (!x) throw new RecordError("That exam was not found. Reload the page and try again.");
  return x;
}

export type SectionMeta = {
  id: string;
  name: string;
  classId: string;
  className: string;
  stream: string | null;
  classOrder: number;
  schoolId: string;
  sessionId: string;
  classTeacherId: string | null;
  label: string;
};

async function sectionInScope(tx: Tx, scope: Scope, sectionId: string): Promise<SectionMeta> {
  const s = isUuid(sectionId) ? await sectionMetaTx(tx, sectionId) : null;
  if (!s || s.schoolId !== scope.schoolId || s.sessionId !== scope.sessionId) throw new RecordError("That class section was not found. Reload the page and try again.");
  return s;
}

async function sectionMetaTx(tx: Tx, sectionId: string): Promise<SectionMeta | null> {
  const [r] = await tx
    .select({
      id: sections.id,
      name: sections.name,
      classId: classes.id,
      className: classes.name,
      stream: classes.stream,
      classOrder: classes.sortOrder,
      schoolId: classes.schoolId,
      sessionId: sections.sessionId,
      classTeacherId: sections.classTeacherId,
    })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(eq(sections.id, sectionId));
  return r ? { ...r, label: sectionLabel(r.className, r.name) } : null;
}

/** A section with its class (null if the ID is not a section). */
export async function sectionMeta(sectionId: string): Promise<SectionMeta | null> {
  if (!isUuid(sectionId)) return null;
  return sectionMetaTx(await getDb(), sectionId);
}

/** Active students enrolled in a section this session, by roll number then name. */
async function rosterTx(tx: Tx, sessionId: string, sectionIds: string[]) {
  if (!sectionIds.length) return [];
  return tx
    .select({
      id: students.id,
      sectionId: enrolments.sectionId,
      name: students.name,
      srNo: students.srNo,
      rollNo: enrolments.rollNo,
      fatherName: students.fatherName,
      motherName: students.motherName,
    })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(and(inArray(enrolments.sectionId, sectionIds), eq(enrolments.sessionId, sessionId), eq(students.status, "active")))
    .orderBy(asc(enrolments.rollNo), asc(students.name));
}

export type RosterStudent = Awaited<ReturnType<typeof rosterTx>>[number];

/** Make sure the section's result row exists and lock it for this transaction. */
async function lockResult(tx: Tx, examId: string, sectionId: string) {
  await tx.insert(examResults).values({ examId, sectionId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(examResults)
    .where(and(eq(examResults.examId, examId), eq(examResults.sectionId, sectionId)))
    .for("update");
  return row;
}

/* ------------------------------------------------------------------ */
/* Exams                                                               */
/* ------------------------------------------------------------------ */

export type ExamInput = { name: string; sortOrder: number };

/** A problem with one box of the exam form (its name or its order), so the page can show it next to that box. */
export class ExamFieldError extends RecordError {
  constructor(
    readonly field: "name" | "order",
    message: string,
  ) {
    super(message);
  }
}

function checkExamInput(input: ExamInput) {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 60) throw new ExamFieldError("name", "Give the exam a name of 2 to 60 characters, such as “Unit Test 1”.");
  if (!Number.isInteger(input.sortOrder) || input.sortOrder < 1 || input.sortOrder > 99) throw new ExamFieldError("order", "The order must be a whole number from 1 to 99.");
  return { name, sortOrder: input.sortOrder };
}

async function assertNameFree(tx: Tx, scope: Scope, name: string, exceptId?: string) {
  const [dupe] = await tx
    .select({ id: exams.id })
    .from(exams)
    .where(
      and(
        eq(exams.schoolId, scope.schoolId),
        eq(exams.sessionId, scope.sessionId),
        sql`lower(${exams.name}) = ${name.toLowerCase()}`,
        exceptId ? ne(exams.id, exceptId) : undefined,
      ),
    );
  if (dupe) throw new ExamFieldError("name", `There is already an exam called “${name}” this session. Choose another name.`);
}

export async function createExam(tx: Tx, scope: Scope, input: ExamInput, actor: AuditActor): Promise<{ id: string }> {
  const clean = checkExamInput(input);
  await assertNameFree(tx, scope, clean.name);
  const [x] = await tx
    .insert(exams)
    .values({ schoolId: scope.schoolId, sessionId: scope.sessionId, ...clean })
    .returning({ id: exams.id });
  await audit(tx, actor, "exam.created", { schoolId: scope.schoolId, targetType: "exam", targetId: x.id, details: clean });
  return x;
}

export async function updateExam(tx: Tx, scope: Scope, examId: string, input: ExamInput, actor: AuditActor): Promise<void> {
  const cur = await examInScope(tx, scope, examId);
  const clean = checkExamInput(input);
  if (cur.name === clean.name && cur.sortOrder === clean.sortOrder) return;
  await assertNameFree(tx, scope, clean.name, examId);
  await tx.update(exams).set(clean).where(eq(exams.id, examId));
  await audit(tx, actor, "exam.updated", {
    schoolId: scope.schoolId,
    targetType: "exam",
    targetId: examId,
    details: { name: clean.name, sortOrder: clean.sortOrder, previousName: cur.name, previousOrder: cur.sortOrder },
  });
}

/** Delete an exam that has no marks or report-card remarks yet (its papers and result rows go with it). */
export async function deleteExam(tx: Tx, scope: Scope, examId: string, actor: AuditActor): Promise<void> {
  const cur = await examInScope(tx, scope, examId);
  const [{ n }] = await tx.select({ n: count() }).from(marks).where(eq(marks.examId, examId));
  if (Number(n) > 0) throw new RecordError(`“${cur.name}” already has marks, so it can't be deleted.`);
  const [{ remarks }] = await tx.select({ remarks: count() }).from(reportRemarks).where(eq(reportRemarks.examId, examId));
  if (Number(remarks) > 0) throw new RecordError(`“${cur.name}” already has report-card remarks written by class teachers, so it can't be deleted.`);
  await tx.delete(examResults).where(eq(examResults.examId, examId));
  await tx.delete(examPapers).where(eq(examPapers.examId, examId));
  await tx.delete(exams).where(eq(exams.id, examId));
  await audit(tx, actor, "exam.deleted", { schoolId: scope.schoolId, targetType: "exam", targetId: examId, details: { name: cur.name } });
}

/* ------------------------------------------------------------------ */
/* Papers (maximum marks per class and subject)                        */
/* ------------------------------------------------------------------ */

/**
 * Set the papers of one class: subject → maximum marks, or null for "not
 * examined". Subjects not mentioned are left as they are. Refused while any
 * section of the class has published results, when a maximum would fall below
 * marks already entered, or when a paper with marks would be removed.
 */
export async function setClassPapers(
  tx: Tx,
  scope: Scope,
  examId: string,
  classId: string,
  maxBySubject: Record<string, number | null>,
  actor: AuditActor,
): Promise<{ changed: number }> {
  const exam = await examInScope(tx, scope, examId);
  const [cls] = isUuid(classId)
    ? await tx
        .select()
        .from(classes)
        .where(and(eq(classes.id, classId), eq(classes.schoolId, scope.schoolId)))
    : [];
  if (!cls) throw new RecordError("That class was not found. Reload the page and try again.");
  const clsName = classLabel(cls.name, cls.stream);

  const [taught, current] = await Promise.all([
    tx
      .select({ subjectId: classSubjects.subjectId, name: subjects.name })
      .from(classSubjects)
      .innerJoin(subjects, eq(subjects.id, classSubjects.subjectId))
      .where(eq(classSubjects.classId, classId)),
    tx
      .select({ subjectId: examPapers.subjectId, maxMarks: examPapers.maxMarks, name: subjects.name })
      .from(examPapers)
      .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
      .where(and(eq(examPapers.examId, examId), eq(examPapers.classId, classId))),
  ]);
  const names = new Map([...taught, ...current].map((s) => [s.subjectId, s.name]));
  const curMax = new Map(current.map((p) => [p.subjectId, p.maxMarks]));

  const changes: { subjectId: string; subject: string; from: number | null; to: number | null }[] = [];
  for (const [subjectId, max] of Object.entries(maxBySubject)) {
    if (!names.has(subjectId)) throw new RecordError("One of the subjects is not taught in this class. Reload the page and try again.");
    if (max !== null && (!Number.isInteger(max) || max < 1 || max > MAX_PAPER_MARKS)) {
      throw new RecordError(`${names.get(subjectId)}: the maximum must be a whole number from 1 to ${MAX_PAPER_MARKS}.`);
    }
    const from = curMax.get(subjectId) ?? null;
    if (from !== max) changes.push({ subjectId, subject: names.get(subjectId)!, from, to: max });
  }
  if (!changes.length) return { changed: 0 };

  // Locked while results of any section of this class are published.
  const published = await tx
    .select({ name: sections.name })
    .from(examResults)
    .innerJoin(sections, eq(sections.id, examResults.sectionId))
    .where(and(eq(examResults.examId, examId), eq(examResults.status, "published"), eq(sections.classId, classId), eq(sections.sessionId, scope.sessionId)));
  if (published.length) {
    const which = published.map((p) => sectionLabel(cls.name, p.name)).join(", ");
    throw new RecordError(`Results for ${which} are published, so the papers of ${clsName} are locked. Reopen those results first.`);
  }

  // Highest mark already entered per subject (students of this class this session).
  const entered = await tx
    .select({ subjectId: marks.subjectId, top: sql<string | null>`max(${marks.marks})`, n: count() })
    .from(marks)
    .innerJoin(enrolments, and(eq(enrolments.studentId, marks.studentId), eq(enrolments.sessionId, scope.sessionId)))
    .innerJoin(sections, eq(sections.id, enrolments.sectionId))
    .where(
      and(
        eq(marks.examId, examId),
        eq(sections.classId, classId),
        inArray(
          marks.subjectId,
          changes.map((c) => c.subjectId),
        ),
        markDone,
      ),
    )
    .groupBy(marks.subjectId);
  const enteredBy = new Map(entered.map((e) => [e.subjectId, { top: tenthsFromDb(e.top), n: Number(e.n) }]));
  for (const c of changes) {
    const e = enteredBy.get(c.subjectId);
    if (!e || !e.n) continue;
    if (c.to === null) throw new RecordError(`${c.subject}: marks have already been entered in ${clsName}, so this paper can't be removed. Clear those marks first.`);
    if (e.top !== null && e.top > c.to * 10) {
      throw new RecordError(
        `${c.subject}: a student in ${clsName} already has ${formatMarks(e.top)} marks, more than ${c.to}. Correct those marks first, or choose a higher maximum.`,
      );
    }
  }

  const removed = changes.filter((c) => c.to === null).map((c) => c.subjectId);
  if (removed.length) await tx.delete(examPapers).where(and(eq(examPapers.examId, examId), eq(examPapers.classId, classId), inArray(examPapers.subjectId, removed)));
  const upserts = changes.filter((c) => c.to !== null).map((c) => ({ examId, classId, subjectId: c.subjectId, maxMarks: c.to! }));
  if (upserts.length) {
    await tx
      .insert(examPapers)
      .values(upserts)
      .onConflictDoUpdate({ target: [examPapers.examId, examPapers.classId, examPapers.subjectId], set: { maxMarks: sql`excluded.max_marks` } });
  }
  await audit(tx, actor, "exam.papers_set", {
    schoolId: scope.schoolId,
    targetType: "exam",
    targetId: examId,
    details: { exam: exam.name, classId, className: cls.name, changes: changes.map(({ subject, from, to }) => ({ subject, from, to })) },
  });
  return { changed: changes.length };
}

/* ------------------------------------------------------------------ */
/* Marks                                                               */
/* ------------------------------------------------------------------ */

/** One student's marks as the teacher left them: tenths, absent, or neither (clear). */
export type MarkEntry = { studentId: string; tenths: number | null; absent: boolean };

export type SaveMarksResult = { changed: number; cleared: number; students: number; done: number };

/**
 * Save marks for one section and subject. Only rows that differ from what is
 * stored are written; a row with neither marks nor "absent" clears the entry.
 */
export async function saveMarks(
  tx: Tx,
  scope: Scope,
  ids: { examId: string; sectionId: string; subjectId: string },
  entries: MarkEntry[],
  actor: AuditActor,
): Promise<SaveMarksResult> {
  const exam = await examInScope(tx, scope, ids.examId);
  const sec = await sectionInScope(tx, scope, ids.sectionId);
  const [paper] = isUuid(ids.subjectId)
    ? await tx
        .select({ maxMarks: examPapers.maxMarks, subject: subjects.name })
        .from(examPapers)
        .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
        .where(and(eq(examPapers.examId, exam.id), eq(examPapers.classId, sec.classId), eq(examPapers.subjectId, ids.subjectId)))
    : [];
  if (!paper) throw new RecordError(`This subject has no paper in ${exam.name} for ${classLabel(sec.className, sec.stream)}. Ask the office to set the maximum marks first.`);

  const result = await lockResult(tx, exam.id, sec.id);
  if (result.status === "published") {
    throw new RecordError(`${exam.name} results for ${sec.label} are published, so marks are locked. Ask the office to reopen them if a correction is needed.`);
  }

  const roster = await rosterTx(tx, scope.sessionId, [sec.id]);
  const inSection = new Set(roster.map((r) => r.id));
  const seen = new Set<string>();
  for (const e of entries) {
    if (!inSection.has(e.studentId) || seen.has(e.studentId)) throw new RecordError("Some rows don't belong to this class any more. Reload the page and try again.");
    seen.add(e.studentId);
    if (e.absent && e.tenths !== null) throw new RecordError("A student marked absent can't also have marks.");
    if (e.tenths !== null && (!Number.isInteger(e.tenths) || e.tenths < 0 || e.tenths % 5 !== 0 || e.tenths > paper.maxMarks * 10)) {
      throw new RecordError(`Marks must be whole or half marks from 0 to ${paper.maxMarks}.`);
    }
  }

  const stored = entries.length
    ? await tx
        .select({ studentId: marks.studentId, marks: marks.marks, absent: marks.absent })
        .from(marks)
        .where(
          and(
            eq(marks.examId, exam.id),
            eq(marks.subjectId, ids.subjectId),
            inArray(
              marks.studentId,
              entries.map((e) => e.studentId),
            ),
          ),
        )
    : [];
  const cur = new Map(stored.map((s) => [s.studentId, { tenths: tenthsFromDb(s.marks), absent: s.absent }]));

  const enteredBy = actor.accountId;
  if (!enteredBy) throw new RecordError("Marks can only be saved by a signed-in person.");
  const toClear: string[] = [];
  const toWrite: (typeof marks.$inferInsert)[] = [];
  const now = new Date();
  for (const e of entries) {
    const c = cur.get(e.studentId);
    if (!e.absent && e.tenths === null) {
      if (c) toClear.push(e.studentId);
      continue;
    }
    if (c && c.absent === e.absent && c.tenths === e.tenths) continue;
    toWrite.push({
      examId: exam.id,
      studentId: e.studentId,
      subjectId: ids.subjectId,
      marks: e.absent || e.tenths === null ? null : tenthsToDb(e.tenths),
      absent: e.absent,
      enteredBy,
      enteredAt: now,
    });
  }

  if (toClear.length) {
    await tx.delete(marks).where(and(eq(marks.examId, exam.id), eq(marks.subjectId, ids.subjectId), inArray(marks.studentId, toClear)));
  }
  if (toWrite.length) {
    await tx
      .insert(marks)
      .values(toWrite)
      .onConflictDoUpdate({
        target: [marks.examId, marks.studentId, marks.subjectId],
        set: { marks: sql`excluded.marks`, absent: sql`excluded.absent`, enteredBy: sql`excluded.entered_by`, enteredAt: sql`excluded.entered_at` },
      });
  }

  const [{ n }] = await tx
    .select({ n: count() })
    .from(marks)
    .where(
      and(
        eq(marks.examId, exam.id),
        eq(marks.subjectId, ids.subjectId),
        inArray(
          marks.studentId,
          roster.map((r) => r.id),
        ),
        markDone,
      ),
    );

  if (toClear.length || toWrite.length) {
    await audit(tx, actor, "marks.saved", {
      schoolId: scope.schoolId,
      targetType: "exam_result",
      targetId: resultTarget(exam.id, sec.id),
      details: {
        exam: exam.name,
        section: sec.label,
        subject: paper.subject,
        subjectId: ids.subjectId,
        written: toWrite.length,
        absent: toWrite.filter((w) => w.absent).length,
        cleared: toClear.length,
      },
    });
  }
  return { changed: toWrite.length, cleared: toClear.length, students: roster.length, done: Number(n) };
}

/* ------------------------------------------------------------------ */
/* Results: send to office, publish, reopen                            */
/* ------------------------------------------------------------------ */

/** How complete a section's marks are for an exam: entries still missing, per subject. */
async function missingBySubject(tx: Tx, scope: Scope, examId: string, sec: SectionMeta) {
  const [papers, roster] = await Promise.all([
    tx
      .select({ subjectId: examPapers.subjectId, name: subjects.name })
      .from(examPapers)
      .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
      .where(and(eq(examPapers.examId, examId), eq(examPapers.classId, sec.classId)))
      .orderBy(asc(subjects.sortOrder), asc(subjects.name)),
    rosterTx(tx, scope.sessionId, [sec.id]),
  ]);
  const doneRows =
    papers.length && roster.length
      ? await tx
          .select({ subjectId: marks.subjectId, n: count() })
          .from(marks)
          .where(
            and(
              eq(marks.examId, examId),
              inArray(
                marks.studentId,
                roster.map((r) => r.id),
              ),
              markDone,
            ),
          )
          .groupBy(marks.subjectId)
      : [];
  const done = new Map(doneRows.map((d) => [d.subjectId, Number(d.n)]));
  const subjectsMissing = papers.map((p) => ({ subject: p.name, missing: roster.length - (done.get(p.subjectId) ?? 0) })).filter((s) => s.missing > 0);
  const entered = papers.reduce((a, p) => a + (done.get(p.subjectId) ?? 0), 0);
  return { papers: papers.length, students: roster.length, entered, missing: subjectsMissing.reduce((a, s) => a + s.missing, 0), subjectsMissing };
}

/** The class teacher sends the section's results to the office. */
export async function submitResults(tx: Tx, scope: Scope, examId: string, sectionId: string, actor: AuditActor) {
  const exam = await examInScope(tx, scope, examId);
  const sec = await sectionInScope(tx, scope, sectionId);
  const row = await lockResult(tx, exam.id, sec.id);
  if (row.status === "published") throw new RecordError(`${exam.name} results for ${sec.label} are already published.`);
  const state = await missingBySubject(tx, scope, exam.id, sec);
  if (!state.papers) throw new RecordError(`${exam.name} has no papers for ${classLabel(sec.className, sec.stream)} yet.`);
  if (row.status !== "submitted") {
    await tx
      .update(examResults)
      .set({ status: "submitted" })
      .where(and(eq(examResults.examId, exam.id), eq(examResults.sectionId, sec.id)));
  }
  await audit(tx, actor, "exam.results_submitted", {
    schoolId: scope.schoolId,
    targetType: "exam_result",
    targetId: resultTarget(exam.id, sec.id),
    details: { exam: exam.name, section: sec.label, missing: state.missing, subjectsMissing: state.subjectsMissing },
  });
  return state;
}

/**
 * Publish a section's results: families can see them and marks are locked.
 * With marks still missing, the caller must pass allowIncomplete (after
 * showing the office a warning). The section's families get a text message
 * saying the results are on the portal (once per exam, see lib/sms/outbox).
 */
export async function publishResults(
  tx: Tx,
  scope: Scope,
  examId: string,
  sectionId: string,
  opts: { allowIncomplete: boolean },
  actor: AuditActor,
): Promise<Awaited<ReturnType<typeof missingBySubject>> & { sms: SimpleSmsResult }> {
  const exam = await examInScope(tx, scope, examId);
  const sec = await sectionInScope(tx, scope, sectionId);
  const row = await lockResult(tx, exam.id, sec.id);
  if (row.status === "published") throw new RecordError(`${exam.name} results for ${sec.label} are already published.`);
  const state = await missingBySubject(tx, scope, exam.id, sec);
  if (!state.papers) throw new RecordError(`${exam.name} has no papers for ${classLabel(sec.className, sec.stream)}, so there is nothing to publish.`);
  if (!state.students) throw new RecordError(`${sec.label} has no students this session, so there is nothing to publish.`);
  if (!state.entered) throw new RecordError(`No marks have been entered for ${sec.label} yet, so there is nothing to publish.`);
  if (state.missing && !opts.allowIncomplete) {
    throw new RecordError(
      `${state.missing} ${state.missing === 1 ? "mark is" : "marks are"} still missing for ${sec.label}. Tick “Publish anyway” to publish with gaps, or wait for the teachers.`,
    );
  }
  if (!actor.accountId) throw new RecordError("Results can only be published by a signed-in person.");
  const publishedAt = new Date();
  await tx
    .update(examResults)
    .set({ status: "published", publishedBy: actor.accountId, publishedAt })
    .where(and(eq(examResults.examId, exam.id), eq(examResults.sectionId, sec.id)));
  await audit(tx, actor, "exam.results_published", {
    schoolId: scope.schoolId,
    targetType: "exam_result",
    targetId: resultTarget(exam.id, sec.id),
    details: { exam: exam.name, section: sec.label, previousStatus: row.status, missing: state.missing, subjectsMissing: state.subjectsMissing },
  });
  const sms = await queueResults(tx, { schoolId: scope.schoolId, examId: exam.id, examName: exam.name, sectionId: sec.id, sectionLabel: sec.label, createdBy: actor.accountId });
  return { ...state, sms };
}

/** Reopen published results (back to "open") so marks can be corrected. A reason is required and kept in the log. */
export async function reopenResults(tx: Tx, scope: Scope, examId: string, sectionId: string, reason: string, actor: AuditActor) {
  const exam = await examInScope(tx, scope, examId);
  const sec = await sectionInScope(tx, scope, sectionId);
  const why = reason.replace(/\s+/g, " ").trim();
  if (why.length < 5) throw new RecordError("Write the reason for reopening (at least 5 characters). It is kept in the activity log.");
  if (why.length > 300) throw new RecordError("Keep the reason under 300 characters.");
  const row = await lockResult(tx, exam.id, sec.id);
  if (row.status !== "published") throw new RecordError(`${exam.name} results for ${sec.label} are not published, so there is nothing to reopen.`);
  await tx
    .update(examResults)
    .set({ status: "open", publishedBy: null, publishedAt: null })
    .where(and(eq(examResults.examId, exam.id), eq(examResults.sectionId, sec.id)));
  await audit(tx, actor, "exam.results_reopened", {
    schoolId: scope.schoolId,
    targetType: "exam_result",
    targetId: resultTarget(exam.id, sec.id),
    details: { exam: exam.name, section: sec.label, reason: why, publishedAt: row.publishedAt?.toISOString() ?? null, publishedBy: row.publishedBy },
  });
  await withdrawResults(tx, { examId: exam.id, sectionId: sec.id });
}

/* ================================================================== */
/* Reads                                                               */
/* ================================================================== */

export async function schoolPassPercent(schoolId: string): Promise<number> {
  const db = await getDb();
  const [s] = await db.select({ settings: schools.settings }).from(schools).where(eq(schools.id, schoolId));
  const p = Number(s?.settings?.passPercent);
  return Number.isFinite(p) && p > 0 ? p : 33;
}

/** The exam, if it belongs to this school and session. */
export async function getExam(scope: Scope, examId: string): Promise<ExamRow | null> {
  if (!isUuid(examId)) return null;
  const db = await getDb();
  const [x] = await db
    .select()
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.schoolId, scope.schoolId), eq(exams.sessionId, scope.sessionId)));
  return x ?? null;
}

export type ExamListRow = ExamRow & {
  classesWithPapers: number;
  sectionsWithPapers: number;
  published: number;
  submitted: number;
  marksCount: number;
};

/** The session's exams in order, with how far each has got. */
export async function listExams(scope: Scope): Promise<ExamListRow[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(exams)
    .where(and(eq(exams.schoolId, scope.schoolId), eq(exams.sessionId, scope.sessionId)))
    .orderBy(asc(exams.sortOrder), asc(exams.createdAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [paperStats, statusStats, markStats] = await Promise.all([
    db
      .select({ examId: examPapers.examId, classes: sql<number>`count(distinct ${examPapers.classId})`, sections: sql<number>`count(distinct ${sections.id})` })
      .from(examPapers)
      .leftJoin(sections, and(eq(sections.classId, examPapers.classId), eq(sections.sessionId, scope.sessionId)))
      .where(inArray(examPapers.examId, ids))
      .groupBy(examPapers.examId),
    db
      .select({ examId: examResults.examId, status: examResults.status, n: count() })
      .from(examResults)
      .where(inArray(examResults.examId, ids))
      .groupBy(examResults.examId, examResults.status),
    db.select({ examId: marks.examId, n: count() }).from(marks).where(inArray(marks.examId, ids)).groupBy(marks.examId),
  ]);
  return rows.map((r) => {
    const p = paperStats.find((s) => s.examId === r.id);
    const st = (status: ResultStatus) => Number(statusStats.find((s) => s.examId === r.id && s.status === status)?.n ?? 0);
    return {
      ...r,
      classesWithPapers: Number(p?.classes ?? 0),
      sectionsWithPapers: Number(p?.sections ?? 0),
      published: st("published"),
      submitted: st("submitted"),
      marksCount: Number(markStats.find((m) => m.examId === r.id)?.n ?? 0),
    };
  });
}

export type Paper = { subjectId: string; name: string; nameHi: string | null; maxMarks: number };

/** All papers of an exam, grouped by class, in subject order. */
export async function examPapersByClass(examId: string): Promise<Map<string, Paper[]>> {
  if (!isUuid(examId)) return new Map();
  const db = await getDb();
  const rows = await db
    .select({ classId: examPapers.classId, subjectId: examPapers.subjectId, name: subjects.name, nameHi: subjects.nameHi, maxMarks: examPapers.maxMarks })
    .from(examPapers)
    .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
    .where(eq(examPapers.examId, examId))
    .orderBy(asc(subjects.sortOrder), asc(subjects.name));
  const out = new Map<string, Paper[]>();
  for (const { classId, ...p } of rows) {
    const list = out.get(classId) ?? [];
    list.push(p);
    out.set(classId, list);
  }
  return out;
}

/** Every class of the school with the subjects taught in it (for the papers form). */
export async function classesWithSubjects(schoolId: string) {
  const db = await getDb();
  const [cls, cs] = await Promise.all([
    db.select().from(classes).where(eq(classes.schoolId, schoolId)).orderBy(asc(classes.sortOrder)),
    db
      .select({ classId: classSubjects.classId, subjectId: subjects.id, name: subjects.name, nameHi: subjects.nameHi })
      .from(classSubjects)
      .innerJoin(subjects, eq(subjects.id, classSubjects.subjectId))
      .where(eq(subjects.schoolId, schoolId))
      .orderBy(asc(subjects.sortOrder), asc(subjects.name)),
  ]);
  return cls.map((c) => ({ ...c, label: classLabel(c.name, c.stream), subjects: cs.filter((s) => s.classId === c.id) }));
}

/** Marks of an exam for some students: student → subject → value. */
async function marksMap(examId: string, studentIds: string[]): Promise<Map<string, Map<string, MarkValue>>> {
  const out = new Map<string, Map<string, MarkValue>>();
  if (!studentIds.length) return out;
  const db = await getDb();
  const rows = await db
    .select({ studentId: marks.studentId, subjectId: marks.subjectId, marks: marks.marks, absent: marks.absent })
    .from(marks)
    .where(and(eq(marks.examId, examId), inArray(marks.studentId, studentIds)));
  for (const r of rows) {
    const m = out.get(r.studentId) ?? new Map<string, MarkValue>();
    m.set(r.subjectId, { tenths: r.absent ? null : tenthsFromDb(r.marks), absent: r.absent });
    out.set(r.studentId, m);
  }
  return out;
}

/** Display names for accounts (staff name, or the account's display name, or its login). */
export async function accountNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const db = await getDb();
  const rows = await db
    .select({ id: accounts.id, staffName: staff.name, displayName: accounts.displayName, loginId: accounts.loginId })
    .from(accounts)
    .leftJoin(staff, eq(staff.id, accounts.staffId))
    .where(inArray(accounts.id, list));
  return new Map(rows.map((r) => [r.id, r.staffName ?? r.displayName ?? r.loginId]));
}

export type ResultState = { status: ResultStatus; publishedAt: Date | null; publishedBy: string | null; publishedById: string | null };

/** Status of an exam's results in some sections ("open" when nothing is recorded yet). */
export async function resultStates(examId: string, sectionIds: string[]): Promise<Map<string, ResultState>> {
  const out = new Map<string, ResultState>();
  if (!sectionIds.length) return out;
  const db = await getDb();
  const rows = await db
    .select()
    .from(examResults)
    .where(and(eq(examResults.examId, examId), inArray(examResults.sectionId, sectionIds)));
  const names = await accountNames(rows.map((r) => r.publishedBy));
  for (const id of sectionIds) {
    const r = rows.find((x) => x.sectionId === id);
    out.set(id, {
      status: r?.status ?? "open",
      publishedAt: r?.publishedAt ?? null,
      publishedById: r?.publishedBy ?? null,
      publishedBy: r?.publishedBy ? (names.get(r.publishedBy) ?? null) : null,
    });
  }
  return out;
}

export type ResultEvent = { action: "submitted" | "published" | "reopened"; at: Date; by: string; reason: string | null };

/** The latest send / publish / reopen events per section, from the activity log. */
export async function resultEvents(schoolId: string, examId: string): Promise<Map<string, { submitted?: ResultEvent; reopened?: ResultEvent }>> {
  const db = await getDb();
  const rows = await db
    .select({ action: auditLog.action, at: auditLog.at, targetId: auditLog.targetId, actorId: auditLog.actorId, actorLogin: auditLog.actorLogin, details: auditLog.details })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.schoolId, schoolId),
        eq(auditLog.targetType, "exam_result"),
        inArray(auditLog.action, ["exam.results_submitted", "exam.results_reopened"]),
        sql`${auditLog.targetId} like ${`${examId}:%`}`,
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id));
  const names = await accountNames(rows.map((r) => r.actorId));
  const out = new Map<string, { submitted?: ResultEvent; reopened?: ResultEvent }>();
  for (const r of rows) {
    const sectionId = r.targetId?.split(":")[1];
    if (!sectionId) continue;
    const entry = out.get(sectionId) ?? {};
    const by = (r.actorId && names.get(r.actorId)) || r.actorLogin || "someone";
    const reason = typeof r.details?.reason === "string" ? r.details.reason : null;
    if (r.action === "exam.results_submitted" && !entry.submitted) entry.submitted = { action: "submitted", at: r.at, by, reason: null };
    if (r.action === "exam.results_reopened" && !entry.reopened) entry.reopened = { action: "reopened", at: r.at, by, reason };
    out.set(sectionId, entry);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* One exam across the school (office)                                 */
/* ------------------------------------------------------------------ */

export type SubjectProgress = {
  subjectId: string;
  name: string;
  maxMarks: number;
  teacherName: string | null;
  entered: number;
  absent: number;
  missing: number;
};

export type SectionOverview = {
  sectionId: string;
  label: string;
  classId: string;
  className: string;
  stream: string | null;
  classTeacherName: string | null;
  students: number;
  papers: Paper[];
  subjects: SubjectProgress[];
  expected: number;
  done: number;
  missing: number;
  state: ResultState;
  /** Class average of students' overall percentages (tenths); null when nothing is entered. */
  averagePercent: number | null;
  /** Students with marks at or above the pass mark in every subject. */
  passedAll: number;
  /** While marks are incomplete: students with some marks and none below the pass mark (or absent) so far. */
  clearSoFar: number;
};

/** Marks-entry progress, status and a results summary for every section of the school, for one exam. */
export async function examOverview(scope: Scope, examId: string, passPercent: number): Promise<SectionOverview[]> {
  if (!isUuid(examId)) return [];
  const db = await getDb();
  const secs = await db
    .select({
      id: sections.id,
      name: sections.name,
      classId: classes.id,
      className: classes.name,
      stream: classes.stream,
      classOrder: classes.sortOrder,
      classTeacherName: staff.name,
    })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(staff, eq(staff.id, sections.classTeacherId))
    .where(and(eq(classes.schoolId, scope.schoolId), eq(sections.sessionId, scope.sessionId)))
    .orderBy(asc(classes.sortOrder), asc(sections.name));
  const secIds = secs.map((s) => s.id);
  const [papersByClass, roster, states, teachers] = await Promise.all([
    examPapersByClass(examId),
    rosterTx(db, scope.sessionId, secIds),
    resultStates(examId, secIds),
    secIds.length
      ? db
          .select({ sectionId: teachingAssignments.sectionId, subjectId: teachingAssignments.subjectId, name: staff.name })
          .from(teachingAssignments)
          .innerJoin(staff, eq(staff.id, teachingAssignments.staffId))
          .where(inArray(teachingAssignments.sectionId, secIds))
      : Promise.resolve([]),
  ]);
  const allMarks = await marksMap(
    examId,
    roster.map((r) => r.id),
  );

  return secs.map((s) => {
    const papers = papersByClass.get(s.classId) ?? [];
    const kids = roster.filter((r) => r.sectionId === s.id);
    const subjectsProgress: SubjectProgress[] = papers.map((p) => {
      let entered = 0;
      let absent = 0;
      for (const k of kids) {
        const m = allMarks.get(k.id)?.get(p.subjectId);
        if (m?.absent) absent++;
        else if (m && m.tenths !== null) entered++;
      }
      return {
        subjectId: p.subjectId,
        name: p.name,
        maxMarks: p.maxMarks,
        teacherName: teachers.find((t) => t.sectionId === s.id && t.subjectId === p.subjectId)?.name ?? null,
        entered,
        absent,
        missing: kids.length - entered - absent,
      };
    });
    const results = kids.map((k) => computeResult(papers, allMarks.get(k.id), passPercent));
    const expected = papers.length * kids.length;
    const missing = subjectsProgress.reduce((a, x) => a + x.missing, 0);
    return {
      sectionId: s.id,
      label: sectionLabel(s.className, s.name),
      classId: s.classId,
      className: s.className,
      stream: s.stream,
      classTeacherName: s.classTeacherName,
      students: kids.length,
      papers,
      subjects: subjectsProgress,
      expected,
      done: expected - missing,
      missing,
      state: states.get(s.id)!,
      averagePercent: averagePercent(results.map((r) => r.percent)),
      passedAll: results.filter((r) => r.passedAll).length,
      clearSoFar: results.filter((r) => r.percent !== null && !r.needsImprovement.length).length,
    };
  });
}

/* ------------------------------------------------------------------ */
/* One section (marks grid, class summary, report cards)               */
/* ------------------------------------------------------------------ */

export type SheetRow = RosterStudent & { result: StudentResult<Paper>; marks: Map<string, MarkValue> };

/** A section's students with their marks and results for an exam. */
export async function sectionSheet(scope: Scope, examId: string, sectionId: string, passPercent: number) {
  if (!isUuid(examId) || !isUuid(sectionId)) return null;
  const db = await getDb();
  const sec = await sectionMetaTx(db, sectionId);
  if (!sec || sec.schoolId !== scope.schoolId || sec.sessionId !== scope.sessionId) return null;
  const [papersByClass, roster, states] = await Promise.all([examPapersByClass(examId), rosterTx(db, scope.sessionId, [sectionId]), resultStates(examId, [sectionId])]);
  const papers = papersByClass.get(sec.classId) ?? [];
  const allMarks = await marksMap(
    examId,
    roster.map((r) => r.id),
  );
  const rows: SheetRow[] = roster.map((r) => {
    const m = allMarks.get(r.id) ?? new Map<string, MarkValue>();
    return { ...r, marks: m, result: computeResult(papers, m, passPercent) };
  });
  return { section: sec, papers, rows, state: states.get(sectionId)! };
}

/** The marks grid for one section and subject. */
export async function marksSheet(scope: Scope, examId: string, sectionId: string, subjectId: string) {
  if (!isUuid(examId) || !isUuid(sectionId) || !isUuid(subjectId)) return null;
  const db = await getDb();
  const sec = await sectionMetaTx(db, sectionId);
  if (!sec || sec.schoolId !== scope.schoolId || sec.sessionId !== scope.sessionId) return null;
  const [paper] = await db
    .select({ subjectId: examPapers.subjectId, name: subjects.name, maxMarks: examPapers.maxMarks })
    .from(examPapers)
    .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
    .where(and(eq(examPapers.examId, examId), eq(examPapers.classId, sec.classId), eq(examPapers.subjectId, subjectId)));
  if (!paper) return null;
  const [roster, states] = await Promise.all([rosterTx(db, scope.sessionId, [sectionId]), resultStates(examId, [sectionId])]);
  const stored = roster.length
    ? await db
        .select({ studentId: marks.studentId, marks: marks.marks, absent: marks.absent, enteredAt: marks.enteredAt, enteredBy: marks.enteredBy })
        .from(marks)
        .where(
          and(
            eq(marks.examId, examId),
            eq(marks.subjectId, subjectId),
            inArray(
              marks.studentId,
              roster.map((r) => r.id),
            ),
          ),
        )
    : [];
  const byStudent = new Map(stored.map((s) => [s.studentId, s]));
  const rows = roster.map((r) => {
    const m = byStudent.get(r.id);
    return { studentId: r.id, name: r.name, srNo: r.srNo, rollNo: r.rollNo, tenths: m && !m.absent ? tenthsFromDb(m.marks) : null, absent: m?.absent ?? false };
  });
  const last = stored.reduce<Date | null>((a, s) => (!a || s.enteredAt > a ? s.enteredAt : a), null);
  return { section: sec, paper, rows, state: states.get(sectionId)!, lastSavedAt: last };
}

/** Days present and days the register was taken, for the session so far (up to `today`). */
export async function attendanceSoFar(sessionId: string, sectionId: string, studentIds: string[], today: string) {
  const out = new Map<string, { present: number; days: number }>();
  if (!isUuid(sectionId)) return out;
  const db = await getDb();
  const [sess] = await db.select().from(academicSessions).where(eq(academicSessions.id, sessionId));
  if (!sess) return out;
  const end = today < sess.endsOn ? today : sess.endsOn;
  const inRange = (col: typeof attendanceRegisters.date | typeof attendance.date) => sql`${col} between ${sess.startsOn} and ${end}`;
  const [[{ days }], present] = await Promise.all([
    db
      .select({ days: count() })
      .from(attendanceRegisters)
      .where(and(eq(attendanceRegisters.sectionId, sectionId), inRange(attendanceRegisters.date))),
    studentIds.length
      ? db
          .select({ studentId: attendance.studentId, n: count() })
          .from(attendance)
          .innerJoin(attendanceRegisters, and(eq(attendanceRegisters.sectionId, attendance.sectionId), eq(attendanceRegisters.date, attendance.date)))
          .where(and(eq(attendance.sectionId, sectionId), inArray(attendance.studentId, studentIds), inArray(attendance.status, ["present", "late"]), inRange(attendance.date)))
          .groupBy(attendance.studentId)
      : Promise.resolve([]),
  ]);
  for (const id of studentIds) out.set(id, { present: Number(present.find((p) => p.studentId === id)?.n ?? 0), days: Number(days) });
  return out;
}

/* ------------------------------------------------------------------ */
/* Families                                                            */
/* ------------------------------------------------------------------ */

export type PublishedResult = { exam: ExamRow; publishedAt: Date | null; papers: Paper[]; result: StudentResult<Paper> };

/**
 * A student's results in the exams published for their section, latest
 * first. Nothing from unpublished exams is returned.
 */
export async function publishedResultsFor(scope: Scope, studentId: string, onlyExamId?: string): Promise<PublishedResult[]> {
  if (!isUuid(studentId) || (onlyExamId !== undefined && !isUuid(onlyExamId))) return [];
  const db = await getDb();
  const [enr] = await db
    .select({ sectionId: enrolments.sectionId, classId: sections.classId })
    .from(enrolments)
    .innerJoin(sections, eq(sections.id, enrolments.sectionId))
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(and(eq(enrolments.studentId, studentId), eq(enrolments.sessionId, scope.sessionId), eq(students.schoolId, scope.schoolId)));
  if (!enr) return [];
  const published = await db
    .select({ exam: exams, publishedAt: examResults.publishedAt })
    .from(examResults)
    .innerJoin(exams, eq(exams.id, examResults.examId))
    .where(
      and(
        eq(examResults.sectionId, enr.sectionId),
        eq(examResults.status, "published"),
        eq(exams.schoolId, scope.schoolId),
        eq(exams.sessionId, scope.sessionId),
        onlyExamId ? eq(exams.id, onlyExamId) : undefined,
      ),
    )
    .orderBy(desc(exams.sortOrder), desc(examResults.publishedAt));
  if (!published.length) return [];
  const passPercent = await schoolPassPercent(scope.schoolId);
  const out: PublishedResult[] = [];
  for (const p of published) {
    const papers = (await examPapersByClass(p.exam.id)).get(enr.classId) ?? [];
    const m = (await marksMap(p.exam.id, [studentId])).get(studentId);
    out.push({ exam: p.exam, publishedAt: p.publishedAt, papers, result: computeResult(papers, m, passPercent) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Report cards                                                        */
/* ------------------------------------------------------------------ */

export type ReportCardStudent = RosterStudent & {
  result: StudentResult<Paper>;
  attendance: { present: number; days: number };
  /** The class teacher's remark for this exam (lib/services/report-remarks.ts), or null. */
  remark: string | null;
};

export type ReportCardSet = {
  school: { id: string; name: string; nameHi: string; place: string };
  sessionId: string;
  exam: ExamRow;
  section: SectionMeta;
  classTeacherName: string | null;
  state: ResultState;
  passPercent: number;
  papers: Paper[];
  students: ReportCardStudent[];
};

/** Everything a report card shows, for a section (or one student in it). */
export async function reportCards(scope: Scope, examId: string, sectionId: string, opts: { studentId?: string; today: string }): Promise<ReportCardSet | null> {
  const exam = await getExam(scope, examId);
  if (!exam) return null;
  const passPercent = await schoolPassPercent(scope.schoolId);
  const sheet = await sectionSheet(scope, examId, sectionId, passPercent);
  if (!sheet) return null;
  const db = await getDb();
  const [[school], [ct]] = await Promise.all([
    db.select({ id: schools.id, name: schools.name, nameHi: schools.nameHi, place: schools.place }).from(schools).where(eq(schools.id, scope.schoolId)),
    sheet.section.classTeacherId ? db.select({ name: staff.name }).from(staff).where(eq(staff.id, sheet.section.classTeacherId)) : Promise.resolve([undefined]),
  ]);
  const rows = opts.studentId ? sheet.rows.filter((r) => r.id === opts.studentId) : sheet.rows;
  const [att, remarks] = await Promise.all([
    attendanceSoFar(
      scope.sessionId,
      sectionId,
      rows.map((r) => r.id),
      opts.today,
    ),
    reportRemarksFor(
      exam.id,
      rows.map((r) => r.id),
    ),
  ]);
  return {
    school,
    sessionId: scope.sessionId,
    exam,
    section: sheet.section,
    classTeacherName: ct?.name ?? null,
    state: sheet.state,
    passPercent,
    papers: sheet.papers,
    students: rows.map(({ marks: _m, ...r }) => ({ ...r, attendance: att.get(r.id) ?? { present: 0, days: 0 }, remark: remarks.get(r.id)?.remark ?? null })),
  };
}

/* ------------------------------------------------------------------ */
/* Dashboard helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * A student's most recently published result this session, for dashboards.
 * `percent` is the overall percentage rounded to one decimal (78.1), or null
 * when the student has no marks (none entered, or `outcome` "absent": absent
 * in every paper).
 */
export async function latestPublishedResult(
  studentId: string,
  sessionId: string,
): Promise<{ examId: string; examName: string; percent: number | null; passedAll: boolean; outcome: OverallOutcome; publishedAt: Date | null } | null> {
  if (!isUuid(studentId)) return null;
  const db = await getDb();
  const [st] = await db.select({ schoolId: students.schoolId }).from(students).where(eq(students.id, studentId));
  if (!st) return null;
  const list = await publishedResultsFor({ schoolId: st.schoolId, sessionId }, studentId);
  if (!list.length) return null;
  const latest = list.reduce((a, b) => ((b.publishedAt?.getTime() ?? 0) > (a.publishedAt?.getTime() ?? 0) ? b : a));
  return {
    examId: latest.exam.id,
    examName: latest.exam.name,
    percent: latest.result.percent === null ? null : latest.result.percent / 10,
    passedAll: latest.result.passedAll,
    outcome: latest.result.outcome,
    publishedAt: latest.publishedAt,
  };
}

export type MarksProgressRow = {
  examId: string;
  examName: string;
  sectionId: string;
  sectionLabel: string;
  status: ResultStatus;
  students: number;
  papers: number;
  /** students × papers */
  expected: number;
  /** entries with marks or marked absent */
  entered: number;
  missing: number;
  complete: boolean;
};

/** Marks-entry completeness for every exam and section with papers this session (exam order, then class order). */
export async function marksEntryProgress(schoolId: string, sessionId: string): Promise<MarksProgressRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      examId: exams.id,
      examName: exams.name,
      examOrder: exams.sortOrder,
      sectionId: sections.id,
      sectionName: sections.name,
      className: classes.name,
      classOrder: classes.sortOrder,
      status: examResults.status,
      expected: count(),
      entered: count(marks.studentId),
      students: sql<number>`count(distinct ${enrolments.studentId})`,
      papers: sql<number>`count(distinct ${examPapers.subjectId})`,
    })
    .from(examPapers)
    .innerJoin(exams, and(eq(exams.id, examPapers.examId), eq(exams.schoolId, schoolId), eq(exams.sessionId, sessionId)))
    .innerJoin(classes, eq(classes.id, examPapers.classId))
    .innerJoin(sections, and(eq(sections.classId, examPapers.classId), eq(sections.sessionId, sessionId)))
    .innerJoin(enrolments, and(eq(enrolments.sectionId, sections.id), eq(enrolments.sessionId, sessionId)))
    .innerJoin(students, and(eq(students.id, enrolments.studentId), eq(students.status, "active")))
    .leftJoin(marks, and(eq(marks.examId, examPapers.examId), eq(marks.studentId, enrolments.studentId), eq(marks.subjectId, examPapers.subjectId), markDone))
    .leftJoin(examResults, and(eq(examResults.examId, exams.id), eq(examResults.sectionId, sections.id)))
    .groupBy(exams.id, exams.name, exams.sortOrder, sections.id, sections.name, classes.name, classes.sortOrder, examResults.status)
    .orderBy(asc(exams.sortOrder), asc(classes.sortOrder), asc(sections.name));
  return rows.map((r) => {
    const expected = Number(r.expected);
    const entered = Number(r.entered);
    return {
      examId: r.examId,
      examName: r.examName,
      sectionId: r.sectionId,
      sectionLabel: sectionLabel(r.className, r.sectionName),
      status: r.status ?? "open",
      students: Number(r.students),
      papers: Number(r.papers),
      expected,
      entered,
      missing: expected - entered,
      complete: expected > 0 && entered >= expected,
    };
  });
}

export type PendingPaper = {
  examId: string;
  examName: string;
  sectionId: string;
  sectionLabel: string;
  subjectId: string;
  subjectName: string;
  maxMarks: number;
  students: number;
  entered: number;
  missing: number;
  status: ResultStatus;
  /** Link to the marks grid. */
  href: string;
};

/**
 * For a teacher's home page: how many exams the school has this session, and
 * how many papers (exam × section × subject) the teacher enters marks for — so
 * "nothing to enter" can say whether that's because there are no exams yet.
 */
export async function teacherPaperCounts(staffId: string, schoolId: string, sessionId: string): Promise<{ exams: number; papers: number }> {
  if (!isUuid(staffId)) return { exams: 0, papers: 0 };
  const db = await getDb();
  const [[e], [p]] = await Promise.all([
    db
      .select({ n: count() })
      .from(exams)
      .where(and(eq(exams.schoolId, schoolId), eq(exams.sessionId, sessionId))),
    db
      .select({ n: count() })
      .from(teachingAssignments)
      .innerJoin(sections, and(eq(sections.id, teachingAssignments.sectionId), eq(sections.sessionId, sessionId)))
      .innerJoin(examPapers, and(eq(examPapers.classId, sections.classId), eq(examPapers.subjectId, teachingAssignments.subjectId)))
      .innerJoin(exams, and(eq(exams.id, examPapers.examId), eq(exams.schoolId, schoolId), eq(exams.sessionId, sessionId)))
      .where(eq(teachingAssignments.staffId, staffId)),
  ]);
  return { exams: Number(e?.n ?? 0), papers: Number(p?.n ?? 0) };
}

/** Papers a teacher still has to fill this session: their (section, subject) pairs with marks missing, not yet published. */
export async function pendingMarksForTeacher(staffId: string, sessionId: string): Promise<PendingPaper[]> {
  if (!isUuid(staffId)) return [];
  const db = await getDb();
  const rows = await db
    .select({
      examId: exams.id,
      examName: exams.name,
      examOrder: exams.sortOrder,
      sectionId: sections.id,
      sectionName: sections.name,
      className: classes.name,
      classOrder: classes.sortOrder,
      subjectId: subjects.id,
      subjectName: subjects.name,
      subjectOrder: subjects.sortOrder,
      maxMarks: examPapers.maxMarks,
      status: examResults.status,
      students: count(),
      entered: count(marks.studentId),
    })
    .from(teachingAssignments)
    .innerJoin(staff, eq(staff.id, teachingAssignments.staffId))
    .innerJoin(sections, and(eq(sections.id, teachingAssignments.sectionId), eq(sections.sessionId, sessionId)))
    .innerJoin(classes, and(eq(classes.id, sections.classId), eq(classes.schoolId, staff.schoolId)))
    .innerJoin(subjects, eq(subjects.id, teachingAssignments.subjectId))
    .innerJoin(examPapers, and(eq(examPapers.classId, sections.classId), eq(examPapers.subjectId, teachingAssignments.subjectId)))
    .innerJoin(exams, and(eq(exams.id, examPapers.examId), eq(exams.sessionId, sessionId), eq(exams.schoolId, staff.schoolId)))
    .innerJoin(enrolments, and(eq(enrolments.sectionId, sections.id), eq(enrolments.sessionId, sessionId)))
    .innerJoin(students, and(eq(students.id, enrolments.studentId), eq(students.status, "active")))
    .leftJoin(marks, and(eq(marks.examId, exams.id), eq(marks.studentId, enrolments.studentId), eq(marks.subjectId, teachingAssignments.subjectId), markDone))
    .leftJoin(examResults, and(eq(examResults.examId, exams.id), eq(examResults.sectionId, sections.id)))
    .where(and(eq(teachingAssignments.staffId, staffId), or(sql`${examResults.status} is null`, ne(examResults.status, "published"))))
    .groupBy(
      exams.id,
      exams.name,
      exams.sortOrder,
      sections.id,
      sections.name,
      classes.name,
      classes.sortOrder,
      subjects.id,
      subjects.name,
      subjects.sortOrder,
      examPapers.maxMarks,
      examResults.status,
    )
    .orderBy(asc(exams.sortOrder), asc(classes.sortOrder), asc(sections.name), asc(subjects.sortOrder));
  return rows
    .map((r) => ({
      examId: r.examId,
      examName: r.examName,
      sectionId: r.sectionId,
      sectionLabel: sectionLabel(r.className, r.sectionName),
      subjectId: r.subjectId,
      subjectName: r.subjectName,
      maxMarks: r.maxMarks,
      students: Number(r.students),
      entered: Number(r.entered),
      missing: Number(r.students) - Number(r.entered),
      status: (r.status ?? "open") as ResultStatus,
      href: `/teach/marks?exam=${r.examId}&section=${r.sectionId}&subject=${r.subjectId}`,
    }))
    .filter((r) => r.missing > 0);
}
