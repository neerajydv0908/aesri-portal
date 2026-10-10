/**
 * Stud-AI's estimates in the portal (lib/studai/estimates.ts) against a real
 * (embedded) PostgreSQL and the stand-in Stud-AI folder: what is sent,
 * that estimates are worked out again only when a student's records or the
 * model change, what happens when Stud-AI fails, and that only the current
 * session's estimates are kept.
 *
 *   node --import tsx --test tests/unit/studai-estimates.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "../../lib/db/client";
import * as schema from "../../lib/db/schema";
import { seedReferenceData } from "../../lib/services/reference";
import { estimateCounts, resetStudAiBackoff, riskInputs, sectionEstimates, studAiStatusRecord } from "../../lib/studai/estimates";
import { makeFakeStudAi, pythonAvailable } from "./fixtures/fake-studai";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-studai-test-"));
process.env.PGLITE_DIR = dir;
delete process.env.DATABASE_URL;
const fake = makeFakeStudAi();
process.env.STUD_AI_PYTHON = "python3";

const { academicSessions, accounts, attendance, attendanceRegisters, classes, enrolments, examPapers, exams, homework, homeworkChecks, marks, riskEstimates, sections, staff, students, subjects } = schema;

const SCHOOL = "aryavart";
const SESSION = "2026-27";
const TODAY = "2026-09-30";
let db: Awaited<ReturnType<typeof getDb>>;
let section: { id: string; classId: string };
let teacher: string;
const S: Record<string, string> = {};
const SUB: Record<string, string> = {};
let ut1: string;
let hy: string;
const scope = { schoolId: SCHOOL, sessionId: SESSION, actor: { accountId: "" } };
const skip = pythonAvailable() ? false : "needs python3";

async function setMark(exam: string, student: string, subject: string, value: number | null) {
  await db
    .insert(marks)
    .values({ examId: exam, studentId: S[student], subjectId: SUB[subject], marks: value === null ? null : String(value), absent: value === null, enteredBy: teacher })
    .onConflictDoUpdate({ target: [marks.examId, marks.studentId, marks.subjectId], set: { marks: value === null ? null : String(value), absent: value === null } });
}

/** One subject's result as a teacher reads it: "Mathematics 58%". */
const shown = (e: { subjectName: string; percent: number | null; knownSubject: boolean }) => `${e.subjectName} ${e.knownSubject ? `${e.percent}%` : "not enough data"}`;

const pctOf = async (student: string, opts: { studentIds?: string[] } = {}) => {
  const r = await sectionEstimates(scope, section, { today: TODAY, ...opts });
  return { r, list: (r.byStudent.get(S[student])?.subjects ?? []).map(shown) };
};

before(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedReferenceData(tx);
    const [cls] = await tx.select({ id: classes.id }).from(classes).where(and(eq(classes.schoolId, SCHOOL), eq(classes.name, "IV")));
    const [sec] = await tx.select({ id: sections.id }).from(sections).where(and(eq(sections.classId, cls.id), eq(sections.name, "A")));
    section = { id: sec.id, classId: cls.id };
    // Class IV's subjects (Aryavart's list comes from its own records, so the test adds three).
    for (const [i, name] of ["Hindi", "English", "Mathematics"].entries()) {
      const [sub] = await tx.insert(subjects).values({ schoolId: SCHOOL, name, sortOrder: i }).returning({ id: subjects.id });
      await tx.insert(schema.classSubjects).values({ classId: cls.id, subjectId: sub.id });
      SUB[name] = sub.id;
    }
    const [t] = await tx.insert(staff).values({ schoolId: SCHOOL, empNo: "3", name: "Sunita Meena", access: "teacher" }).returning({ id: staff.id });
    const [acc] = await tx.insert(accounts).values({ loginId: "aryae3", role: "teacher", schoolId: SCHOOL, staffId: t.id, status: "active" }).returning({ id: accounts.id });
    teacher = acc.id;
    scope.actor.accountId = acc.id;
    for (const [i, name] of ["Asha", "Bhanu", "Chetan"].entries()) {
      const [st] = await tx.insert(students).values({ schoolId: SCHOOL, srNo: String(9100 + i), name: `${name} Kumar` }).returning({ id: students.id });
      await tx.insert(enrolments).values({ studentId: st.id, sessionId: SESSION, sectionId: sec.id, rollNo: i + 1 });
      S[name] = st.id;
    }
    // Two exams, given in the wrong order on purpose: exam order decides, not when they were added.
    [{ id: hy }] = await tx.insert(exams).values({ schoolId: SCHOOL, sessionId: SESSION, name: "Half-yearly", sortOrder: 2 }).returning({ id: exams.id });
    [{ id: ut1 }] = await tx.insert(exams).values({ schoolId: SCHOOL, sessionId: SESSION, name: "Unit Test 1", sortOrder: 1 }).returning({ id: exams.id });
    for (const subject of ["Mathematics", "English"]) {
      await tx.insert(examPapers).values({ examId: ut1, classId: cls.id, subjectId: SUB[subject], maxMarks: 25 });
      await tx.insert(examPapers).values({ examId: hy, classId: cls.id, subjectId: SUB[subject], maxMarks: 100 });
    }
    // Attendance: 12 register days; Asha present 9 (75%), Bhanu all 12.
    for (let d = 1; d <= 12; d++) {
      const date = `2026-09-${String(d).padStart(2, "0")}`;
      await tx.insert(attendanceRegisters).values({ sectionId: sec.id, date, takenBy: acc.id });
      await tx.insert(attendance).values({ studentId: S.Asha, date, sectionId: sec.id, status: d <= 9 ? "present" : "absent", markedBy: acc.id });
      await tx.insert(attendance).values({ studentId: S.Bhanu, date, sectionId: sec.id, status: "present", markedBy: acc.id });
    }
    // Mathematics homework for Asha: done, late, not done (2 of 3 = 66.7%).
    for (const status of ["done", "late", "not_done"] as const) {
      const [hw] = await tx
        .insert(homework)
        .values({ sectionId: sec.id, subjectId: SUB.Mathematics, title: `Sums ${status}`, assignedOn: "2026-09-10", dueOn: "2026-09-11", createdBy: acc.id })
        .returning({ id: homework.id });
      await tx.insert(homeworkChecks).values({ homeworkId: hw.id, studentId: S.Asha, status, checkedBy: acc.id });
    }
  });
  await setMark(ut1, "Asha", "Mathematics", 10); // 40%
  await setMark(hy, "Asha", "Mathematics", 45); // 45%
  await setMark(ut1, "Asha", "English", 20); // 80%
  await setMark(hy, "Asha", "English", 85);
  await setMark(ut1, "Bhanu", "Mathematics", 22); // 88%
  await setMark(hy, "Bhanu", "Mathematics", 90);
  await setMark(ut1, "Bhanu", "English", null); // absent: left out
});

after(async () => {
  await closeDb();
  fake.remove();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Stud-AI estimates", { skip }, () => {
  test("what is sent: percentages in exam order, homework per subject, whole-day attendance", async () => {
    const inputs = await riskInputs(scope, section, [S.Asha, S.Bhanu, S.Chetan], TODAY);
    const byName = Object.fromEntries(inputs.get(S.Asha)!.map((s) => [s.name, [s.tests, s.attendance, s.homework]]));
    assert.deepEqual(byName, { English: [[80, 85], 75, null], Mathematics: [[40, 45], 75, 66.7] });
    // Bhanu was absent for his only English test and has no English homework: English tells Stud-AI nothing.
    assert.deepEqual(inputs.get(S.Bhanu)!.map((s) => [s.name, s.tests, s.attendance]), [["Mathematics", [88, 90], 100]]);
    assert.deepEqual(inputs.get(S.Chetan), []);
  });

  test("the first time, every student is worked out in one run; students without marks are grey", async () => {
    process.env.STUD_AI_DIR = fake.dir;
    const { r, list } = await pctOf("Asha");
    assert.deepEqual(r.status, { state: "ok", refreshed: 3, refused: [] });
    assert.deepEqual(list.sort(), ["English 18%", "Mathematics 58%"]); // averages 82.5 and 42.5
    assert.deepEqual((r.byStudent.get(S.Bhanu)?.subjects ?? []).map(shown), ["Mathematics 11%"]);
    assert.deepEqual(r.byStudent.get(S.Chetan)?.subjects, []);
    assert.deepEqual(fake.calls(), [2]); // Chetan has no marks: not sent
    const asha = r.byStudent.get(S.Asha)!.subjects.find((e) => e.subjectName === "English")!;
    assert.equal(asha.percent, 18);
    assert.equal(asha.text, "Estimated risk of not passing the next english examination: 18%");
    assert.equal(asha.reasons.length, 1);
    assert.deepEqual(asha.assumed, ["Homework done in english"]); // no English homework checked yet
    assert.equal(asha.knownSubject, true);
    assert.ok((await studAiStatusRecord()).lastOkAt);
  });

  test("nothing changed: nothing is run again", async () => {
    const { r } = await pctOf("Asha");
    assert.deepEqual(r.status, { state: "ok", refreshed: 0, refused: [] });
    assert.deepEqual(fake.calls(), [2]);
  });

  test("a changed mark reruns that student only; a retrained model reruns everyone", async () => {
    await setMark(hy, "Asha", "Mathematics", 70); // average (40 + 70) / 2 = 55 → 45%
    const first = await pctOf("Asha");
    assert.deepEqual(first.r.status, { state: "ok", refreshed: 1, refused: [] });
    assert.ok(first.list.includes("Mathematics 45%"));
    assert.deepEqual(fake.calls(), [2, 1]);
    fake.retrain();
    const again = await pctOf("Asha");
    assert.deepEqual(again.r.status, { state: "ok", refreshed: 3, refused: [] });
    assert.deepEqual(fake.calls(), [2, 1, 2]);
  });

  test("a renamed subject is worked out again (its name is in the sentence)", async () => {
    await db.update(subjects).set({ name: "Maths" }).where(eq(subjects.id, SUB.Mathematics));
    const { r, list } = await pctOf("Bhanu");
    assert.equal(r.status.state, "ok");
    assert.deepEqual(list, ["Maths 11%"]);
    assert.equal(r.byStudent.get(S.Bhanu)!.subjects[0].subjectName, "Maths");
    await db.update(subjects).set({ name: "Mathematics" }).where(eq(subjects.id, SUB.Mathematics));
    await pctOf("Bhanu");
  });

  test("when Stud-AI fails, the saved estimates are shown as out of date, and it waits before trying again", async () => {
    fake.setMode("crash");
    await setMark(ut1, "Bhanu", "Mathematics", 5); // changes Bhanu's inputs
    const callsBefore = fake.calls().length;
    const failed = await sectionEstimates(scope, section, { today: TODAY });
    assert.equal(failed.status.state, "stale");
    assert.match((failed.status as { message: string }).message, /RuntimeError: something broke/);
    const bhanu = failed.byStudent.get(S.Bhanu)!;
    assert.equal(bhanu.outdated, true);
    assert.deepEqual(bhanu.subjects.map((e) => e.percent), [11]); // the saved one
    assert.equal(failed.byStudent.get(S.Asha)!.outdated, false);
    assert.match((await studAiStatusRecord()).lastError ?? "", /something broke/);
    // Straight away again: no new run (it waits a minute), same message.
    fake.setMode(null);
    const waiting = await sectionEstimates(scope, section, { today: TODAY });
    assert.equal(waiting.status.state, "stale");
    assert.equal(fake.calls().length, callsBefore);
    // After "Check Stud-AI now" (or a minute), it works again.
    resetStudAiBackoff();
    const fixed = await sectionEstimates(scope, section, { today: TODAY });
    assert.deepEqual(fixed.status, { state: "ok", refreshed: 1, refused: [] });
    assert.deepEqual(fixed.byStudent.get(S.Bhanu)!.subjects.map((e) => e.percent), [45]); // tests 20% and 90%: average 55, so 45
  });

  test("one student can be asked for alone", async () => {
    const r = await sectionEstimates(scope, section, { today: TODAY, studentIds: [S.Asha] });
    assert.deepEqual([...r.byStudent.keys()], [S.Asha]);
  });

  test("not set up, or set up wrongly: no estimates, and the page is told why", async () => {
    delete process.env.STUD_AI_DIR;
    assert.deepEqual((await sectionEstimates(scope, section, { today: TODAY })).status, { state: "off" });
    process.env.STUD_AI_DIR = path.join(fake.dir, "missing");
    const r = await sectionEstimates(scope, section, { today: TODAY });
    assert.equal(r.status.state, "problem");
    assert.equal(r.byStudent.size, 0);
    process.env.STUD_AI_DIR = fake.dir;
  });

  test("only the current session's estimates are kept", async () => {
    await db.insert(academicSessions).values({ id: "2025-26", startsOn: "2025-04-01", endsOn: "2026-03-31", isCurrent: false }).onConflictDoNothing();
    await db.insert(riskEstimates).values({
      sessionId: "2025-26",
      studentId: S.Chetan,
      subjectId: SUB.English,
      percent: 40,
      text: "Estimated risk of not passing the next english examination: 40%",
      reasons: [],
      assumed: [],
      knownSubject: true,
      testsUsed: 1,
      computedAt: new Date("2026-03-01"),
    });
    await setMark(ut1, "Chetan", "English", 15); // Chetan now has marks: worked out, and the old session is cleared
    const r = await sectionEstimates(scope, section, { today: TODAY });
    assert.equal(r.status.state, "ok");
    const old = await db.select().from(riskEstimates).where(eq(riskEstimates.sessionId, "2025-26"));
    assert.equal(old.length, 0);
    const counts = await estimateCounts(SCHOOL, SESSION);
    assert.equal(counts.students, 3);
    assert.ok(counts.lastAt instanceof Date);
    const rows = await db.select().from(riskEstimates).where(inArray(riskEstimates.studentId, [S.Asha, S.Bhanu, S.Chetan]));
    assert.equal(counts.red, new Set(rows.filter((x) => x.percent !== null && x.percent >= 50).map((x) => x.studentId)).size);
  });
});
