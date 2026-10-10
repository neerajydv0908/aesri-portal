/**
 * Subject names and Stud-AI: the clean-up before names are sent
 * (lib/studai/coverage.ts studAiName), and which of a school's subjects
 * Stud-AI covers, with names that look like a covered subject
 * (lib/studai/coverage.ts), shown in Settings and used by the colour rule.
 *
 *   node --import tsx --test tests/unit/studai-coverage.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprint, studentInputs } from "../../lib/studai/inputs";
import { lookalike, studAiName, studAiSubjectKey, subjectCoverage } from "../../lib/studai/coverage";
import { emptyAttendance } from "../../lib/support/figures";
import { misnamedSubjects } from "../../lib/studai/estimates";

const TRAINED = ["mathematics", "english", "science", "history", "geography"];
/** Invisible characters that come in with names pasted from elsewhere. */
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const WORD_JOINER = String.fromCodePoint(0x2060);
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);

test("names are cleaned before Stud-AI sees them, so a name that looks right reads right", () => {
  assert.equal(studAiName("Maths."), "Maths");
  assert.equal(studAiName(`Mathe${ZERO_WIDTH_SPACE}matics`), "Mathematics");
  assert.equal(studAiName(`${WORD_JOINER}English${ZERO_WIDTH_JOINER}`), "English");
  assert.equal(studAiName("Ｍａｔｈｓ".normalize("NFC")), "Maths"); // full-width letters
  assert.equal(studAiName("  Social   Science  "), "Social Science");
  assert.equal(studAiName("C++"), "C++");
  assert.equal(studAiName("हिन्दी"), "हिन्दी");
  assert.equal(studAiName(ZERO_WIDTH_SPACE), ZERO_WIDTH_SPACE); // nothing left: the name as it was
});

test("the inputs keep the school's own name (cleaned only when sent), and the fingerprint covers it", () => {
  const name = `Mathe${ZERO_WIDTH_SPACE}matics.`;
  const inputs = studentInputs(
    [{ id: "m", name }],
    new Map([["m", [{ examOrder: 1, maxMarks: 100, tenths: 650, absent: false }]]]),
    new Map(),
    emptyAttendance(),
  );
  assert.equal(inputs[0].name, name);
  assert.notEqual(fingerprint("model", inputs), fingerprint("model", [{ ...inputs[0], name: "Mathematics" }]));
  assert.equal(fingerprint("model", inputs), fingerprint("model", [{ ...inputs[0] }]));
});

test("names are read the way Stud-AI reads them", () => {
  assert.equal(studAiSubjectKey("Maths."), "mathematics");
  assert.equal(studAiSubjectKey("MATH"), "mathematics");
  assert.equal(studAiSubjectKey(`Mathe${ZERO_WIDTH_SPACE}matics`), "mathematics");
  assert.equal(studAiSubjectKey("EVS"), "environmental studies");
  assert.equal(studAiSubjectKey("Social_Science"), "social science");
});

test("names that look like a covered subject are pointed out; different subjects are not", () => {
  assert.equal(lookalike("English Core", TRAINED), "english");
  assert.equal(lookalike("English Language and Literature", TRAINED), "english");
  assert.equal(lookalike("Mathematics (Standard)", TRAINED), "mathematics");
  assert.equal(lookalike("Maths (Basic)", TRAINED), "mathematics");
  assert.equal(lookalike("General Science", TRAINED), "science");
  assert.equal(lookalike("Maths Std", TRAINED), "mathematics");
  for (const different of ["Social Science", "Environmental Science", "Computer Science", "Hindi", "Science & Technology", "EVS", "Maths Lab", "Science Practical"]) {
    assert.equal(lookalike(different, TRAINED), null, different);
  }
  assert.equal(lookalike("Mathematics", TRAINED), null); // covered as it is
  assert.equal(lookalike("English Core", []), null); // no trained list: nothing to compare with
});

test("a school's subjects split into covered and not covered", () => {
  const c = subjectCoverage(["English", "Hindi", "Maths.", "EVS", "Social Science", "English Core"], TRAINED);
  assert.deepEqual(c.covered, ["English", "Maths."]);
  assert.deepEqual(c.notCovered, [
    { name: "Hindi", like: null },
    { name: "EVS", like: null },
    { name: "Social Science", like: null },
    { name: "English Core", like: "english" },
  ]);
  assert.deepEqual(c.sameSubject, []);
});

test("two subjects that read as the same subject to Stud-AI are pointed out, covered or not", () => {
  const c = subjectCoverage(["Maths", "Mathematics", "English", "English.", "Hindi", "Hindi.", "EVS", "Environmental Studies"], TRAINED);
  assert.deepEqual(c.sameSubject, [
    { key: "mathematics", names: ["Maths", "Mathematics"] },
    { key: "english", names: ["English", "English."] },
    { key: "hindi", names: ["Hindi", "Hindi."] },
    { key: "environmental studies", names: ["EVS", "Environmental Studies"] },
  ]);
});

test("a look-alike counts as unsure unless the student also has the covered subject itself", () => {
  const r = (subjectName: string, knownSubject = false) => ({ subjectId: subjectName, subjectName, knownSubject });
  // "English Core" on its own: it means English.
  assert.deepEqual(misnamedSubjects([r("English Core"), r("Hindi")], TRAINED), [{ subjectId: "English Core", like: "english" }]);
  // Beside English itself, "English Literature" is a different subject.
  assert.deepEqual(misnamedSubjects([r("English", true), r("English Literature"), r("Hindi")], TRAINED), []);
  // Without the trained list, every "not enough data" result counts as unsure.
  assert.deepEqual(misnamedSubjects([r("Mathematics", true), r("Hindi")], []), [{ subjectId: "Hindi", like: "" }]);
});
