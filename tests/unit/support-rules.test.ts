/**
 * The "Needs support" colours (lib/support/rules.ts): red for a Stud-AI
 * estimate of 50% or more in any subject, or for low attendance together
 * with several recent concerns; amber ("Review needed") when a subject's
 * most recent exam mark is below the pass mark or absent (or Stud-AI's
 * result can't be read); grey without a current Stud-AI answer for every
 * subject it was given; green otherwise. Subjects Stud-AI wasn't trained on
 * ("Not enough data as of now") never decide the colour by themselves, but
 * their marks still count. Also the school's own numbers and how they are
 * read from Settings.
 *
 *   node --import tsx --test tests/unit/support-rules.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLOURS,
  COLOUR_WORDS,
  DEFAULT_PASS_PERCENT,
  DEFAULT_SUPPORT_RULE,
  STUD_AI_RED_PERCENT,
  notCovered,
  resolveSupportRule,
  ruleSentences,
  supportStatus as rawSupportStatus,
  usablePassPercent,
  type EstimateFigure,
  type SupportContext,
  type SupportRule,
} from "../../lib/support/rules";
import { emptyAttendance, emptyHomework, emptyRemarks, type StudentFigures } from "../../lib/support/figures";

const R: SupportRule = DEFAULT_SUPPORT_RULE;

/** Stud-AI running normally, nothing out of date, nothing given that went unanswered, no look-alike names. */
const OK: SupportContext = { studAi: "ok", outdated: false, given: [], misnamed: [] };
/** The rule with the normal context, changed where a test says so. */
const supportStatus = (f: StudentFigures, e: EstimateFigure[], rule: SupportRule, pass: number, ctx: Partial<SupportContext> = {}) =>
  rawSupportStatus(f, e, rule, pass, { ...OK, ...ctx });
/** The school's pass mark in these tests. */
const P = 33;

/** A student with nothing recorded yet. */
const blank = (): StudentFigures => ({
  studentId: "x",
  gender: null,
  attendance: emptyAttendance(),
  attendanceRecent: emptyAttendance(),
  homework: emptyHomework(),
  exams: [],
  remarks: emptyRemarks(),
});

/** Attendance of exactly `pct`% over 1000 days (so one decimal is exact). */
const withAttendance = (pct: number, days = 1000): StudentFigures => {
  const present = Math.round((pct / 100) * days);
  return { ...blank(), attendance: { days, present, late: 0, absent: days - present, leave: 0 } };
};

const withConcerns = (f: StudentFigures, n: number): StudentFigures => ({ ...f, remarks: { ...emptyRemarks(), concerns: n, concernAreas: n ? ["behaviour"] : [], concernsRecent: n } });

/** A subject's result in an exam: a percentage, "absent", null (not entered yet), or [percentage, below by the exact check]. */
type Mark = number | "absent" | null | [number, boolean];

/** Exams in order, each with its subjects' results. */
const withExams = (f: StudentFigures, exams: [string, [string, Mark][]][]): StudentFigures => ({
  ...f,
  exams: exams.map(([name, subjects], i) => ({
    examId: `e${i}`,
    name,
    sortOrder: i + 1,
    percent: 700,
    subjects: subjects.map(([s, m]) => {
      const p = Array.isArray(m) ? m[0] : typeof m === "number" ? m : null;
      return {
        subjectId: s,
        name: s,
        maxMarks: 100,
        percent: p === null ? null : Math.round(p * 10),
        absent: m === "absent",
        ...(Array.isArray(m) ? { belowPass: m[1] } : {}),
      };
    }),
  })),
});

/** Stud-AI's estimate: the risk of not passing the next exam, in %. Red at 50% or more. */
const est = (subjectName: string, percent: number): EstimateFigure => ({ subjectId: subjectName, subjectName, percent, knownSubject: true });
/** An estimate without its percentage: it can't be read. */
const unreadable = (subjectName: string): EstimateFigure => ({ subjectId: subjectName, subjectName, percent: null, knownSubject: true });
/** A subject Stud-AI was never trained on: "Not enough data as of now". */
const untrained = (subjectName: string): EstimateFigure => ({ subjectId: subjectName, subjectName, percent: null, knownSubject: false });
/** What Stud-AI was given (subjects with test marks). */
const given = (...names: string[]) => names.map((n) => ({ subjectId: n, subjectName: n }));

test("the defaults use attendance below 70% with 3 concerns in 7 days", () => {
  assert.deepEqual(DEFAULT_SUPPORT_RULE, { attendanceRedPercent: 70, concernsRed: 3, concernDays: 7 });
});

test("an estimate of 50% or more is red; estimates below 50% are green", () => {
  const f = withAttendance(95);
  assert.equal(STUD_AI_RED_PERCENT, 50);
  assert.equal(supportStatus(f, [est("Mathematics", 49), est("English", 12)], R, P).colour, "green");
  const s = supportStatus(f, [est("English", 12), est("Mathematics", 50), est("Science", 63)], R, P);
  assert.equal(s.colour, "red");
  assert.deepEqual(s.reasons, [
    "Mathematics: Stud-AI estimates a 50% risk of not passing the next exam",
    "Science: Stud-AI estimates a 63% risk of not passing the next exam",
  ]);
  assert.deepEqual(s.highest, est("Mathematics", 50));
});

test("subjects Stud-AI wasn't trained on are listed, and never make a student grey on their own", () => {
  const f = withAttendance(95);
  const s = supportStatus(f, [est("Mathematics", 20), untrained("Hindi"), untrained("EVS")], R, P);
  assert.equal(s.colour, "green");
  assert.deepEqual(s.notCovered, ["EVS", "Hindi"]);
  assert.deepEqual(s.notes, ["not enough data as of now for Stud-AI to estimate EVS, Hindi (check their marks yourself)"]);
  assert.deepEqual(s.review, []);
  assert.deepEqual(s.highest, est("Mathematics", 20));
  // Only subjects it doesn't cover: no Stud-AI result yet, so grey (never green).
  const only = supportStatus(f, [untrained("Hindi")], R, P);
  assert.equal(only.colour, "grey");
  assert.equal(only.highest, null);
  assert.equal(notCovered(untrained("Hindi")), true);
  assert.equal(notCovered(unreadable("Hindi")), false);
  assert.equal(notCovered(est("Hindi", 20)), false);
});

test("a result that can't be read is 'Review needed', never 'On track'", () => {
  const s = supportStatus(withAttendance(95), [est("Mathematics", 10), unreadable("Science"), untrained("Hindi")], R, P);
  assert.equal(s.colour, "amber");
  assert.deepEqual(s.review, ["Science: Stud-AI’s result couldn’t be read, so check the marks"]);
  assert.deepEqual(s.reasons, []);
  // Unreadable alone, too.
  assert.equal(supportStatus(blank(), [unreadable("English")], R, P).colour, "amber");
});

test("an estimate without a usable percentage, or an unexpected result, counts as uncertain (fail safe)", () => {
  const f = withAttendance(95);
  for (const odd of [
    { subjectName: "Science", percent: null, knownSubject: true } as EstimateFigure,
    { subjectName: "Science", percent: Number.NaN, knownSubject: true } as EstimateFigure,
    { subjectName: "Science", percent: 30 } as unknown as EstimateFigure,
    { subjectName: "Science", percent: "30", knownSubject: true } as unknown as EstimateFigure,
  ]) {
    const s = supportStatus(f, [est("Mathematics", 10), odd], R, P);
    assert.equal(s.colour, "amber", JSON.stringify(odd));
    assert.deepEqual(s.notCovered, []);
  }
});

test("a subject's most recent mark below the pass mark is 'Review needed', in any subject, whatever Stud-AI says", () => {
  const good = withAttendance(95);
  // A subject Stud-AI doesn't cover: the child failing Hindi is never shown on track.
  const hindi = withExams(good, [["Half-yearly", [["Mathematics", 81], ["Hindi", 28]]]]);
  const s = supportStatus(hindi, [est("Mathematics", 5), untrained("Hindi")], R, P);
  assert.equal(s.colour, "amber");
  assert.deepEqual(s.review, ["Hindi: 28% in Half-yearly, below the pass mark (33%)"]);
  // A covered subject Stud-AI is confident about counts too.
  const maths = withExams(good, [["Unit Test 1", [["Mathematics", 30.5]]]]);
  assert.equal(supportStatus(maths, [est("Mathematics", 5)], R, P).colour, "amber");
  assert.deepEqual(supportStatus(maths, [est("Mathematics", 5)], R, P).review, ["Mathematics: 30.5% in Unit Test 1, below the pass mark (33%)"]);
  // Without any Stud-AI result (not set up, or not run yet) the marks still count.
  assert.equal(supportStatus(hindi, [], R, P).colour, "amber");
  // Exactly the pass mark is a pass; a mark not entered yet is not a mark.
  assert.equal(supportStatus(withExams(good, [["Half-yearly", [["Hindi", 33], ["EVS", null]]]]), [est("Mathematics", 5)], R, P).colour, "green");
  // Only the latest exam counts: an earlier low mark followed by a pass is not flagged.
  const better = withExams(good, [
    ["Unit Test 1", [["Hindi", 20]]],
    ["Half-yearly", [["Hindi", 61]]],
  ]);
  assert.equal(supportStatus(better, [est("Mathematics", 5), untrained("Hindi")], R, P).colour, "green");
  // The school's own pass mark is used.
  assert.equal(supportStatus(withExams(good, [["Half-yearly", [["Hindi", 38]]]]), [est("Mathematics", 5)], R, 40).colour, "amber");
});

test("each subject's own most recent result counts: a later exam without it, or not marked yet, doesn't hide a fail", () => {
  const good = withAttendance(95);
  const results = [est("Mathematics", 5), est("English", 5), untrained("Hindi")];
  // The Half-yearly has only Maths marked so far: Hindi's fail in Unit Test 1 still counts.
  const partial = withExams(good, [
    ["Unit Test 1", [["Mathematics", 80], ["Hindi", 20]]],
    ["Half-yearly", [["Mathematics", 81], ["Hindi", null]]],
  ]);
  const s = supportStatus(partial, results, R, P);
  assert.equal(s.colour, "amber");
  assert.deepEqual(s.review, ["Hindi: 20% in Unit Test 1, below the pass mark (33%)"]);
  // A later exam with no Hindi paper at all doesn't hide it either.
  const noPaper = withExams(good, [
    ["Unit Test 1", [["Hindi", 20]]],
    ["Unit Test 2", [["Mathematics", 90]]],
  ]);
  assert.equal(supportStatus(noPaper, results, R, P).colour, "amber");
});

test("absent from a subject's most recent exam is 'Review needed'", () => {
  const f = withExams(withAttendance(95), [
    ["Unit Test 1", [["Hindi", 20]]],
    ["Half-yearly", [["Hindi", "absent"], ["Mathematics", 70]]],
  ]);
  const s = supportStatus(f, [est("Mathematics", 5), untrained("Hindi")], R, P);
  assert.equal(s.colour, "amber");
  assert.deepEqual(s.review, ["Hindi: absent from Half-yearly"]);
  // Absent from every paper of the latest exam: each subject's absence counts.
  const allAbsent = withExams(withAttendance(95), [
    ["Unit Test 1", [["Mathematics", 70]]],
    ["Half-yearly", [["Mathematics", "absent"]]],
  ]);
  assert.deepEqual(supportStatus(allAbsent, [est("Mathematics", 5)], R, P).review, ["Mathematics: absent from Half-yearly"]);
});

test("the report card's exact pass check counts, even when the rounded percentage reaches the pass mark", () => {
  // 32 out of 97 is 32.99%: shown as 33%, but below the pass mark.
  const f = withExams(withAttendance(95), [["Half-yearly", [["Hindi", [33, true]]]]]);
  const s = supportStatus(f, [est("Mathematics", 5)], R, P);
  assert.equal(s.colour, "amber");
  assert.deepEqual(s.review, ["Hindi: just under 33% in Half-yearly, below the pass mark (33%)"]);
  assert.equal(supportStatus(withExams(withAttendance(95), [["Half-yearly", [["Hindi", [33, false]]]]]), [est("Mathematics", 5)], R, P).colour, "green");
});

test("a subject Stud-AI wasn't trained on never counts as an estimate, even with a percentage", () => {
  const odd = { subjectId: "Hindi", subjectName: "Hindi", percent: 80, knownSubject: false } as EstimateFigure;
  const s = supportStatus(withAttendance(95), [est("Mathematics", 5), odd], R, P);
  assert.equal(s.colour, "green");
  assert.deepEqual(s.notCovered, ["Hindi"]);
});

test("out-of-date results can still show red or 'Review needed', but never 'On track'", () => {
  const f = withAttendance(95);
  const old = { studAi: "stale", outdated: true, given: given("Mathematics") };
  const s = supportStatus(f, [est("Mathematics", 5)], R, P, old);
  assert.equal(s.colour, "grey");
  assert.match(s.greyWhy!, /out of date/);
  assert.equal(supportStatus(f, [est("Mathematics", 70)], R, P, old).colour, "red");
  assert.equal(supportStatus(f, [unreadable("Mathematics")], R, P, old).colour, "amber");
  assert.equal(supportStatus(f, [est("Mathematics", 5)], R, P, { studAi: "ok", outdated: false, given: given("Mathematics") }).colour, "green");
});

test("every subject Stud-AI was given needs an answer before a student is green", () => {
  const f = withAttendance(95);
  // Science had marks but no answer (refused, or not worked out yet): not green.
  const s = supportStatus(f, [est("Mathematics", 5), untrained("Hindi")], R, P, { studAi: "ok", given: given("Mathematics", "Science", "Hindi") });
  assert.equal(s.colour, "grey");
  assert.equal(s.greyWhy, "Stud-AI couldn’t give a result for Science.");
  assert.ok(s.notes.includes("Stud-AI couldn’t give a result for Science"));
  // Answered for everything it was given (a "not covered" answer counts as an answer): green.
  assert.equal(supportStatus(f, [est("Mathematics", 5), untrained("Hindi")], R, P, { studAi: "ok", given: given("Mathematics", "Hindi") }).colour, "green");
});

test("red comes first, and what needs a look is still listed with it", () => {
  const f = withExams(withConcerns(withAttendance(60), 4), [["Half-yearly", [["Hindi", 20]]]]);
  const s = supportStatus(f, [est("Mathematics", 70), unreadable("Science"), untrained("Hindi")], R, P);
  assert.equal(s.colour, "red");
  assert.deepEqual(s.reasons, ["Mathematics: Stud-AI estimates a 70% risk of not passing the next exam", "attendance 60% (below 70%) and 4 concerns in the last 7 days"]);
  assert.deepEqual(s.review, ["Science: Stud-AI’s result couldn’t be read, so check the marks", "Hindi: 20% in Half-yearly, below the pass mark (33%)"]);
});

test("a missing or unusable pass mark falls back to 33%, so marks are always checked", () => {
  assert.equal(DEFAULT_PASS_PERCENT, 33);
  assert.equal(usablePassPercent(40), 40);
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) assert.equal(usablePassPercent(bad as number), 33, String(bad));
  assert.equal(usablePassPercent(150), 100);
  const f = withExams(withAttendance(95), [["Half-yearly", [["Hindi", 30]]]]);
  assert.equal(supportStatus(f, [est("Mathematics", 5)], R, Number.NaN).colour, "amber");
  assert.equal(supportStatus(f, [est("Mathematics", 5)], R, 0).colour, "amber");
});

test("attendance below 70% is red only together with 3 or more concerns in the window", () => {
  const e = [est("Mathematics", 20)];
  assert.equal(supportStatus(withConcerns(withAttendance(69.9), 3), e, R, P).colour, "red");
  assert.deepEqual(supportStatus(withConcerns(withAttendance(69.9), 3), e, R, P).reasons, ["attendance 69.9% (below 70%) and 3 concerns in the last 7 days"]);
  // Either one alone is not enough, but the teacher is told.
  const lowOnly = supportStatus(withConcerns(withAttendance(60), 2), e, R, P);
  assert.equal(lowOnly.colour, "green");
  assert.deepEqual(lowOnly.notes, ["attendance 60%, below 70%"]);
  const concernsOnly = supportStatus(withConcerns(withAttendance(70), 4), e, R, P);
  assert.equal(concernsOnly.colour, "green");
  assert.deepEqual(concernsOnly.notes, ["4 concerns in the last 7 days"]);
  // Fewer than 10 register days: attendance doesn't count yet.
  assert.equal(supportStatus(withConcerns(withAttendance(10, 9), 5), e, R, P).colour, "green");
  assert.equal(supportStatus(withConcerns(withAttendance(10, 10), 5), e, R, P).colour, "red");
});

test("without any Stud-AI result: grey, unless something else applies", () => {
  assert.equal(supportStatus(blank(), [], R, P).colour, "grey");
  assert.equal(supportStatus(withAttendance(95), [], R, P).colour, "grey");
  assert.equal(supportStatus(withConcerns(withAttendance(50), 3), [], R, P).colour, "red");
  assert.equal(supportStatus(blank(), [], R, P).highest, null);
});

test("both parts of red can fire at once; every reason is listed", () => {
  const s = supportStatus(withConcerns(withAttendance(55), 6), [est("Science", 81), est("English", 52)], R, P);
  assert.equal(s.colour, "red");
  assert.equal(s.reasons.length, 3);
  assert.match(s.reasons[2], /^attendance 55% \(below 70%\) and 6 concerns/);
});

test("the school's own numbers are used", () => {
  const strict: SupportRule = { attendanceRedPercent: 80, concernsRed: 2, concernDays: 14 };
  const f = withConcerns(withAttendance(78), 2);
  assert.equal(supportStatus(f, [est("Mathematics", 45)], R, P).colour, "green");
  assert.equal(supportStatus(f, [est("Mathematics", 45)], strict, P).colour, "red");
  assert.deepEqual(supportStatus(f, [est("Mathematics", 20)], strict, P).reasons, ["attendance 78% (below 80%) and 2 concerns in the last 14 days"]);
  assert.match(ruleSentences(strict, P).red[0], /estimated risk of not passing the next exam is 50% or more in a subject/);
  assert.match(ruleSentences(strict, P).red[1], /below 80% together with 2 or more concerns recorded in the last 14 days/);
  assert.match(ruleSentences(strict, 40).amber[0], /below the pass mark \(40%\)/);
  assert.match(ruleSentences(strict, 0).amber[0], /below the pass mark \(33%\)/);
});

test("settings missing or out of range fall back to the defaults, one by one", () => {
  assert.deepEqual(resolveSupportRule(undefined), DEFAULT_SUPPORT_RULE);
  assert.deepEqual(resolveSupportRule({ attendanceRedPercent: 0, concernsRed: 2.5, concernDays: 30 }), { ...DEFAULT_SUPPORT_RULE, concernDays: 30 });
});

test("strengths and trends are shown but don't change the colour", () => {
  const f: StudentFigures = {
    ...withAttendance(96),
    attendanceRecent: { days: 20, present: 12, late: 0, absent: 8, leave: 0 },
    exams: [
      { examId: "a", name: "Unit Test 1", sortOrder: 1, percent: 800, subjects: [{ subjectId: "m", name: "Maths", maxMarks: 25, percent: 800, absent: false }] },
      { examId: "b", name: "Half-yearly", sortOrder: 2, percent: 700, subjects: [{ subjectId: "m", name: "Maths", maxMarks: 100, percent: 700, absent: false }] },
    ],
    homework: { done: 19, late: 0, notDone: 1, excused: 0 },
  };
  const s = supportStatus(f, [est("Maths", 8)], R, P);
  assert.equal(s.colour, "green");
  assert.deepEqual(s.strengths, ["attendance 96%", "homework done 95% of the time"]);
  assert.deepEqual(s.trends, ["overall 70% in Half-yearly, down from 80% in Unit Test 1", "attendance 60% in the last 30 days, 96.7% before that"]);
});

test("every colour has a word (never colour alone), most urgent first", () => {
  assert.deepEqual(COLOURS, ["red", "amber", "grey", "green"]);
  assert.deepEqual(COLOUR_WORDS, { red: "Needs support", amber: "Review needed", grey: "Not enough data yet", green: "On track" });
  for (const c of COLOURS) assert.ok(ruleSentences(R, P)[c].length > 0, c);
});

test("a 'not enough data' result whose name looks like a covered subject counts as unsure, never as not enough data", () => {
  const core = untrained("English Core");
  const s = supportStatus(withAttendance(95), [est("Mathematics", 5), core], R, P, { misnamed: [{ subjectId: "English Core", like: "english" }] });
  assert.equal(s.colour, "amber");
  assert.deepEqual(s.review, ["English Core: Stud-AI doesn’t recognise this subject name (it looks like English), so check the marks"]);
  assert.deepEqual(s.notCovered, []);
  assert.deepEqual(s.misnamed, [{ subjectId: "English Core", like: "english" }]);
  // When Stud-AI's list of covered subjects couldn't be read, a "not covered" result can't be trusted either.
  const unread = supportStatus(withAttendance(95), [est("Mathematics", 5), untrained("Hindi")], R, P, { misnamed: [{ subjectId: "Hindi", like: "" }] });
  assert.equal(unread.colour, "amber");
  assert.deepEqual(unread.review, ["Hindi: Stud-AI’s list of subjects it covers couldn’t be read, so check the marks"]);
  // Without the look-alike, the same result is simply not covered.
  assert.equal(supportStatus(withAttendance(95), [est("Mathematics", 5), core], R, P).colour, "green");
});

test("green needs Stud-AI to be running: results with Stud-AI off or broken never make a student green", () => {
  const f = withAttendance(95);
  for (const studAi of ["off", "problem", "", "unknown"]) {
    const s = supportStatus(f, [est("Mathematics", 5)], R, P, { studAi });
    assert.equal(s.colour, "grey", studAi);
    assert.match(s.greyWhy!, /isn’t available/);
  }
  assert.equal(supportStatus(f, [est("Mathematics", 5)], R, P, { studAi: "stale" }).colour, "green"); // this student's results are current
});

test("grey says why there is no Stud-AI result", () => {
  const f = withAttendance(95);
  assert.match(supportStatus(f, [], R, P, { studAi: "off" }).greyWhy!, /isn’t available/);
  assert.match(supportStatus(f, [], R, P, { studAi: "problem" }).greyWhy!, /isn’t available/);
  assert.match(supportStatus(f, [], R, P, { studAi: "stale", outdated: true }).greyWhy!, /couldn’t run/);
  assert.match(supportStatus(f, [untrained("Hindi")], R, P, { studAi: "ok", given: given("Hindi") }).greyWhy!, /not enough data as of now/);
  assert.match(supportStatus(f, [], R, P, { studAi: "ok" }).greyWhy!, /no marks this session/);
  assert.equal(supportStatus(f, [est("Mathematics", 5)], R, P).greyWhy, null);
});
