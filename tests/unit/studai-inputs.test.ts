/**
 * What the portal tells Stud-AI about a student (lib/studai/inputs.ts) and
 * the fingerprint that decides when an estimate is worked out again; and
 * the check of Stud-AI's answers (lib/studai/contract.ts).
 *
 *   node --import tsx --test tests/unit/studai-inputs.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { canEstimate, fingerprint, studentInputs, subjectHomework, testPercents, type PaperMark } from "../../lib/studai/inputs";
import { parseResponse } from "../../lib/studai/contract";
import { emptyAttendance } from "../../lib/support/figures";

const mark = (examOrder: number, tenths: number | null, maxMarks: number, absent = false): PaperMark => ({ examOrder, tenths, maxMarks, absent });

test("test scores become percentages of each paper's maximum, oldest exam first", () => {
  // Unit Test 18.5 out of 25 = 74%; Half-yearly 62 out of 100 = 62%; given out of order.
  assert.deepEqual(testPercents([mark(2, 620, 100), mark(1, 185, 25)]), [74, 62]);
  assert.deepEqual(testPercents([mark(1, 333, 50)]), [66.6]);
  // Absent, or not entered: left out (not counted as zero).
  assert.deepEqual(testPercents([mark(1, null, 25, true), mark(2, null, 100), mark(3, 450, 100)]), [45]);
  // Never above 100%, whatever was typed.
  assert.deepEqual(testPercents([mark(1, 300, 25)]), [100]);
});

test("homework counts per subject once 3 are checked; excused doesn't count", () => {
  assert.equal(subjectHomework(undefined), null);
  assert.equal(subjectHomework({ done: 1, late: 0, notDone: 1, excused: 4 }), null);
  assert.equal(subjectHomework({ done: 2, late: 1, notDone: 1, excused: 4 }), 75);
});

test("a student's inputs: whole-day attendance for every subject, subjects with nothing left out", () => {
  const subjects = [
    { id: "m", name: "Mathematics" },
    { id: "h", name: "Hindi" },
    { id: "s", name: "Science" },
    { id: "d", name: "Drawing" },
  ];
  const marks = new Map([
    ["m", [mark(1, 200, 25), mark(2, 550, 100)]],
    ["s", [mark(1, null, 25, true)]],
  ]);
  const homework = new Map([
    ["h", { done: 3, late: 0, notDone: 1, excused: 0 }],
    ["s", { done: 1, late: 0, notDone: 0, excused: 0 }],
  ]);
  const att = { ...emptyAttendance(), days: 40, present: 34, late: 2, absent: 4 };
  const inputs = studentInputs(subjects, marks, homework, att);
  assert.deepEqual(inputs, [
    { key: "m", name: "Mathematics", tests: [80, 55], attendance: 90, homework: null },
    { key: "h", name: "Hindi", tests: [], attendance: 90, homework: 75 },
  ]);
  assert.equal(canEstimate(inputs), true);
  assert.equal(canEstimate([inputs[1]]), false);
  // Fewer than 10 register days: attendance unknown.
  assert.equal(studentInputs(subjects, marks, homework, { ...emptyAttendance(), days: 9, present: 9 })[0].attendance, null);
});

test("the fingerprint changes with the records, the subject's name and the model, and not with order", () => {
  const a = { key: "m", name: "Mathematics", tests: [80, 55], attendance: 90, homework: null };
  const b = { key: "h", name: "Hindi", tests: [61], attendance: 90, homework: 75 };
  const fp = fingerprint("model-1", [a, b]);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint("model-1", [b, a]), fp);
  assert.notEqual(fingerprint("model-2", [a, b]), fp);
  assert.notEqual(fingerprint("model-1", [{ ...a, tests: [80, 56] }, b]), fp);
  assert.notEqual(fingerprint("model-1", [{ ...a, name: "Maths" }, b]), fp);
  assert.notEqual(fingerprint("model-1", [a, { ...b, homework: null }]), fp);
  assert.notEqual(fingerprint("model-1", [a]), fp);
});

const reason = { key: "scores", words: "Mathematics test scores so far", value: "average 41", effect: "raises", sentence: "Mathematics test scores so far: average 41 (raises the risk)" };
const estimate = {
  ref: "s1",
  key: "m",
  subject: "mathematics",
  percent: 28,
  text: "Estimated risk of not passing the next mathematics examination: 28%",
  reasons: [reason],
  assumed: ["Homework done in mathematics"],
  known_subject: true,
  tests_used: 2,
};
const notEnoughData = { ref: "s1", key: "h", subject: "hindi", percent: null, text: "Not enough data as of now for Hindi", reasons: [], assumed: [], known_subject: false, tests_used: 1 };
const answer = (over: Record<string, unknown> = {}) => ({
  contract: 3,
  model: { version: "1.1.0", created: "2026-10-01T03:41:42+00:00", trees: 239, subjects_trained_on: ["mathematics"], file_sha256: "a".repeat(64), card_sha256: "b".repeat(64) },
  results: [estimate, notEnoughData],
  skipped: [],
  errors: [],
  ...over,
});
const withResult = (changes: Record<string, unknown>, base: Record<string, unknown> = estimate) => ({ ...answer(), results: [{ ...base, ...changes }] });

test("answers carry the percentage, sentence and reasons, and are strict", () => {
  const parsed = parseResponse(answer());
  assert.equal(parsed.results[0].percent, 28);
  assert.equal(parsed.results[0].text, "Estimated risk of not passing the next mathematics examination: 28%");
  assert.deepEqual(parsed.results[0].reasons, [reason]);
  assert.equal(parsed.results[1].percent, null);
  assert.equal(parsed.results[1].known_subject, false);
  for (const contract of [1, 2]) assert.throws(() => parseResponse(answer({ contract })), /expected shape/);
  // Never a raw probability, logits or model weights: unknown fields are refused.
  for (const extra of [{ risk: 0.28 }, { logit: -0.9 }, { decision: "on_track" }, { review_reason: null }]) {
    assert.throws(() => parseResponse(withResult(extra)), /expected shape/);
  }
  assert.throws(() => parseResponse(withResult({ reasons: [{ ...reason, weight: 0.42 }] })), /expected shape/);
  // The percentage is a whole number from 1 to 99, and the texts are bounded.
  for (const percent of [0, 100, 50.5, -3, "28"]) assert.throws(() => parseResponse(withResult({ percent })), /expected shape/, String(percent));
  assert.throws(() => parseResponse(withResult({ text: "x".repeat(301) })), /expected shape/);
  assert.throws(() => parseResponse(withResult({ reasons: Array(6).fill(reason) })), /expected shape/);
  assert.throws(() => parseResponse(withResult({ reasons: [{ ...reason, effect: "doubles" }] })), /expected shape/);
  // An estimate needs its percentage; a subject Stud-AI wasn't trained on has none, and no reasons.
  assert.throws(() => parseResponse(withResult({ percent: null })), /expected shape/);
  assert.throws(() => parseResponse(withResult({ percent: 40 }, notEnoughData)), /expected shape/);
  assert.throws(() => parseResponse(withResult({ reasons: [reason] }, notEnoughData)), /expected shape/);
  // The sentence must say the same percentage as the figure beside it.
  assert.throws(() => parseResponse(withResult({ text: "Estimated risk of not passing the next mathematics examination: 82%" })), /expected shape/);
  assert.throws(() => parseResponse(withResult({ text: "Low risk" })), /expected shape/);
  assert.throws(() => parseResponse(withResult({ text: "Estimated risk of not passing the next hindi examination: 40%" }, notEnoughData)), /expected shape/);
  assert.throws(() => parseResponse("not an object"), /expected shape/);
});
