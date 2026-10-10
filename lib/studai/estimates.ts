/**
 * Stud-AI's estimates for the students of a section: read from the
 * database, and worked out again first for any student whose records (or
 * the model) changed since.
 *
 * How it stays up to date without a background job: every student's inputs
 * (lib/studai/inputs.ts) are fingerprinted together with the model file. A
 * page that shows estimates asks for them here; students whose fingerprint
 * differs from the one saved with their estimates are sent to Stud-AI in one
 * run (about a second for a class), and their estimates replaced. Nothing
 * changed: nothing is run.
 *
 * If Stud-AI can't run (not installed, stopped, too slow), the page still
 * works: it shows the estimates saved earlier, marked as possibly out of
 * date, or none. After a failure this server waits a minute before trying
 * again. The last success and the last problem are kept in app_settings
 * ("studai.status") for the office Settings page.
 *
 * Callers check first that the person may see these students (class
 * teacher of the section, or an admin). No "server-only" import, so the
 * unit tests can use it with an embedded database.
 */
import { and, asc, count, eq, gte, inArray, isNotNull, lte, ne, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  academicSessions,
  appSettings,
  attendance,
  attendanceRegisters,
  classSubjects,
  examPapers,
  exams,
  homework,
  homeworkChecks,
  marks,
  riskChecks,
  riskEstimates,
  sections,
  students,
  subjects,
} from "@/lib/db/schema";
import { tenthsFromDb } from "@/components/exams/rules";
import { sectionRoll, sessionBounds } from "@/lib/services/attendance";
import { emptyAttendance, emptyHomework, type AttendanceFigure, type HomeworkFigure } from "@/lib/support/figures";
import { CONTRACT, type BatchRequest, type BatchResult, type EstimateReason, type ModelInfo, type SubjectInput } from "./contract";
import { modelFingerprint, readModelCard, studAiConfigProblem, studAiDir } from "./config";
import { lookalike, studAiName, studAiSubjectKey } from "./coverage";
import { STUD_AI_RED_PERCENT, type SupportContext } from "@/lib/support/rules";
import { canEstimate, fingerprint, studentInputs, type PaperMark } from "./inputs";
import { runStudAiForAccount } from "./service";

export type SubjectEstimate = {
  subjectId: string;
  /** The subject as the school names it. */
  subjectName: string;
  /** The estimated risk of not passing the next exam, 1–99 (%); null when Stud-AI wasn't trained on the subject ("Not enough data as of now"). */
  percent: number | null;
  /** Stud-AI's sentence: "Estimated risk of not passing the next mathematics examination: 62%". */
  text: string;
  /** The main reasons, in words. */
  reasons: EstimateReason[];
  /** Inputs Stud-AI didn't have, so it used a typical value instead. */
  assumed: string[];
  /** False: Stud-AI wasn't trained on this subject, so there is no estimate. */
  knownSubject: boolean;
  testsUsed: number;
  computedAt: Date;
};

export type StudentEstimates = {
  subjects: SubjectEstimate[];
  /** What Stud-AI was (or would be) told, per subject. */
  inputs: SubjectInput[];
  /** True when the records changed since these estimates and they couldn't be worked out again yet. */
  outdated: boolean;
};

export type EstimatesStatus =
  /** Stud-AI isn't set up on this server (STUD_AI_DIR is empty). */
  | { state: "off" }
  /** Set up, but something is wrong (the message says what). */
  | { state: "problem"; message: string }
  /** Up to date. `refreshed`: students worked out again just now. `refused`: single subjects Stud-AI refused. */
  | { state: "ok"; refreshed: number; refused: string[] }
  /** Some estimates couldn't be updated just now; the saved ones are shown. */
  | { state: "stale"; message: string };

/**
 * What the "Needs support" rule needs to know besides the results themselves
 * (lib/support/rules.ts SupportContext): whether Stud-AI is available, whether
 * this student's results are out of date, which subjects it was given with
 * test marks (each must have an answer before the student can be green), and
 * "not covered" results whose name looks like a subject it covers.
 * `trained`: the subjects Stud-AI was trained on (sectionEstimates).
 */
export function supportContext(est: StudentEstimates, status: EstimatesStatus, trained: string[]): SupportContext {
  return {
    studAi: status.state,
    outdated: est.outdated,
    given: est.inputs.filter((i) => i.tests.length > 0).map((i) => ({ subjectId: i.key, subjectName: i.name })),
    misnamed: misnamedSubjects(est.subjects, trained),
  };
}

/**
 * "Not enough data" results (a subject Stud-AI wasn't trained on) whose name
 * looks like a subject Stud-AI covers ("English Core" → English): counted as
 * unsure, never ignored — unless the student also has that covered subject
 * itself (then the look-alike is a different subject, such as English
 * Literature beside English). Without the trained list (it can't be read),
 * every such result counts as unsure, so nothing can turn green by mistake.
 */
export function misnamedSubjects(subjects: { subjectId: string; subjectName: string; knownSubject: boolean }[], trained: string[]) {
  const unknown = subjects.filter((s) => s.knownSubject === false);
  if (!trained.length) return unknown.map((s) => ({ subjectId: s.subjectId, like: "" }));
  const recognised = new Set(subjects.filter((s) => !unknown.includes(s)).map((s) => studAiSubjectKey(s.subjectName)));
  return unknown
    .map((s) => ({ subjectId: s.subjectId, like: lookalike(s.subjectName, trained) }))
    .filter((m): m is { subjectId: string; like: string } => m.like !== null && !recognised.has(m.like));
}

export type StudAiStatusRecord = {
  lastOkAt?: string;
  lastRunMs?: number;
  lastStudents?: number;
  lastErrorAt?: string;
  lastError?: string;
  model?: ModelInfo;
};

export const STATUS_KEY = "studai.status";

/** Seconds this server waits after a failed run before trying again. */
const BACKOFF_MS = 60_000;
type RefreshOutcome = { problem: string | null; refused: string[] };
const g = globalThis as unknown as { __aesriStudAi?: { backoffUntil: number; lastError: string; inflight: Map<string, Promise<RefreshOutcome>> } };
const state = (g.__aesriStudAi ??= { backoffUntil: 0, lastError: "", inflight: new Map() });

/** Forget a failure (tests, and the office's "Try again" button). */
export function resetStudAiBackoff(): void {
  state.backoffUntil = 0;
  state.lastError = "";
}

type Scope = { schoolId: string; sessionId: string };
type InferenceScope = Scope & { actor: { accountId: string } };

/* ------------------------------------------------------------------ */
/* Inputs from the records                                             */
/* ------------------------------------------------------------------ */

/**
 * Every listed student's inputs: this session's marks, homework checks per
 * subject and whole-day attendance, for the subjects of the section's class.
 */
export async function riskInputs(scope: Scope, section: { id: string; classId: string }, studentIds: string[], today: string): Promise<Map<string, SubjectInput[]>> {
  const out = new Map<string, SubjectInput[]>();
  if (!studentIds.length) return out;
  const db = await getDb();
  const b = await sessionBounds(scope.sessionId);
  const end = today < b.endsOn ? today : b.endsOn;

  const [examRows, classSubjectRows, attRows, hwRows] = await Promise.all([
    db
      .select({ id: exams.id, sortOrder: exams.sortOrder, createdAt: exams.createdAt })
      .from(exams)
      .where(and(eq(exams.schoolId, scope.schoolId), eq(exams.sessionId, scope.sessionId)))
      .orderBy(asc(exams.sortOrder), asc(exams.createdAt)),
    db
      .select({ id: subjects.id, name: subjects.name, sortOrder: subjects.sortOrder })
      .from(classSubjects)
      .innerJoin(subjects, eq(subjects.id, classSubjects.subjectId))
      .where(eq(classSubjects.classId, section.classId)),
    // Days that count: the student's section took the register that day.
    db
      .select({ studentId: attendance.studentId, status: attendance.status, n: count() })
      .from(attendance)
      .innerJoin(attendanceRegisters, and(eq(attendanceRegisters.sectionId, attendance.sectionId), eq(attendanceRegisters.date, attendance.date)))
      .where(and(inArray(attendance.studentId, studentIds), gte(attendance.date, b.startsOn), lte(attendance.date, end)))
      .groupBy(attendance.studentId, attendance.status),
    // Homework of this session that belongs to a subject ("General" homework has none).
    db
      .select({ studentId: homeworkChecks.studentId, subjectId: homework.subjectId, status: homeworkChecks.status, n: count() })
      .from(homeworkChecks)
      .innerJoin(homework, eq(homework.id, homeworkChecks.homeworkId))
      .innerJoin(sections, eq(sections.id, homework.sectionId))
      .where(and(inArray(homeworkChecks.studentId, studentIds), eq(sections.sessionId, scope.sessionId), isNotNull(homework.subjectId)))
      .groupBy(homeworkChecks.studentId, homework.subjectId, homeworkChecks.status),
  ]);

  const examOrder = new Map(examRows.map((e, i) => [e.id, i]));
  const [paperRows, markRows] = examRows.length
    ? await Promise.all([
        db
          .select({ examId: examPapers.examId, subjectId: examPapers.subjectId, maxMarks: examPapers.maxMarks, name: subjects.name, sortOrder: subjects.sortOrder })
          .from(examPapers)
          .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
          .where(and(inArray(examPapers.examId, [...examOrder.keys()]), eq(examPapers.classId, section.classId))),
        db
          .select({ examId: marks.examId, studentId: marks.studentId, subjectId: marks.subjectId, marks: marks.marks, absent: marks.absent })
          .from(marks)
          .where(and(inArray(marks.examId, [...examOrder.keys()]), inArray(marks.studentId, studentIds))),
      ])
    : [[], []];

  // The class's subjects, and any subject with a paper for it, in the school's order.
  const subjectMap = new Map<string, { id: string; name: string; sortOrder: number }>();
  for (const s of [...classSubjectRows, ...paperRows.map((p) => ({ id: p.subjectId, name: p.name, sortOrder: p.sortOrder }))]) subjectMap.set(s.id, s);
  const subjectList = [...subjectMap.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const maxOf = new Map(paperRows.map((p) => [`${p.examId}:${p.subjectId}`, p.maxMarks]));

  const att = new Map<string, AttendanceFigure>(studentIds.map((id) => [id, emptyAttendance()]));
  for (const r of attRows) {
    const a = att.get(r.studentId);
    if (!a) continue;
    a[r.status] += Number(r.n);
    a.days += Number(r.n);
  }
  const hw = new Map<string, Map<string, HomeworkFigure>>(studentIds.map((id) => [id, new Map()]));
  for (const r of hwRows) {
    const bySubject = hw.get(r.studentId);
    if (!bySubject || !r.subjectId) continue;
    const h = bySubject.get(r.subjectId) ?? emptyHomework();
    const n = Number(r.n);
    if (r.status === "done") h.done += n;
    else if (r.status === "late") h.late += n;
    else if (r.status === "not_done") h.notDone += n;
    else h.excused += n;
    bySubject.set(r.subjectId, h);
  }
  const mk = new Map<string, Map<string, PaperMark[]>>(studentIds.map((id) => [id, new Map()]));
  for (const m of markRows) {
    const max = maxOf.get(`${m.examId}:${m.subjectId}`);
    const bySubject = mk.get(m.studentId);
    if (!max || !bySubject) continue; // no paper for this class: not a test of this class
    const list = bySubject.get(m.subjectId) ?? [];
    list.push({ examOrder: examOrder.get(m.examId) ?? 0, maxMarks: max, tenths: m.absent ? null : tenthsFromDb(m.marks), absent: m.absent });
    bySubject.set(m.subjectId, list);
  }

  for (const id of studentIds) out.set(id, studentInputs(subjectList, mk.get(id)!, hw.get(id)!, att.get(id)!));
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading and refreshing                                              */
/* ------------------------------------------------------------------ */

async function saveStatus(update: StudAiStatusRecord): Promise<void> {
  try {
    const db = await getDb();
    const [cur] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, STATUS_KEY));
    const value = { ...((cur?.value as StudAiStatusRecord | undefined) ?? {}), ...update };
    await db
      .insert(appSettings)
      .values({ key: STATUS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  } catch (err) {
    console.error(`[stud-ai] Couldn't record the status: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The last success and problem on this server (Settings page). */
export async function studAiStatusRecord(): Promise<StudAiStatusRecord> {
  const db = await getDb();
  const [cur] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, STATUS_KEY));
  return (cur?.value as StudAiStatusRecord | undefined) ?? {};
}

/**
 * Work out again the estimates of the students whose fingerprint changed.
 * `problem` is null when it worked, or says what went wrong; `refused`
 * lists single subjects Stud-AI refused (the rest are saved).
 */
async function refresh(scope: InferenceScope, stale: { id: string; fp: string; inputs: SubjectInput[] }[]): Promise<RefreshOutcome> {
  const refused: string[] = [];
  const db = await getDb();
  const now = new Date();
  const toSend = stale.filter((s) => canEstimate(s.inputs));
  let results: BatchResult[] = [];
  let model: ModelInfo | null = null;
  if (toSend.length) {
    if (Date.now() < state.backoffUntil) return { problem: state.lastError || "Stud-AI couldn't run a moment ago.", refused };
    // Names as Stud-AI is told them (invisible characters and trailing punctuation removed); answers come back by subject ID.
    const request: BatchRequest = { contract: CONTRACT, students: toSend.map((s) => ({ ref: s.id, subjects: s.inputs.map((i) => ({ ...i, name: studAiName(i.name) })) })) };
    const run = await runStudAiForAccount(request, scope.actor.accountId);
    if (!run.ok) {
      if (run.limited) return { problem: run.error, refused };
      state.backoffUntil = Date.now() + BACKOFF_MS;
      state.lastError = run.error;
      console.error(`[stud-ai] ${run.error}`);
      await saveStatus({ lastErrorAt: now.toISOString(), lastError: run.error });
      return { problem: run.error, refused };
    }
    state.backoffUntil = 0;
    state.lastError = "";
    model = run.response.model;
    const wanted = new Map(toSend.map((s) => [s.id, new Set(s.inputs.map((x) => x.key))]));
    results = run.response.results.filter((r) => wanted.get(r.ref)?.has(r.key));
    for (const e of run.response.errors) refused.push(e.error);
    await saveStatus({ lastOkAt: now.toISOString(), lastRunMs: run.ms, lastStudents: toSend.length, model });
  }

  const ids = stale.map((s) => s.id);
  await db.transaction(async (tx) => {
    await tx.delete(riskEstimates).where(and(eq(riskEstimates.sessionId, scope.sessionId), inArray(riskEstimates.studentId, ids)));
    if (results.length) {
      await tx.insert(riskEstimates).values(
        results.map((r) => ({
          sessionId: scope.sessionId,
          studentId: r.ref,
          subjectId: r.key,
          percent: r.percent,
          text: r.text,
          reasons: r.reasons,
          assumed: r.assumed,
          knownSubject: r.known_subject,
          testsUsed: r.tests_used,
          computedAt: now,
        })),
      );
    }
    await tx
      .insert(riskChecks)
      .values(stale.map((s) => ({ sessionId: scope.sessionId, studentId: s.id, fingerprint: s.fp, modelVersion: model?.version ?? null, checkedAt: now })))
      .onConflictDoUpdate({
        target: [riskChecks.sessionId, riskChecks.studentId],
        set: { fingerprint: sql`excluded.fingerprint`, modelVersion: sql`excluded.model_version`, checkedAt: sql`excluded.checked_at` },
      });
    // Estimates are kept for the current session only.
    const current = () => tx.select({ id: academicSessions.id }).from(academicSessions).where(eq(academicSessions.isCurrent, true));
    await tx.delete(riskEstimates).where(and(ne(riskEstimates.sessionId, scope.sessionId), notInArray(riskEstimates.sessionId, current())));
    await tx.delete(riskChecks).where(and(ne(riskChecks.sessionId, scope.sessionId), notInArray(riskChecks.sessionId, current())));
  });
  return { problem: null, refused };
}

/**
 * The estimates of some students of one section (all of its roll when
 * `studentIds` is left out), worked out again first where needed.
 */
export async function sectionEstimates(
  scope: InferenceScope,
  section: { id: string; classId: string },
  opts: { today: string; studentIds?: string[] },
): Promise<{ byStudent: Map<string, StudentEstimates>; status: EstimatesStatus; trained: string[] }> {
  const byStudent = new Map<string, StudentEstimates>();
  const dir = studAiDir();
  if (!dir) return { byStudent, status: { state: "off" }, trained: [] };
  const problem = studAiConfigProblem();
  if (problem) return { byStudent, status: { state: "problem", message: problem }, trained: [] };
  const modelSha = modelFingerprint(dir);
  if (!modelSha) return { byStudent, status: { state: "problem", message: "Stud-AI's model file can't be read." }, trained: [] };
  // The subjects it was trained on, from its verified card (for the look-alike check in supportContext).
  const trained = readModelCard(dir)?.subjects ?? [];

  const db = await getDb();
  const roll = await sectionRoll(db, section.id);
  const ids = opts.studentIds ? roll.filter((s) => opts.studentIds!.includes(s.id)).map((s) => s.id) : roll.map((s) => s.id);
  if (!ids.length) return { byStudent, status: { state: "ok", refreshed: 0, refused: [] }, trained };

  const inputs = await riskInputs(scope, section, ids, opts.today);
  const fps = new Map(ids.map((id) => [id, fingerprint(modelSha, inputs.get(id) ?? [])]));
  const checks = await db
    .select({ studentId: riskChecks.studentId, fingerprint: riskChecks.fingerprint })
    .from(riskChecks)
    .where(and(eq(riskChecks.sessionId, scope.sessionId), inArray(riskChecks.studentId, ids)));
  const saved = new Map(checks.map((c) => [c.studentId, c.fingerprint]));
  const stale = ids.filter((id) => saved.get(id) !== fps.get(id)).map((id) => ({ id, fp: fps.get(id)!, inputs: inputs.get(id) ?? [] }));

  let status: EstimatesStatus = { state: "ok", refreshed: 0, refused: [] };
  const outdated = new Set<string>();
  if (stale.length) {
    // Two pages asking for the same students at once share one run.
    const key = `${scope.actor.accountId}:${scope.sessionId}:${stale.map((s) => `${s.id}=${s.fp}`).join(",")}`;
    let job = state.inflight.get(key);
    if (!job) {
      job = refresh(scope, stale).catch((err): RefreshOutcome => {
        // Never log or show the database's own message: it can quote the estimates being saved.
        const cause = err instanceof Error && err.cause && typeof err.cause === "object" ? (err.cause as { code?: unknown }).code : undefined;
        const code = typeof cause === "string" && /^[A-Za-z0-9_]{1,20}$/.test(cause) ? ` (database error ${cause})` : "";
        const problem = "Stud-AI's estimates couldn't be saved. Please try again.";
        console.error(`[stud-ai] Stud-AI's estimates couldn't be saved${code}.`);
        return { problem, refused: [] };
      });
      state.inflight.set(key, job);
      void job.finally(() => state.inflight.delete(key));
    }
    const outcome = await job;
    if (outcome.problem) {
      status = { state: "stale", message: outcome.problem };
      for (const s of stale) outdated.add(s.id);
    } else {
      status = { state: "ok", refreshed: stale.length, refused: outcome.refused };
    }
  }

  const rows = await db
    .select({
      studentId: riskEstimates.studentId,
      subjectId: riskEstimates.subjectId,
      subjectName: subjects.name,
      sortOrder: subjects.sortOrder,
      percent: riskEstimates.percent,
      text: riskEstimates.text,
      reasons: riskEstimates.reasons,
      assumed: riskEstimates.assumed,
      knownSubject: riskEstimates.knownSubject,
      testsUsed: riskEstimates.testsUsed,
      computedAt: riskEstimates.computedAt,
    })
    .from(riskEstimates)
    .innerJoin(subjects, eq(subjects.id, riskEstimates.subjectId))
    .where(and(eq(riskEstimates.sessionId, scope.sessionId), inArray(riskEstimates.studentId, ids)))
    .orderBy(asc(subjects.sortOrder), asc(subjects.name));
  for (const id of ids) byStudent.set(id, { subjects: [], inputs: inputs.get(id) ?? [], outdated: outdated.has(id) });
  for (const r of rows) {
    byStudent.get(r.studentId)?.subjects.push({
      subjectId: r.subjectId,
      subjectName: r.subjectName,
      percent: r.percent,
      text: r.text,
      reasons: r.reasons,
      assumed: r.assumed,
      knownSubject: r.knownSubject,
      testsUsed: r.testsUsed,
      computedAt: r.computedAt,
    });
  }
  return { byStudent, status, trained };
}

/** For the AESRI overview: how many of a school's students have estimates this session, and how many at or above the red level in a subject. */
export async function estimateCounts(schoolId: string, sessionId: string): Promise<{ students: number; red: number; lastAt: Date | null }> {
  const db = await getDb();
  const rows = await db
    .select({ studentId: riskEstimates.studentId, needsSupport: sql<boolean>`bool_or(${riskEstimates.percent} >= ${STUD_AI_RED_PERCENT})`, at: sql<Date | string>`max(${riskEstimates.computedAt})` })
    .from(riskEstimates)
    .innerJoin(students, eq(students.id, riskEstimates.studentId))
    .where(and(eq(riskEstimates.sessionId, sessionId), eq(students.schoolId, schoolId), eq(students.status, "active")))
    .groupBy(riskEstimates.studentId);
  let lastAt: Date | null = null;
  for (const r of rows) {
    const at = r.at instanceof Date ? r.at : new Date(r.at);
    if (!lastAt || at > lastAt) lastAt = at;
  }
  return { students: rows.length, red: rows.filter((r) => r.needsSupport).length, lastAt };
}
