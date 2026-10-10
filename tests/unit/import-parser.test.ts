/**
 * Unit tests for the Excel import's reader and checker (no database).
 *   node --import tsx --test tests/unit/import-parser.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  checkWorkbook,
  classListText,
  eitherHalf,
  normalizeHeader,
  parseAccess,
  parseClassCell,
  parseDesignation,
  parseSectionRefs,
  readDate,
  readWorkbook,
  toCell,
  unzippedSize,
  type CheckedFile,
  type ImportReference,
} from "../../lib/services/import";
import { parseGender, parseYesNo } from "../../lib/validation";

const ARYA_TEMPLATE = path.join(process.cwd(), "public/templates/aryavart-portal-import.xlsx");
const AADHAR_TEMPLATE = path.join(process.cwd(), "public/templates/aadharshila-portal-import.xlsx");

const SUBJECTS = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Hindi", nameHi: "हिंदी" },
  { id: "00000000-0000-4000-8000-000000000002", name: "English", nameHi: "अंग्रेज़ी" },
  { id: "00000000-0000-4000-8000-000000000003", name: "Mathematics", nameHi: "गणित" },
  { id: "00000000-0000-4000-8000-000000000004", name: "Art & Drawing", nameHi: null },
];
const REF: ImportReference = {
  school: { name: "Aryavart Public School", loginPrefix: "Arya" },
  canSwitchSchool: false,
  session: { id: "2026-27", startsOn: "2026-04-01", endsOn: "2027-03-31" },
  today: "2026-09-29",
  classes: ["LKG", "UKG", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"].map((name) => ({
    name,
    stream: name === "XI" || name === "XII" ? "Arts" : null,
  })),
  subjects: SUBJECTS,
};

const STUDENT_HEADERS = [
  "SR No.\nएस.आर. क्रमांक",
  "Student's full name\nविद्यार्थी का पूरा नाम",
  "Gender\nलिंग",
  "Date of birth\nजन्म तिथि",
  "Class (2026–27)\nकक्षा (2026–27)",
  "Section\nवर्ग",
  "Roll No.\nरोल नंबर",
  "Admission date\nप्रवेश तिथि",
  "Father's name\nपिता का नाम",
  "Mother's name\nमाता का नाम",
  "Guardian's name (if not a parent)\nअभिभावक का नाम",
  "Parent's mobile\nअभिभावक का मोबाइल",
  "Second mobile\nदूसरा मोबाइल",
  "Village / address\nगाँव / पता",
  "Admitted on an RTE seat?\nRTE सीट पर प्रवेश?",
  "Check (automatic)\nजाँच (स्वतः)",
];
const STAFF_HEADERS = [
  "Employee No.\nकर्मचारी क्रमांक",
  "Full name\nपूरा नाम",
  "Designation\nपद",
  "Portal access\nपोर्टल अनुमति",
  "Mobile\nमोबाइल",
  "Email\nईमेल",
  "Class teacher of\nकक्षाध्यापक",
  "Subjects taught\nपढ़ाए जाने वाले विषय",
  "Date of joining\nकार्यभार ग्रहण तिथि",
  "Check (automatic)\nजाँच (स्वतः)",
];
const LISTS = { school_code: "ARYA", school_name: "Aryavart Public School", student_login_prefix: "Arya", staff_login_prefix: "AryaE", session: "2026-27", template_version: 1 };

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
/** A valid student row (values in template column order). */
/** Names without digits (the duplicate-person check compares letters only). */
const nameFor = (n: number) => `Child ${String(n).replace(/\d/g, (c) => "abcdefghij"[Number(c)])}`;
const student = (sr: number, over: Partial<Record<number, unknown>> = {}) => {
  const row: unknown[] = [sr, nameFor(sr), "Boy / बालक", d(2016, 5, 25), 5, "A", null, null, "Ramesh Kumar", null, null, "9876543210", null, "Palana", "No / नहीं"];
  for (const [k, v] of Object.entries(over)) row[Number(k)] = v;
  return row;
};
const staffRow = (emp: number, over: Partial<Record<number, unknown>> = {}) => {
  const row: unknown[] = [emp, `Teacher ${emp}`, "Teacher / शिक्षक", "Teacher / शिक्षक", "9811111111", null, null, null, null];
  for (const [k, v] of Object.entries(over)) row[Number(k)] = v;
  return row;
};

type Book = {
  students?: (unknown[] | null)[];
  staff?: (unknown[] | null)[];
  studentHeaders?: string[];
  staffHeaders?: string[];
  lists?: Record<string, unknown> | null;
  noStudentsSheet?: boolean;
};

/** Build a workbook like the template (headers in row 1, data from row 2; null = an empty row). */
async function book(b: Book): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("How to fill");
  const put = (name: string, headers: string[], rows: (unknown[] | null)[]) => {
    const ws = wb.addWorksheet(name);
    headers.forEach((h, i) => (ws.getRow(1).getCell(i + 1).value = h));
    rows.forEach((r, i) => {
      if (!r) return;
      r.forEach((v, c) => {
        if (v !== null && v !== undefined) ws.getRow(i + 2).getCell(c + 1).value = v as ExcelJS.CellValue;
      });
    });
    // The template's Check column holds a formula in every row.
    const checkCol = headers.findIndex((h) => h.startsWith("Check")) + 1;
    if (checkCol > 0) for (let r = 2; r <= Math.max(rows.length + 5, 10); r++) ws.getRow(r).getCell(checkCol).value = { formula: 'IF(A2="","","OK")', result: "" };
  };
  if (!b.noStudentsSheet) put("Students", b.studentHeaders ?? STUDENT_HEADERS, b.students ?? []);
  put("Staff", b.staffHeaders ?? STAFF_HEADERS, b.staff ?? []);
  wb.addWorksheet("Example").getCell("A1").value = "EXAMPLE ONLY";
  if (b.lists !== null) {
    const ls = wb.addWorksheet("Lists", { state: "hidden" });
    ls.getCell("H1").value = "key";
    ls.getCell("I1").value = "value";
    Object.entries(b.lists ?? LISTS).forEach(([k, v], i) => {
      ls.getCell(`H${i + 2}`).value = k;
      ls.getCell(`I${i + 2}`).value = v as ExcelJS.CellValue;
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function check(b: Book, ref: ImportReference = REF): Promise<CheckedFile> {
  return checkWorkbook(await readWorkbook(await book(b)), ref);
}
const errorsOf = (f: CheckedFile) => f.issues.filter((i) => i.level === "error");
const warningsOf = (f: CheckedFile) => f.issues.filter((i) => i.level === "warning");

/* ------------------------------------------------------------------ */

describe("small readers", () => {
  test("headers are matched by their English first line", () => {
    assert.equal(normalizeHeader("Class (2026–27)\nकक्षा (2026–27)"), "class");
    assert.equal(normalizeHeader("SR No.\nएस.आर. क्रमांक"), "sr no");
    assert.equal(normalizeHeader("Father’s name"), "fathers name");
    assert.equal(normalizeHeader("Guardian's name (if not a parent)"), "guardians name");
    assert.equal(normalizeHeader("Village / address"), "village/address");
    assert.equal(normalizeHeader("Admitted on an RTE seat?"), "admitted on an rte seat");
    assert.equal(normalizeHeader("  Check (automatic) "), "check");
  });

  test("cell values: formulas, rich text, links, errors, blanks", () => {
    assert.equal(toCell({ formula: "A1&B1", result: "Aarav Meena" }), "Aarav Meena");
    assert.equal(toCell({ sharedFormula: "P2", result: "OK" }), "OK");
    assert.equal(toCell({ formula: "A1" }), null, "a formula never calculated counts as empty");
    assert.deepEqual(toCell({ formula: "VLOOKUP(1,A:A,1)", result: { error: "#N/A" } }), { error: "#N/A" });
    assert.equal(toCell({ richText: [{ text: "Aarav " }, { text: "Meena" }] }), "Aarav Meena");
    assert.equal(toCell({ text: "a@b.in", hyperlink: "mailto:a@b.in" }), "a@b.in");
    assert.equal(toCell({ text: { richText: [{ text: "x@y.in" }] }, hyperlink: "mailto:x@y.in" }), "x@y.in");
    assert.deepEqual(toCell({ error: "#VALUE!" }), { error: "#VALUE!" });
    assert.equal(toCell("    "), null);
    assert.equal(toCell("​Palana﻿ "), "Palana");
    assert.equal(toCell(Number.NaN), null);
  });

  test("dates: Excel dates, day numbers and typed text", () => {
    assert.equal(readDate(d(2015, 5, 25)), "2015-05-25");
    assert.equal(readDate(42149), "2015-05-25", "Excel day number (1900 system)");
    assert.equal(readDate(40687, true), "2015-05-25", "Excel day number (1904 system)");
    assert.equal(readDate("25/05/2015"), "2015-05-25");
    assert.equal(readDate("25-05-2015"), "2015-05-25");
    assert.equal(readDate("25.5.2015"), "2015-05-25");
    assert.equal(readDate("2015-05-25"), "2015-05-25");
    assert.equal(readDate(" 25 - 05 - 2015 "), "2015-05-25");
    assert.equal(readDate("31-02-2015"), "invalid");
    assert.equal(readDate("25/05/15"), "invalid", "two-digit years are ambiguous");
    assert.equal(readDate("next week"), "invalid");
    assert.equal(readDate(2015), "invalid", "a bare year is not a date");
    assert.equal(readDate(null), null);
  });

  test("bilingual dropdown values: either half, never two different answers", () => {
    assert.equal(eitherHalf("Boy / बालक", parseGender), "M");
    assert.equal(eitherHalf("Girl / बालिका", parseGender), "F");
    assert.equal(eitherHalf("बालिका", parseGender), "F");
    assert.equal(eitherHalf("Other / अन्य", parseGender), "O");
    assert.equal(eitherHalf("m", parseGender), "M");
    assert.equal(eitherHalf("Boy / Girl", parseGender), "invalid");
    assert.equal(eitherHalf("Yes / हाँ", parseYesNo), true);
    assert.equal(eitherHalf("No / नहीं", parseYesNo), false);
    assert.equal(eitherHalf("नहीं", parseYesNo), false);
    assert.equal(eitherHalf("Yes / No", parseYesNo), "invalid");
    assert.equal(parseAccess("Office admin / कार्यालय प्रशासक"), "office_admin");
    assert.equal(parseAccess("No login / लॉगिन नहीं"), "none");
    assert.equal(parseAccess("लेखा"), "accounts");
    assert.equal(parseAccess("principal"), "principal");
    assert.equal(parseAccess("Principal/Teacher"), "invalid");
    assert.equal(parseAccess("Head clerk"), "invalid");
  });

  test("designations keep the English half; free text stays as typed", () => {
    assert.equal(parseDesignation("Teacher / शिक्षक"), "Teacher");
    assert.equal(parseDesignation("Mother teacher / मदर टीचर"), "Mother teacher");
    assert.equal(parseDesignation("चालक"), "Driver");
    assert.equal(parseDesignation("Lab assistant"), "Lab assistant");
    assert.equal(parseDesignation("PGT / Hindi"), "PGT / Hindi");
  });

  test("class names the way an office types them", () => {
    assert.deepEqual(parseClassCell("5"), { className: "V", section: null });
    assert.deepEqual(parseClassCell("Class 5"), { className: "V", section: null });
    assert.deepEqual(parseClassCell("5th"), { className: "V", section: null });
    assert.deepEqual(parseClassCell("V"), { className: "V", section: null });
    assert.deepEqual(parseClassCell("L.K.G."), { className: "LKG", section: null });
    assert.deepEqual(parseClassCell("11 Arts"), { className: "XI", section: null });
    assert.deepEqual(parseClassCell("5-A"), { className: "V", section: "A" });
    assert.deepEqual(parseClassCell("5b"), { className: "V", section: "B" });
    assert.deepEqual(parseClassCell("XI-C"), { className: "XI", section: "C" });
    assert.deepEqual(parseClassCell("UKG A"), { className: "UKG", section: "A" });
    assert.equal(parseClassCell("13"), "invalid");
    assert.equal(parseClassCell("5-G"), "invalid");
    assert.equal(parseClassCell(null), null);
    assert.deepEqual(parseSectionRefs("5-A"), [{ className: "V", section: "A" }]);
    assert.deepEqual(parseSectionRefs("5"), [{ className: "V", section: "A" }]);
    assert.deepEqual(parseSectionRefs("LKG-A, UKG-B"), [
      { className: "LKG", section: "A" },
      { className: "UKG", section: "B" },
    ]);
    assert.deepEqual(parseSectionRefs("LKG A and UKG A"), [
      { className: "LKG", section: "A" },
      { className: "UKG", section: "A" },
    ]);
    assert.equal(parseSectionRefs("Z-9"), "invalid");
    assert.equal(classListText(REF.classes), "LKG, UKG and 1 to 12");
  });

  test("the zip size guard reads the central directory", async () => {
    const buf = await book({ students: [student(1)] });
    const size = unzippedSize(buf);
    assert.ok(size !== null && size > buf.length, "unzipped size is found and larger than the file");
    assert.equal(unzippedSize(Buffer.from("not a zip at all, just text")), null);
  });
});

describe("whole files", () => {
  test("the real templates open, and an empty one says so", async () => {
    const fs = await import("node:fs");
    const raw = await readWorkbook(fs.readFileSync(ARYA_TEMPLATE));
    assert.equal(raw.students?.headers.length, 16);
    assert.equal(raw.staff?.headers.length, 10);
    assert.equal(raw.students?.rows.length, 0, "rows holding only the Check formula are skipped");
    const f = checkWorkbook(raw, REF);
    assert.deepEqual(f.meta, { hasLists: true, schoolName: "Aryavart Public School", studentPrefix: "Arya", session: "2026-27", templateVersion: 1 });
    assert.equal(errorsOf(f).length, 1);
    assert.match(errorsOf(f)[0].problem, /empty/);
  });

  test("the templates the portal offers for download hold no one's records", async () => {
    // They are served to every office user and published with the code; filled-in copies stay on the office computer.
    const fs = await import("node:fs");
    for (const file of [ARYA_TEMPLATE, AADHAR_TEMPLATE]) {
      const raw = await readWorkbook(fs.readFileSync(file));
      assert.equal(raw.students?.rows.length, 0, file);
      assert.equal(raw.staff?.rows.length, 0, file);
    }
  });

  test("the other school's file is refused before anything else", async () => {
    const fs = await import("node:fs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fs.readFileSync(AADHAR_TEMPLATE) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Students")!;
    student(1201).forEach((v, c) => v !== null && (ws.getRow(2).getCell(c + 1).value = v as ExcelJS.CellValue));
    const f = checkWorkbook(await readWorkbook(Buffer.from(await wb.xlsx.writeBuffer())), REF);
    assert.equal(f.students.length, 0);
    assert.equal(f.issues.length, 1);
    assert.match(f.issues[0].problem, /This file is for Aadharshila Public School, but you're working in Aryavart Public School/);
    const admin = checkWorkbook(await readWorkbook(Buffer.from(await wb.xlsx.writeBuffer())), { ...REF, canSwitchSchool: true });
    assert.match(admin.issues[0].fix ?? "", /switch to Aadharshila Public School at the top of the page/);
  });

  test("a good file: bilingual values, dates in every form, empty rows skipped, Excel row numbers kept", async () => {
    const f = await check({
      students: [
        student(7634, { 3: d(2015, 5, 25), 4: 5, 5: "B", 6: 12, 7: d(2021, 4, 5), 14: "Yes / हाँ" }),
        null,
        student(7635, { 2: "Girl / बालिका", 3: "25/05/2016", 4: "LKG", 5: null, 11: "+91 98765 43210", 12: 9123456780, 14: "No" }),
        student(7636, { 3: 42149, 4: "Class 9", 5: "c", 7: "05-04-2026", 13: "  Kolayat   Road " }),
        null,
        null,
        student(7637, { 4: "5-A", 5: null }),
      ],
      staff: [
        staffRow(12, { 5: "pooja@example.com", 6: "5-A", 7: "Hindi, अंग्रेज़ी", 8: d(2019, 7, 1) }),
        staffRow(13, { 1: "Bhanwar Lal", 2: "चालक", 3: "No login / लॉगिन नहीं", 4: null }),
        staffRow(14, { 2: "Principal / प्रधानाचार्य", 3: "Principal / प्रधानाचार्य", 6: "LKG A, UKG A", 7: "art & drawing" }),
      ],
    });
    assert.deepEqual(errorsOf(f), []);
    assert.deepEqual(f.rows, { students: 4, staff: 3 });
    assert.deepEqual(
      f.students.map((s) => [s.row, s.srNo, s.className, s.section, s.gender, s.dob, s.rte]),
      [
        [2, "7634", "V", "B", "M", "2015-05-25", true],
        [4, "7635", "LKG", null, "F", "2016-05-25", false],
        [5, "7636", "IX", "C", "M", "2015-05-25", false],
        [8, "7637", "V", "A", "M", "2016-05-25", false],
      ],
    );
    const [a, b, c] = f.students;
    assert.equal(a.rollNo, 12);
    assert.equal(a.admittedOn, "2021-04-05");
    assert.equal(b.mobile, "9876543210");
    assert.equal(b.mobile2, "9123456780");
    assert.equal(c.address, "Kolayat Road");
    assert.equal(c.admittedOn, "2026-04-05");
    assert.deepEqual(
      f.staff.map((s) => [s.row, s.empNo, s.designation, s.access, s.mobile]),
      [
        [2, "12", "Teacher", "teacher", "9811111111"],
        [3, "13", "Driver", "none", null],
        [4, "14", "Principal", "principal", "9811111111"],
      ],
    );
    assert.deepEqual(f.staff[0].classTeacherOf, [{ className: "V", section: "A" }]);
    assert.deepEqual(f.staff[0].subjectIds, [SUBJECTS[0].id, SUBJECTS[1].id]);
    assert.equal(f.staff[0].email, "pooja@example.com");
    assert.equal(f.staff[0].joinedOn, "2019-07-01");
    assert.deepEqual(f.staff[1].subjectIds, null, "an empty subjects cell leaves the list alone");
    assert.deepEqual(f.staff[2].classTeacherOf?.length, 2);
    assert.deepEqual(f.staff[2].subjectIds, [SUBJECTS[3].id]);
  });

  test("columns are found by heading, not by position", async () => {
    const order = [4, 0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const f = await check({ studentHeaders: order.map((i) => STUDENT_HEADERS[i]), students: [order.map((i) => student(900)[i] ?? null)] });
    assert.deepEqual(errorsOf(f), []);
    assert.equal(f.students[0].srNo, "900");
    assert.equal(f.students[0].className, "V");
  });

  test("row problems: each with its Excel row, column and a way to fix it", async () => {
    const f = await check({
      students: [
        student(1, { 0: "76a4" }),
        student(2, { 1: "A" }),
        student(3, { 2: "Male/Female" }),
        student(4, { 3: "31-02-2016" }),
        student(5, { 3: d(2025, 1, 1) }),
        student(6, { 4: "Nursery" }),
        student(7, { 4: 13 }),
        student(8, { 5: "G" }),
        student(9, { 6: "12a" }),
        student(10, { 7: d(2027, 1, 1) }),
        student(11, { 7: d(2010, 1, 1) }),
        student(12, { 11: "98765" }),
        student(13, { 11: null }),
        student(14, { 14: null }),
        student(15, { 14: "Maybe" }),
        student(16, { 4: "5-A", 5: "B" }),
        student(17, { 1: { formula: "X1", result: { error: "#N/A" } } }),
        student(18, { 0: null }),
      ],
    });
    const byRow = new Map(errorsOf(f).map((e) => [e.row, e]));
    const expect = (row: number, column: string, problem: RegExp) => {
      const e = byRow.get(row);
      assert.ok(e, `row ${row} has an error`);
      assert.equal(e!.sheet, "Students");
      assert.equal(e!.column, column, `row ${row} column`);
      assert.match(e!.problem, problem);
      assert.ok(e!.fix && e!.fix.length > 10, `row ${row} says how to fix it`);
      assert.ok(e!.letter && /^[A-P]$/.test(e!.letter), `row ${row} gives the column letter`);
    };
    expect(2, "SR No.", /“76a4” isn't a valid SR No/);
    expect(3, "Student's full name", /doesn't look like a name/);
    expect(4, "Gender", /isn't one of the choices/);
    expect(5, "Date of birth", /isn't a date/);
    expect(6, "Date of birth", /1 year old|not yet born|makes the student/);
    expect(7, "Class", /has no Nursery/);
    expect(8, "Class", /“13” isn't a class/);
    expect(9, "Section", /“G” isn't a section/);
    expect(10, "Roll No.", /isn't a roll number/);
    expect(11, "Admission date", /in the future/);
    expect(12, "Admission date", /before the date of birth/);
    expect(13, "Parent's mobile", /isn't a 10-digit mobile/);
    expect(14, "Parent's mobile", /missing/);
    expect(15, "Admitted on an RTE seat?", /empty/);
    expect(16, "Admitted on an RTE seat?", /isn't Yes or No/);
    expect(17, "Section", /says section A but the Section column says B/);
    expect(18, "Student's full name", /Excel error #N\/A/);
    expect(19, "SR No.", /missing/);
    assert.equal(f.students.length, 0, "rows with errors are never imported");
  });

  test("checks across the file: duplicates and class teachers", async () => {
    const f = await check({
      students: [student(7634), student(7635), student(7634, { 1: "Someone Else" }), student(7699, { 1: nameFor(7635) })],
      staff: [staffRow(12, { 6: "5-A" }), staffRow(12, { 1: "Twin" }), staffRow(13, { 6: "V-A" })],
    });
    const errs = errorsOf(f);
    assert.ok(errs.some((e) => e.row === 4 && /SR No\. 7634 is also in row 2/.test(e.problem)));
    assert.ok(errs.some((e) => e.sheet === "Staff" && e.row === 3 && /Employee No\. 12 is also in row 2/.test(e.problem)));
    assert.ok(errs.some((e) => e.sheet === "Staff" && e.row === 4 && /V-A already has a class teacher in row 2/.test(e.problem)));
    assert.ok(
      warningsOf(f).some((w) => w.row === 5 && /Same name and date of birth as row 3/.test(w.problem)),
      "the same child typed twice with a different SR No. is flagged",
    );
  });

  test("staff rules: short subject names, new subjects are added, a class teacher needs a teacher's login, mobile needed to sign in", async () => {
    const f = await check({
      staff: [
        staffRow(1, { 7: "Hindi, Astrology, Maths" }),
        staffRow(2, { 3: "No login / लॉगिन नहीं", 6: "5-A" }),
        staffRow(3, { 3: "Accounts / लेखा", 6: "6-A" }),
        staffRow(4, { 4: null }),
        staffRow(5, { 3: "No login", 4: null }),
        staffRow(6, { 5: "not-an-email" }),
        staffRow(7, { 6: "13-A" }),
        staffRow(8, { 8: d(2090, 1, 1) }),
      ],
    });
    const errs = errorsOf(f);
    const at = (row: number) => errs.filter((e) => e.row === row);
    // "Maths" is Mathematics; "Astrology" isn't a school subject yet, so the import will add it (no error).
    assert.equal(at(2).length, 0, "row 2 has no errors");
    assert.deepEqual((f.newSubjects ?? []).map((s) => s.name), ["Astrology"]);
    assert.deepEqual((f.newSubjects ?? [])[0].rows, [2]);
    assert.match(at(3)[0].problem, /“No login”/);
    assert.match(at(4)[0].problem, /“Accounts”/);
    assert.match(at(5)[0].problem, /mobile number is missing/);
    assert.equal(at(6).length, 0, "no mobile is fine for staff without a login");
    assert.match(at(7)[0].problem, /doesn't look like an email/);
    assert.match(at(8)[0].problem, /has no Class 13|isn't a class/);
    assert.match(at(9)[0].problem, /doesn't look right/);
    assert.deepEqual(
      f.staff.map((s) => s.empNo),
      ["1", "5"],
      "rows without errors are kept: 1 (with a new subject) and 5 (No login, no mobile)",
    );
  });

  test("missing and unknown columns", async () => {
    const f = await check({
      studentHeaders: STUDENT_HEADERS.filter((h) => !h.startsWith("Parent's mobile") && !h.startsWith("Roll No.")).concat("Remarks\nटिप्पणी"),
      students: [[1, "Child One", "Boy", d(2016, 5, 25), 5, "A", null, null, "Ramesh", null, null, null, "Palana", "No", null, "note"]],
    });
    assert.ok(errorsOf(f).some((e) => e.row === 1 && /no “Parent's mobile” column/.test(e.problem)));
    assert.equal(f.students.length, 0);
    const g = await check({
      studentHeaders: STUDENT_HEADERS.filter((h) => !h.startsWith("Roll No.")).concat("Remarks\nटिप्पणी"),
      students: [[1, "Child One", "Boy", d(2016, 5, 25), 5, "A", null, "Ramesh", null, null, "9876543210", null, "Palana", "No", null, "note"]],
    });
    assert.deepEqual(errorsOf(g), []);
    assert.ok(warningsOf(g).some((w) => /treated as empty: Roll No\./.test(w.problem)));
    assert.ok(warningsOf(g).some((w) => /“Remarks” \(column P\)/.test(w.problem)));
  });

  test("no Lists sheet: continue, with a warning", async () => {
    const f = await check({ lists: null, students: [student(1)] });
    assert.deepEqual(errorsOf(f), []);
    assert.equal(f.students.length, 1);
    assert.ok(warningsOf(f).some((w) => w.sheet === "File" && /no hidden “Lists” sheet/.test(w.problem)));
  });

  test("a file made for another session is refused", async () => {
    const f = await check({ lists: { ...LISTS, session: "2025-26" }, students: [student(1)] });
    assert.equal(f.students.length, 0);
    assert.match(errorsOf(f)[0].problem, /made for the 2025-26 session/);
  });

  test("not the template at all", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Fee register").getCell("A1").value = "Receipt";
    const f = checkWorkbook(await readWorkbook(Buffer.from(await wb.xlsx.writeBuffer())), REF);
    assert.match(errorsOf(f)[0].problem, /no “Students” or “Staff” sheet/);
    assert.match(errorsOf(f)[0].fix ?? "", /Fee register/);
    await assert.rejects(readWorkbook(Buffer.from("just some text, not a zip")), /isn't an Excel workbook/);
    await assert.rejects(readWorkbook(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])), /older Excel file/);
  });

  test("more than 2,000 students is refused", async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => student(10_000 + i));
    const f = await check({ students: rows });
    assert.match(errorsOf(f)[0].problem, /2,001 filled rows/);
    assert.equal(f.students.length, 0);
  });
});

describe("crafted files can't stall the server", () => {
  test("a cell's text is cut to MAX_CELL_CHARS", () => {
    const c = toCell("x".repeat(100_000));
    assert.equal(typeof c === "string" && c.length, 2000);
  });
  test("long or tricky class text is refused at once", () => {
    const t = Date.now();
    for (let i = 0; i < 200; i++) {
      assert.equal(parseClassCell("-".repeat(1999) + "x"), "invalid");
      assert.equal(parseSectionRefs("5-A, " + "-".repeat(1999)), "invalid");
    }
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
    assert.deepEqual(parseClassCell("Class XI Arts-A"), { className: "XI", section: "A" });
  });
});

describe("more crafted cells (checked within the size limits)", () => {
  test("a staff file of long subject lists and long emails is refused quickly", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => staffRow(i + 1, { 5: "a@" + ".".repeat(117) + "@", 7: "a,".repeat(1000) }));
    const t = Date.now();
    const f = await check({ staff: rows });
    assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
    assert.ok(errorsOf(f).some((i) => /list of subjects is too long/.test(i.problem)));
    assert.ok(errorsOf(f).some((i) => /look like an email/.test(i.problem)));
  });
  test("one long text repeated in many cells is worked out once", async () => {
    const long = " ".repeat(1990) + "x";
    const rows = Array.from({ length: 2500 }, () => Array.from({ length: 15 }, () => long));
    const buf = await book({ students: rows });
    const t = Date.now();
    await readWorkbook(buf);
    assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
  });
});

describe("repeated rich text and empty rows", () => {
  test("the same rich-text value is worked out once per sheet", async () => {
    const { newCellMemo } = await import("../../lib/services/import");
    const memo = newCellMemo();
    const rich = { richText: [{ text: " ".repeat(3000) }, { text: "x".repeat(30_000) }] };
    const t = Date.now();
    for (let i = 0; i < 100_000; i++) toCell(rich, 0, memo);
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
    const c = toCell(rich, 0, memo);
    assert.ok(typeof c === "string" && c.length > 0 && c.length <= 2000);
  });
});
