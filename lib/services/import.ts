/**
 * Importing students and staff from the portal's Excel template.
 *
 *   upload ──read + check──▶ preview (import_batches, status "previewed")
 *          ──confirm──▶ everything applied in one transaction ("imported")
 *          ──discard, or 24 hours pass──▶ "discarded"
 *
 *  - readWorkbook() turns the .xlsx into plain rows; checkWorkbook() checks
 *    every cell and the file as a whole. Neither touches the database, so
 *    they can be tested on their own. Any error blocks the whole import; the
 *    office fixes the file and uploads it again. Warnings don't block.
 *  - planImport() compares the checked rows with the portal's records: an
 *    SR No. or employee No. already on record is an update, and only filled
 *    cells change anything (an empty optional cell never erases data).
 *    Records not in the file are left alone.
 *  - applyImport() locks the batch row, re-plans against the records as they
 *    are at that moment and applies everything through the record services,
 *    so a batch can only ever be imported once.
 *
 * The checked rows are kept only while the preview waits for confirmation;
 * afterwards the payload is emptied and only counts remain.
 */
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type ExcelJSTypes from "exceljs";
import { getDb, type Tx } from "@/lib/db/client";
import { academicSessions, classes, enrolments, importBatches, schools, sections, staff, staffSubjects, students, subjects } from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { classLabel, normalizeClassName, ROMAN, sectionLabel } from "@/lib/classes";
import { addDays, formatDate, isValidIsoDate } from "@/lib/dates";
import { cleanRegisterNumber } from "@/lib/ids";
import type { StaffAccess } from "@/lib/roles";
import { cleanText, parseDate, parseGender, parseMobile, parseYesNo } from "@/lib/validation";
import { addSubject, createSection, isUuid, SECTION_LETTERS, SUBJECT_LIMITS } from "./classes";
import { currentPlan } from "./fees";
import { accessCanTeach, createStaff, setClassTeacher, setStaffSubjects, touchesAdminAccess, updateStaff, type StaffFields } from "./staff";
import { createStudent, placeStudent, RecordError, updateStudent, type StudentFields } from "./students";
import { checkXlsxZip, XLSX_GUARD_DEFAULTS } from "@/lib/xlsx-guard";

export const IMPORT_LIMITS = {
  /** Largest file accepted (bytes). */
  fileBytes: 5 * 1024 * 1024,
  /** Largest total size of the file's unzipped parts (bytes) — guards against runaway files. */
  unzippedBytes: 20 * 1024 * 1024,
  studentRows: 2000,
  staffRows: 300,
  /** Rows (filled or only formatted) a sheet may have: the template has about 2,000. */
  sheetRows: 20_000,
};

/** A preview waits this long for confirmation before it is discarded. */
export const PREVIEW_HOURS = 24;

export const TEMPLATE_FILES: Record<string, string> = {
  Arya: "/templates/aryavart-portal-import.xlsx",
  Aadhar: "/templates/aadharshila-portal-import.xlsx",
};

/* ================================================================== */
/* Issues                                                              */
/* ================================================================== */

export type IssueLevel = "error" | "warning";
export type IssueSheet = "Students" | "Staff" | "File";

export type ImportIssue = {
  level: IssueLevel;
  sheet: IssueSheet;
  /** The row number as Excel shows it (null for the file as a whole). */
  row: number | null;
  /** The column's heading ("Parent's mobile") and letter ("L"), when the problem is in one cell. */
  column: string | null;
  letter: string | null;
  problem: string;
  fix: string | null;
};

export class ImportFileError extends Error {}
/** The batch can't be confirmed (already imported, discarded, expired, or it has errors). */
export class ImportStateError extends Error {
  constructor(
    message: string,
    public readonly reason: "imported" | "discarded" | "expired" | "blocked" | "changed" | "session",
  ) {
    super(message);
  }
}

/* ================================================================== */
/* Reading the workbook                                                */
/* ================================================================== */

/** A cell's value, simplified: text, number, true/false, a date, or an Excel error. */
export type Cell = string | number | boolean | Date | { error: string } | null;

export type SheetRows = {
  name: string;
  headers: { col: number; letter: string; text: string }[];
  /** Rows with anything in a headed column; `row` is Excel's row number. */
  rows: { row: number; cells: Record<number, Cell> }[];
  /** More rows than the reader keeps (the checker reports it). */
  truncated: boolean;
};

export type WorkbookData = {
  sheetNames: string[];
  students: SheetRows | null;
  staff: SheetRows | null;
  /** key → value from the hidden Lists sheet (null when there is no Lists sheet). */
  lists: Record<string, Cell> | null;
  date1904: boolean;
};

/** Rows the reader keeps per sheet (well above the import limits, so "too many" can be reported). */
const READ_ROW_CAP = 3_000;
const READ_COL_CAP = 60;
/**
 * Longest text kept from one cell. No field needs more (longer values are
 * shortened or refused by their own checks), and it bounds the work each
 * cell can cause: a crafted file can't stall the server with huge cells.
 */
export const MAX_CELL_CHARS = 2000;

export function columnLetter(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const isErrorCell = (c: Cell): c is { error: string } => !!c && typeof c === "object" && !(c instanceof Date) && "error" in c;

/**
 * Simplify an exceljs value: formulas give their result, rich text and links their text.
 * `memo` (one per sheet) remembers what each distinct string and value object gave: Excel
 * stores repeated text once, so a file repeating one long text in every cell costs one pass.
 */
export type CellMemo = { strings: Map<string, Cell>; objects: WeakMap<object, Cell> };
export const newCellMemo = (): CellMemo => ({ strings: new Map(), objects: new WeakMap() });

export function toCell(v: unknown, depth = 0, memo?: CellMemo): Cell {
  if (v === null || v === undefined || depth > 4) return null;
  if (typeof v === "string") {
    const hit = memo?.strings.get(v);
    if (hit !== undefined) return hit;
    const s = v.slice(0, MAX_CELL_CHARS * 2).replace(/[​﻿]/g, "").replace(/ /g, " ").trim().slice(0, MAX_CELL_CHARS);
    const c = s ? s : null;
    if (memo && memo.strings.size < 50_000) memo.strings.set(v, c);
    return c;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { error: "#DATE" } : v;
  if (typeof v === "object") {
    const hit = memo?.objects.get(v);
    if (hit !== undefined) return hit;
    const c = objectCell(v as Record<string, unknown>, depth, memo);
    memo?.objects.set(v, c);
    return c;
  }
  return null;
}

function objectCell(o: Record<string, unknown>, depth: number, memo?: CellMemo): Cell {
  if (typeof o.error === "string") return { error: o.error };
  if (Array.isArray(o.richText)) {
    // Join at most what a cell keeps (the text is cut to MAX_CELL_CHARS anyway).
    let text = "";
    for (const p of o.richText) {
      text += p && typeof p === "object" ? String((p as { text?: unknown }).text ?? "") : "";
      if (text.length > MAX_CELL_CHARS * 2) break;
    }
    return toCell(text, depth + 1, memo);
  }
  if ("formula" in o || "sharedFormula" in o) return toCell(o.result, depth + 1, memo);
  if ("hyperlink" in o || "text" in o) return toCell(o.text ?? o.hyperlink, depth + 1, memo);
  return null;
}

function readSheet(ws: ExcelJSTypes.Worksheet): SheetRows {
  // Excel stores repeated text once: work each distinct value out once, however many cells repeat it.
  const memo = newCellMemo();
  const toCellOnce = (v: unknown): Cell => toCell(v, 0, memo);
  const headers: SheetRows["headers"] = [];
  const top = ws.findRow(1);
  if (top) {
    const lastCol = Math.min(ws.columnCount || top.cellCount, READ_COL_CAP);
    for (let c = 1; c <= lastCol; c++) {
      const v = toCellOnce(top.findCell(c)?.value);
      if (v === null || isErrorCell(v)) continue;
      headers.push({ col: c, letter: columnLetter(c), text: v instanceof Date ? v.toISOString().slice(0, 10) : String(v) });
    }
  }
  const rows: SheetRows["rows"] = [];
  let truncated = false;
  const last = ws.rowCount;
  for (let r = 2; r <= last; r++) {
    const row = ws.findRow(r);
    // findCell (not getCell): looking must not create cells, or a file of empty rows fills the memory.
    if (!row || !row.hasValues) continue;
    const cells: Record<number, Cell> = {};
    let any = false;
    for (const h of headers) {
      const v = toCellOnce(row.findCell(h.col)?.value);
      if (v !== null) {
        cells[h.col] = v;
        any = true;
      }
    }
    if (!any) continue;
    if (rows.length >= READ_ROW_CAP) {
      truncated = true;
      break;
    }
    rows.push({ row: r, cells });
  }
  return { name: ws.name, headers, rows, truncated };
}

/**
 * Total unzipped size of an .xlsx (from the zip's central directory), or
 * null when the file isn't a zip at all. ZIP64 entries count as too large.
 */
export function unzippedSize(buf: Buffer): number | null {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  const min = Math.max(0, buf.length - 22 - 65_535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue;
    const entries = buf.readUInt16LE(i + 10);
    let p = buf.readUInt32LE(i + 16);
    let total = 0;
    for (let e = 0; e < entries; e++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) return null;
      const size = buf.readUInt32LE(p + 24);
      if (size === 0xffffffff) return Number.POSITIVE_INFINITY;
      total += size;
      p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    return total;
  }
  return null;
}

/** Read the Students and Staff sheets and the template's hidden details. Throws ImportFileError for files it can't open. */
export async function readWorkbook(buf: Buffer): Promise<WorkbookData> {
  const head = buf.subarray(0, 8);
  if (head.length >= 4 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    throw new ImportFileError(
      "This is an older Excel file (.xls), or the file has a password. Open it in Excel, remove any password, and use File → Save As → “Excel Workbook (.xlsx)”. Then upload that file.",
    );
  }
  const size = unzippedSize(buf);
  if (size === null) throw new ImportFileError("This file isn't an Excel workbook (.xlsx). Upload the filled-in portal template.");
  if (size > IMPORT_LIMITS.unzippedBytes) {
    throw new ImportFileError("This file is too large to import. Use the portal's template with only the Students and Staff sheets filled in.");
  }
  // The sizes a file declares can't be trusted: unzip every part for real (with a hard cap) before ExcelJS opens it.
  const safe = checkXlsxZip(buf, { maxTotalBytes: Math.min(IMPORT_LIMITS.unzippedBytes, XLSX_GUARD_DEFAULTS.maxTotalBytes), maxRowsPerSheet: IMPORT_LIMITS.sheetRows });
  if (!safe.ok) {
    throw new ImportFileError(
      "The portal couldn't safely open this file — it looks damaged or unusually large. Open it in Excel, save it again as “Excel Workbook (.xlsx)”, and upload it again.",
    );
  }
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new ImportFileError("The portal couldn't open this file. Open it in Excel, save it again as “Excel Workbook (.xlsx)”, and upload it again.");
  }
  const find = (name: string) => wb.worksheets.find((ws) => ws.name.trim().toLowerCase() === name);
  const studentsWs = find("students");
  const staffWs = find("staff");
  const listsWs = find("lists");
  let lists: Record<string, Cell> | null = null;
  if (listsWs) {
    lists = {};
    for (let r = 1; r <= 40; r++) {
      const row = listsWs.findRow(r);
      if (!row) continue;
      const k = toCell(row.getCell(8).value);
      if (typeof k === "string") lists[k.trim().toLowerCase()] = toCell(row.getCell(9).value);
    }
  }
  return {
    sheetNames: wb.worksheets.map((ws) => ws.name),
    students: studentsWs ? readSheet(studentsWs) : null,
    staff: staffWs ? readSheet(staffWs) : null,
    lists,
    date1904: !!wb.properties?.date1904,
  };
}

/* ================================================================== */
/* Checking the rows                                                   */
/* ================================================================== */

export type ImportReference = {
  school: { name: string; loginPrefix: string };
  /** AESRI administrators can switch school at the top of the page. */
  canSwitchSchool: boolean;
  session: { id: string; startsOn: string; endsOn: string };
  today: string;
  classes: { name: string; stream: string | null }[];
  subjects: { id: string; name: string; nameHi: string | null }[];
};

export type CheckedStudent = {
  row: number;
  srNo: string;
  name: string;
  gender: "M" | "F" | "O";
  dob: string;
  className: string;
  /** Null when the Section cell is empty (a new student goes to A; a current one keeps their section). */
  section: string | null;
  rollNo: number | null;
  admittedOn: string | null;
  fatherName: string | null;
  motherName: string | null;
  guardianName: string | null;
  mobile: string;
  mobile2: string | null;
  address: string | null;
  rte: boolean;
};

export type SectionRef = { className: string; section: string };

export type CheckedStaff = {
  row: number;
  empNo: string;
  name: string;
  designation: string;
  access: StaffAccess;
  mobile: string | null;
  email: string | null;
  /** Null when the cell is empty (leave class-teacher duties as they are). */
  classTeacherOf: SectionRef[] | null;
  /** The school's subjects named in the cell. Null when the cell is empty (leave the list as it is). */
  subjectIds: string[] | null;
  /** Subjects named in the cell that the school doesn't have yet (keys of CheckedFile.newSubjects). */
  newSubjects?: string[];
  joinedOn: string | null;
};

/** A subject named in "Subjects taught" that isn't in the school's list yet: the import adds it. */
export type NewSubject = {
  /** Lower-case form of the name, used to match it. */
  key: string;
  name: string;
  nameHi: string | null;
  /** How the file wrote it (each spelling once), e.g. ["Maths", "maths."]. */
  typed: string[];
  /** Staff sheet rows that name it. */
  rows: number[];
};

export type FileMeta = {
  hasLists: boolean;
  schoolName: string | null;
  studentPrefix: string | null;
  session: string | null;
  templateVersion: number | null;
};

export type CheckedFile = {
  version: 1;
  students: CheckedStudent[];
  staff: CheckedStaff[];
  issues: ImportIssue[];
  /** Filled rows read from each sheet (with or without problems). */
  rows: { students: number; staff: number };
  meta: FileMeta;
  /** Subjects the file names that the school doesn't have yet (added by the import). Missing in older previews. */
  newSubjects?: NewSubject[];
};

type ColDef<K extends string> = { key: K; label: string; required: boolean; names: string[] };

type StudentKey = "srNo" | "name" | "gender" | "dob" | "class" | "section" | "rollNo" | "admittedOn" | "father" | "mother" | "guardian" | "mobile" | "mobile2" | "address" | "rte";
type StaffKey = "empNo" | "name" | "designation" | "access" | "mobile" | "email" | "classTeacherOf" | "subjects" | "joinedOn";

const STUDENT_COLUMNS: ColDef<StudentKey>[] = [
  { key: "srNo", label: "SR No.", required: true, names: ["sr no", "srno", "sr number", "s r no"] },
  { key: "name", label: "Student's full name", required: true, names: ["students full name", "student full name", "students name", "student name", "full name", "name"] },
  { key: "gender", label: "Gender", required: true, names: ["gender", "sex"] },
  { key: "dob", label: "Date of birth", required: true, names: ["date of birth", "dob", "birth date"] },
  { key: "class", label: "Class", required: true, names: ["class"] },
  { key: "section", label: "Section", required: false, names: ["section"] },
  { key: "rollNo", label: "Roll No.", required: false, names: ["roll no", "roll number"] },
  { key: "admittedOn", label: "Admission date", required: false, names: ["admission date", "date of admission"] },
  { key: "father", label: "Father's name", required: false, names: ["fathers name", "father name", "father"] },
  { key: "mother", label: "Mother's name", required: false, names: ["mothers name", "mother name", "mother"] },
  { key: "guardian", label: "Guardian's name", required: false, names: ["guardians name", "guardian name", "guardian"] },
  { key: "mobile", label: "Parent's mobile", required: true, names: ["parents mobile", "parent mobile", "mobile", "mobile no", "mobile number"] },
  { key: "mobile2", label: "Second mobile", required: false, names: ["second mobile", "mobile 2", "other mobile"] },
  { key: "address", label: "Village / address", required: false, names: ["village/address", "address", "village"] },
  { key: "rte", label: "Admitted on an RTE seat?", required: true, names: ["admitted on an rte seat", "rte seat", "rte"] },
];

const STAFF_COLUMNS: ColDef<StaffKey>[] = [
  { key: "empNo", label: "Employee No.", required: true, names: ["employee no", "emp no", "employee number"] },
  { key: "name", label: "Full name", required: true, names: ["full name", "name", "staff name"] },
  { key: "designation", label: "Designation", required: true, names: ["designation", "post"] },
  { key: "access", label: "Portal access", required: true, names: ["portal access", "access"] },
  { key: "mobile", label: "Mobile", required: true, names: ["mobile", "mobile no", "mobile number"] },
  { key: "email", label: "Email", required: false, names: ["email", "e-mail", "email address"] },
  { key: "classTeacherOf", label: "Class teacher of", required: false, names: ["class teacher of", "class teacher"] },
  { key: "subjects", label: "Subjects taught", required: false, names: ["subjects taught", "subjects"] },
  { key: "joinedOn", label: "Date of joining", required: false, names: ["date of joining", "joining date", "joined on"] },
];

/** Columns the portal fills in or doesn't use. */
const IGNORED_HEADERS = ["check"];

/** "Class (2026–27)\nकक्षा" → "class"; "Father's name" → "fathers name". */
export function normalizeHeader(text: string): string {
  return (text.split(/\r?\n/)[0] ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\([^()]*\)/g, " ")
    .replace(/[.'’‘`?*:"]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

type Mapped<K extends string> = { cols: Partial<Record<K, { col: number; letter: string }>>; defs: ColDef<K>[] };

function mapHeaders<K extends string>(sheet: SheetRows, defs: ColDef<K>[], sheetLabel: "Students" | "Staff", issues: ImportIssue[]): Mapped<K> | null {
  const cols: Partial<Record<K, { col: number; letter: string }>> = {};
  const ignored: string[] = [];
  for (const h of sheet.headers) {
    const norm = normalizeHeader(h.text);
    if (!norm || IGNORED_HEADERS.includes(norm)) continue;
    const def = defs.find((d) => d.names.includes(norm));
    if (!def) {
      ignored.push(`“${h.text.split(/\r?\n/)[0].trim()}” (column ${h.letter})`);
      continue;
    }
    if (cols[def.key]) {
      issues.push({
        level: "warning",
        sheet: sheetLabel,
        row: 1,
        column: def.label,
        letter: h.letter,
        problem: `There are two “${def.label}” columns. Only the first (column ${cols[def.key]!.letter}) is used.`,
        fix: "Delete the extra column if it isn't needed.",
      });
      continue;
    }
    cols[def.key] = { col: h.col, letter: h.letter };
  }
  const missingRequired = defs.filter((d) => d.required && !cols[d.key]);
  for (const d of missingRequired) {
    issues.push({
      level: "error",
      sheet: sheetLabel,
      row: 1,
      column: d.label,
      letter: null,
      problem: `The ${sheetLabel} sheet has no “${d.label}” column.`,
      fix: "Use the portal's template, and keep the headings in row 1 as they are.",
    });
  }
  const missingOptional = defs.filter((d) => !d.required && !cols[d.key]);
  if (!missingRequired.length && missingOptional.length) {
    issues.push({
      level: "warning",
      sheet: sheetLabel,
      row: 1,
      column: null,
      letter: null,
      problem: `These columns weren't found, so they are treated as empty: ${missingOptional.map((d) => d.label).join(", ")}.`,
      fix: "If you meant to fill them, use the portal's template and keep the headings as they are.",
    });
  }
  if (ignored.length) {
    issues.push({
      level: "warning",
      sheet: sheetLabel,
      row: 1,
      column: null,
      letter: null,
      problem: `The portal doesn't use ${ignored.length === 1 ? "this column" : "these columns"}, so ${ignored.length === 1 ? "it was" : "they were"} skipped: ${ignored.join(", ")}.`,
      fix: "Nothing to do if that's expected. If it holds data the portal needs, check that the heading matches the template.",
    });
  }
  return missingRequired.length ? null : { cols, defs };
}

/* ---------------- small value readers ---------------- */

/** Text of a cell (numbers without a trailing ".0", dates as YYYY-MM-DD). */
function asText(c: Cell): string | null {
  if (c === null || isErrorCell(c)) return null;
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  if (typeof c === "number") return String(c);
  if (typeof c === "boolean") return c ? "TRUE" : "FALSE";
  const s = c.replace(/\s+/g, " ").trim();
  return s || null;
}

/** For messages: what the cell holds, shortened. */
function shown(c: Cell): string {
  const s = asText(c) ?? "";
  return s.length > 40 ? `${s.slice(0, 37)}…` : s;
}

/** Excel serial day numbers (dates in a cell formatted as a plain number): 1950 to 2100 only. */
function serialToIso(n: number, date1904: boolean): string | null {
  if (!Number.isFinite(n)) return null;
  const whole = Math.floor(n);
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const iso = new Date(base + whole * 86_400_000).toISOString().slice(0, 10);
  return iso >= "1950-01-01" && iso <= "2100-12-31" ? iso : null;
}

/** A date from an Excel date, an Excel day number, or text such as 25-05-2015. */
export function readDate(c: Cell, date1904 = false): string | null | "invalid" {
  if (c === null) return null;
  if (isErrorCell(c)) return "invalid";
  if (c instanceof Date) {
    const iso = c.toISOString().slice(0, 10);
    return iso >= "1900-01-01" && iso <= "2100-12-31" ? iso : "invalid";
  }
  if (typeof c === "number") return serialToIso(c, date1904) ?? "invalid";
  if (typeof c === "boolean") return "invalid";
  const r = parseDate(c.replace(/\s+/g, ""));
  if (r === "invalid" || r === null) return r;
  return r >= "1900-01-01" && r <= "2100-12-31" ? r : "invalid";
}

/**
 * Read a bilingual dropdown value ("Boy / बालक") with a parser that knows
 * single words: either half may be typed on its own. Halves that disagree
 * ("Boy / Girl") are not a choice.
 */
export function eitherHalf<T>(text: string, parse: (s: string) => T | null | "invalid"): T | null | "invalid" {
  const whole = parse(text);
  if (whole !== null && whole !== "invalid") return whole;
  const parts = text
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return whole;
  const found = parts.map(parse).filter((r): r is T => r !== null && r !== "invalid");
  if (!found.length || found.some((r) => r !== found[0])) return "invalid";
  return found[0];
}

const hasDevanagari = (s: string) => /[ऀ-ॿ]/.test(s);

/** Everyday ways of writing portal access, in English and Hindi. */
const ACCESS_WORDS: Record<string, StaffAccess> = {
  teacher: "teacher",
  शिक्षक: "teacher",
  "office admin": "office_admin",
  "office administrator": "office_admin",
  office: "office_admin",
  admin: "office_admin",
  "कार्यालय प्रशासक": "office_admin",
  principal: "principal",
  प्रधानाचार्य: "principal",
  accounts: "accounts",
  accountant: "accounts",
  लेखा: "accounts",
  "no login": "none",
  none: "none",
  no: "none",
  "लॉगिन नहीं": "none",
};

export function parseAccess(text: string | null): StaffAccess | null | "invalid" {
  if (!text) return null;
  return eitherHalf(text, (s) => ACCESS_WORDS[s.toLowerCase().replace(/\s+/g, " ").trim()] ?? "invalid");
}

/** The template's designations, for turning a Hindi-only entry into English. */
const DESIGNATIONS: [string, string][] = [
  ["Principal", "प्रधानाचार्य"],
  ["Teacher", "शिक्षक"],
  ["Mother teacher", "मदर टीचर"],
  ["Office staff", "कार्यालय कर्मचारी"],
  ["Accountant", "लेखाकार"],
  ["Director", "निदेशक"],
  ["Driver", "चालक"],
  ["Helper", "सहायक"],
  ["Other", "अन्य"],
];

/** "Teacher / शिक्षक" → "Teacher"; free text is kept as typed. */
export function parseDesignation(text: string | null): string | null {
  if (!text) return null;
  const parts = text.split("/").map((p) => p.trim());
  let english = text.trim();
  if (parts.length === 2 && parts[0] && hasDevanagari(parts[1]) && !hasDevanagari(parts[0])) english = parts[0];
  const known = DESIGNATIONS.find(([en, hi]) => en.toLowerCase() === english.toLowerCase() || hi === english);
  return cleanText(known ? known[0] : english, 60);
}

/** "5", "V", "LKG", "Class 5" → the class name; "5A" and "5-A" also give section A. */
export function parseClassCell(text: string | null): { className: string; section: string | null } | null | "invalid" {
  if (!text) return null;
  // A class is a few characters ("Class XI Arts-A"); a long value can't be one, and the pattern below slows down on long text.
  if (text.trim().length > 40) return "invalid";
  const direct = normalizeClassName(text);
  if (direct) return { className: direct, section: null };
  const m = /^(.*?)[\s\-/.]*([A-Fa-f])$/.exec(text.trim());
  if (m && m[1]) {
    const n = normalizeClassName(m[1]);
    if (n) return { className: n, section: m[2].toUpperCase() };
  }
  return "invalid";
}

export function parseSectionCell(text: string | null): string | null | "invalid" {
  if (!text) return null;
  if (text.trim().length > 20) return "invalid";
  const m = /^(?:sec(?:tion)?\.?\s*)?([A-Fa-f])$/.exec(text.trim());
  return m ? m[1].toUpperCase() : "invalid";
}

/** "5-A", "5A", "V-A", "LKG-A", or "5" (section A). Several can be separated by commas. */
export function parseSectionRefs(text: string | null): SectionRef[] | null | "invalid" {
  if (!text) return null;
  if (text.length > 500) return "invalid";
  const out: SectionRef[] = [];
  for (const part of text
    .split(/[,;\n]|\band\b|&/i)
    .map((p) => p.trim())
    .filter(Boolean)) {
    const c = parseClassCell(part);
    if (!c || c === "invalid") return "invalid";
    const ref = { className: c.className, section: c.section ?? "A" };
    if (!out.some((o) => o.className === ref.className && o.section === ref.section)) out.push(ref);
  }
  return out.length ? out : null;
}

/** Whole numbers only (12, "12", 12.0). */
function wholeNumber(c: Cell): number | null | "invalid" {
  if (c === null) return null;
  if (typeof c === "number") return Number.isInteger(c) ? c : "invalid";
  const s = asText(c);
  if (!s) return null;
  if (!/^\d{1,6}(\.0+)?$/.test(s)) return "invalid";
  return Number(s.replace(/\.0+$/, ""));
}

function registerNumber(c: Cell): string | null | "invalid" {
  if (c === null) return null;
  const s = asText(c);
  if (!s) return null;
  const n = cleanRegisterNumber(s);
  return n && n !== "0" ? n : "invalid";
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

/** Age in whole years on a given day. */
function ageOn(dob: string, on: string): number {
  const [y, m, d] = dob.split("-").map(Number);
  const [y2, m2, d2] = on.split("-").map(Number);
  return y2 - y - (m2 < m || (m2 === m && d2 < d) ? 1 : 0);
}

/** "LKG, UKG and 1 to 12" — how the office writes this school's classes. */
export function classListText(list: { name: string }[]): string {
  const named = list.filter((c) => !ROMAN.includes(c.name)).map((c) => c.name);
  const nums = list
    .map((c) => ROMAN.indexOf(c.name))
    .filter((i) => i >= 0)
    .map((i) => i + 1)
    .sort((a, b) => a - b);
  const range = nums.length ? (nums.length === 1 ? String(nums[0]) : `${nums[0]} to ${nums[nums.length - 1]}`) : "";
  return [named.join(", "), range].filter(Boolean).join(" and ");
}

/** Letters in a name, ignoring case and spacing ("Aarav  Meena" = "aarav meena"). */
const nameKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}]+/gu, " ").trim();

/* ---------------- the checks ---------------- */

type RowCtx = { sheet: "Students" | "Staff"; row: number; issues: ImportIssue[]; bad: boolean };

function problem(ctx: RowCtx, level: IssueLevel, col: { label: string; letter?: string | null } | null, text: string, fix: string | null) {
  ctx.issues.push({ level, sheet: ctx.sheet, row: ctx.row, column: col?.label ?? null, letter: col?.letter ?? null, problem: text, fix });
  if (level === "error") ctx.bad = true;
}

/** Check a whole workbook against the school's classes and subjects. Pure: no database. */
export function checkWorkbook(wb: WorkbookData, ref: ImportReference): CheckedFile {
  const issues: ImportIssue[] = [];
  const lists = wb.lists;
  const metaText = (k: string) => {
    const v = lists?.[k];
    return v === undefined || v === null ? null : asText(v);
  };
  const tv = lists?.template_version;
  const meta: FileMeta = {
    hasLists: !!lists,
    schoolName: metaText("school_name"),
    studentPrefix: metaText("student_login_prefix"),
    session: metaText("session"),
    templateVersion: typeof tv === "number" ? tv : typeof tv === "string" && /^\d+$/.test(tv) ? Number(tv) : null,
  };
  const out: CheckedFile = { version: 1, students: [], staff: [], issues, rows: { students: 0, staff: 0 }, meta };
  const fileError = (text: string, fix: string | null) => issues.push({ level: "error", sheet: "File", row: null, column: null, letter: null, problem: text, fix });

  // Is this the right school's file, for this session?
  if (meta.studentPrefix && meta.studentPrefix.toLowerCase() !== ref.school.loginPrefix.toLowerCase()) {
    const other = meta.schoolName ?? `the school whose logins start with “${meta.studentPrefix}”`;
    fileError(
      `This file is for ${other}, but you're working in ${ref.school.name}. Nothing from it can be imported here.`,
      ref.canSwitchSchool
        ? `Upload ${ref.school.name}'s file, or switch to ${other} at the top of the page and upload it there.`
        : `Upload ${ref.school.name}'s file (download the template on the import page).`,
    );
    return out;
  }
  if (!lists) {
    issues.push({
      level: "warning",
      sheet: "File",
      row: null,
      column: null,
      letter: null,
      problem: `This file has no hidden “Lists” sheet, so the portal can't confirm it was made for ${ref.school.name}.`,
      fix: `Check that every student and staff member in it belongs to ${ref.school.name}.`,
    });
  } else if (meta.session && meta.session !== ref.session.id) {
    fileError(
      `This file was made for the ${meta.session} session, but the portal is working in the ${ref.session.id} session.`,
      "Download this session's template from the import page, copy your rows into it, and upload that.",
    );
    return out;
  }
  if (!wb.students && !wb.staff) {
    fileError(
      "This doesn't look like the portal's import file: it has no “Students” or “Staff” sheet.",
      `Download the template from the import page, fill it in and upload it. (Sheets found: ${wb.sheetNames.slice(0, 6).join(", ") || "none"}.)`,
    );
    return out;
  }
  for (const [sheet, name] of [
    [wb.students, "Students"],
    [wb.staff, "Staff"],
  ] as const) {
    if (!sheet) {
      issues.push({
        level: "warning",
        sheet: "File",
        row: null,
        column: null,
        letter: null,
        problem: `There is no “${name}” sheet, so no ${name === "Students" ? "students" : "staff"} will be imported.`,
        fix: "If that's not what you meant, check the sheet names at the bottom of the Excel window: they must stay as in the template.",
      });
    }
  }
  out.students = wb.students ? checkStudents(wb.students, ref, wb.date1904, issues, out) : [];
  out.staff = wb.staff ? checkStaff(wb.staff, ref, wb.date1904, issues, out) : [];
  if (wb.students && wb.staff && !out.rows.students && !out.rows.staff && !issues.some((i) => i.level === "error")) {
    fileError("The Students and Staff sheets are empty.", "Type one row per student and per staff member, starting in row 2, then upload the file again.");
  }
  return out;
}

function checkStudents(sheet: SheetRows, ref: ImportReference, date1904: boolean, issues: ImportIssue[], out: CheckedFile): CheckedStudent[] {
  const mapped = mapHeaders(sheet, STUDENT_COLUMNS, "Students", issues);
  if (!mapped) return [];
  const col = (k: StudentKey) => {
    const d = STUDENT_COLUMNS.find((x) => x.key === k)!;
    return { label: d.label, letter: mapped.cols[k]?.letter ?? null };
  };
  const dataRows = sheet.rows.filter((r) => STUDENT_COLUMNS.some((d) => mapped.cols[d.key] && r.cells[mapped.cols[d.key]!.col] !== undefined));
  out.rows.students = dataRows.length;
  if (dataRows.length > IMPORT_LIMITS.studentRows || sheet.truncated) {
    issues.push({
      level: "error",
      sheet: "Students",
      row: null,
      column: null,
      letter: null,
      problem: `The Students sheet has ${sheet.truncated ? "more than " : ""}${dataRows.length.toLocaleString("en-IN")} filled rows. The portal imports up to ${IMPORT_LIMITS.studentRows.toLocaleString("en-IN")} students at a time.`,
      fix: "Split the students into two files (for example by class) and import them one after the other.",
    });
    return [];
  }
  const classNames = new Map(ref.classes.map((c) => [c.name, c]));
  const classesText = classListText(ref.classes);
  const result: CheckedStudent[] = [];
  const seenSr = new Map<string, number>();
  const seenPerson = new Map<string, { row: number; srNo: string }>();

  for (const r of dataRows) {
    const ctx: RowCtx = { sheet: "Students", row: r.row, issues, bad: false };
    const cell = (k: StudentKey): Cell => {
      const m = mapped.cols[k];
      return m ? (r.cells[m.col] ?? null) : null;
    };
    // Cells showing an Excel error (#N/A, #VALUE!…) are reported once and treated as unreadable.
    const broken = new Set<StudentKey>();
    for (const d of STUDENT_COLUMNS) {
      const v = cell(d.key);
      if (isErrorCell(v)) {
        broken.add(d.key);
        problem(ctx, "error", col(d.key), `The cell shows the Excel error ${v.error}.`, "Type the value itself instead of a formula.");
      }
    }
    const val = (k: StudentKey) => (broken.has(k) ? null : cell(k));

    // SR No.
    const srRaw = val("srNo");
    const srNo = registerNumber(srRaw);
    if (srNo === null) {
      if (!broken.has("srNo")) problem(ctx, "error", col("srNo"), "The SR No. is missing.", "Type the student's number from the SR register, for example 7634.");
    } else if (srNo === "invalid") {
      problem(ctx, "error", col("srNo"), `“${shown(srRaw)}” isn't a valid SR No.`, "Use the number from the SR register: digits only, for example 7634.");
    } else if (seenSr.has(srNo)) {
      problem(ctx, "error", col("srNo"), `SR No. ${srNo} is also in row ${seenSr.get(srNo)}.`, "Each student has their own SR No. Check the register and correct one of the two rows.");
    } else {
      seenSr.set(srNo, r.row);
    }

    // Name
    const name = cleanText(asText(val("name")), 200);
    if (!name) {
      if (!broken.has("name")) problem(ctx, "error", col("name"), "The student's name is missing.", "Type the full name as in the SR register.");
    } else if (name.length < 2 || name.length > 80 || !/\p{L}/u.test(name)) {
      problem(ctx, "error", col("name"), name.length > 80 ? "The name is longer than 80 characters." : `“${shown(name)}” doesn't look like a name.`, "Type the full name as in the SR register (2 to 80 characters).");
    }

    // Gender
    const gRaw = asText(val("gender"));
    const gender = gRaw ? eitherHalf(gRaw, parseGender) : null;
    if (gender === null) {
      if (!broken.has("gender")) problem(ctx, "error", col("gender"), "Gender is missing.", "Choose Boy, Girl or Other from the list.");
    } else if (gender === "invalid") {
      problem(ctx, "error", col("gender"), `“${shown(gRaw)}” isn't one of the choices.`, "Choose Boy, Girl or Other from the list.");
    }

    // Date of birth: a child of 2 to 22 on the first day of the session.
    const dobRaw = val("dob");
    const dob = readDate(dobRaw, date1904);
    if (dob === null) {
      if (!broken.has("dob")) problem(ctx, "error", col("dob"), "The date of birth is missing.", "Type it as DD-MM-YYYY, for example 25-05-2015.");
    } else if (dob === "invalid") {
      problem(ctx, "error", col("dob"), `“${shown(dobRaw)}” isn't a date the portal can read.`, "Type it as DD-MM-YYYY, for example 25-05-2015.");
    } else {
      const age = ageOn(dob, ref.session.startsOn);
      if (age < 2 || age > 22) {
        problem(
          ctx,
          "error",
          col("dob"),
          `A date of birth of ${formatDate(dob)} makes the student ${age < 0 ? "not yet born" : `${age} ${age === 1 ? "year" : "years"} old`} on ${formatDate(ref.session.startsOn)}.`,
          "Students must be 2 to 22 years old. Check the year, and the order of day and month (DD-MM-YYYY).",
        );
      }
    }

    // Class (may carry the section: "5-A")
    const clsText = asText(val("class"));
    const cls = parseClassCell(clsText);
    let className: string | null = null;
    let sectionFromClass: string | null = null;
    if (cls === null) {
      if (!broken.has("class")) problem(ctx, "error", col("class"), "The class is missing.", `Choose the class for ${ref.session.id} from the list: ${classesText}.`);
    } else if (cls === "invalid" || !classNames.has(cls.className)) {
      problem(
        ctx,
        "error",
        col("class"),
        cls !== "invalid" ? `${ref.school.name} has no ${classLabel(cls.className)}.` : `“${shown(clsText)}” isn't a class the portal knows.`,
        `Choose from the list: ${classesText}. Put the section (A to F) in the Section column.`,
      );
    } else {
      className = cls.className;
      sectionFromClass = cls.section;
    }

    // Section
    const secText = asText(val("section"));
    let section = parseSectionCell(secText);
    if (section === "invalid") {
      problem(ctx, "error", col("section"), `“${shown(secText)}” isn't a section.`, "Use a letter from A to F, or leave it empty for section A.");
      section = null;
    } else if (sectionFromClass && section && section !== sectionFromClass) {
      problem(ctx, "error", col("section"), `The Class column says section ${sectionFromClass} but the Section column says ${section}.`, "Put only the class in the Class column, and the section in the Section column.");
    }
    const finalSection = section ?? sectionFromClass;

    // Roll No.
    const rollRaw = val("rollNo");
    const rollNo = wholeNumber(rollRaw);
    if (rollNo === "invalid" || (typeof rollNo === "number" && (rollNo < 1 || rollNo > 999))) {
      problem(ctx, "error", col("rollNo"), `“${shown(rollRaw)}” isn't a roll number.`, "Use a whole number from 1 to 999, or leave it empty.");
    }

    // Admission date
    const admRaw = val("admittedOn");
    const admittedOn = readDate(admRaw, date1904);
    if (admittedOn === "invalid") {
      problem(ctx, "error", col("admittedOn"), `“${shown(admRaw)}” isn't a date the portal can read.`, "Type it as DD-MM-YYYY, for example 05-04-2021, or leave it empty.");
    } else if (admittedOn && admittedOn > ref.today) {
      problem(ctx, "error", col("admittedOn"), `The admission date ${formatDate(admittedOn)} is in the future.`, "Use the date the student was admitted, as in the SR register.");
    } else if (admittedOn && typeof dob === "string" && dob !== "invalid" && admittedOn < dob) {
      problem(ctx, "error", col("admittedOn"), "The admission date is before the date of birth.", "Check both dates (DD-MM-YYYY).");
    }

    // Parents
    const person = (k: "father" | "mother" | "guardian") => {
      const v = cleanText(asText(val(k)), 200);
      if (v && (v.length < 2 || v.length > 80 || !/\p{L}/u.test(v))) {
        problem(ctx, "error", col(k), v.length > 80 ? "The name is longer than 80 characters." : `“${shown(v)}” doesn't look like a name.`, "Type the full name (2 to 80 characters), or leave it empty.");
        return null;
      }
      return v;
    };
    const fatherName = person("father");
    const motherName = person("mother");
    const guardianName = person("guardian");

    // Mobiles
    const mobRaw = val("mobile");
    const mobile = parseMobile(asText(mobRaw));
    if (mobile === null) {
      if (!broken.has("mobile")) problem(ctx, "error", col("mobile"), "The parent's mobile number is missing.", "Type the 10-digit mobile of the parent who will use the portal.");
    } else if (mobile === "invalid") {
      problem(ctx, "error", col("mobile"), `“${shown(mobRaw)}” isn't a 10-digit mobile number.`, "Type 10 digits starting with 6, 7, 8 or 9, for example 9876543210.");
    }
    const mob2Raw = val("mobile2");
    const mobile2 = parseMobile(asText(mob2Raw));
    if (mobile2 === "invalid") {
      problem(ctx, "error", col("mobile2"), `“${shown(mob2Raw)}” isn't a 10-digit mobile number.`, "Type 10 digits starting with 6, 7, 8 or 9, or leave it empty.");
    }

    // Address
    const addrFull = cleanText(asText(val("address")), 10_000);
    const address = addrFull ? addrFull.slice(0, 200) : null;
    if (addrFull && addrFull.length > 200) problem(ctx, "warning", col("address"), "The address is longer than 200 characters and will be shortened.", "Shorten it in the file if you'd like to choose what is kept.");

    // RTE
    const rteText = asText(val("rte"));
    const rte = rteText ? eitherHalf(rteText, (s) => (s ? parseYesNo(s) : null)) : null;
    if (rte === null) {
      if (!broken.has("rte")) problem(ctx, "error", col("rte"), "“Admitted on an RTE seat?” is empty.", "Choose Yes or No from the list.");
    } else if (rte === "invalid") {
      problem(ctx, "error", col("rte"), `“${shown(rteText)}” isn't Yes or No.`, "Choose Yes or No from the list.");
    }

    if (ctx.bad || !srNo || srNo === "invalid" || !name || !gender || gender === "invalid" || !dob || dob === "invalid" || !className) continue;
    if (!mobile || mobile === "invalid" || rte === null || rte === "invalid") continue;

    // The same child typed twice (with different SR numbers)?
    const personKey = `${nameKey(name)}|${dob}`;
    const twin = seenPerson.get(personKey);
    if (twin) {
      problem(ctx, "warning", col("name"), `Same name and date of birth as row ${twin.row} (SR No. ${twin.srNo}).`, "If it's the same child entered twice, delete one of the rows.");
    } else {
      seenPerson.set(personKey, { row: r.row, srNo });
    }

    result.push({
      row: r.row,
      srNo,
      name,
      gender,
      dob,
      className,
      section: finalSection,
      rollNo: typeof rollNo === "number" ? rollNo : null,
      admittedOn: admittedOn && admittedOn !== "invalid" ? admittedOn : null,
      fatherName,
      motherName,
      guardianName,
      mobile,
      mobile2: mobile2 && mobile2 !== "invalid" ? mobile2 : null,
      address,
      rte,
    });
  }
  return result;
}

/* ---------------- subjects ---------------- */

/**
 * Subjects schools often write in a short form. `names`: proper names a
 * school's list may use (the first is added when the school has none of
 * them); `short`: short forms and Latin spellings; `hi`: Hindi names. A
 * short form only ever maps to a subject the school has — or, when it has
 * none of these names, the first name is added to its list.
 */
type KnownSubject = { names: string[]; short: string[]; hi: string[] };

export const KNOWN_SUBJECTS: KnownSubject[] = [
  { names: ["Mathematics"], short: ["maths", "math", "mat", "mths", "ganit"], hi: ["गणित"] },
  { names: ["English"], short: ["eng", "engl", "angrezi", "angreji"], hi: ["अंग्रेज़ी"] },
  { names: ["Hindi"], short: ["hin", "hind"], hi: ["हिंदी", "हिन्दी"] },
  { names: ["Sanskrit"], short: ["skt", "sans", "sansk"], hi: ["संस्कृत"] },
  { names: ["Science", "General Science"], short: ["sci", "sc", "gen sci", "vigyan"], hi: ["विज्ञान"] },
  { names: ["Social Science", "Social Studies", "Social Sciences"], short: ["sst", "social", "soc sci", "social sc", "samajik vigyan"], hi: ["सामाजिक विज्ञान", "सामाजिक अध्ययन"] },
  {
    names: ["Environmental Studies", "Environmental Education", "Environmental Science", "Environment Studies"],
    short: ["evs", "env", "environment", "paryavaran"],
    hi: ["पर्यावरण अध्ययन", "पर्यावरण शिक्षा"],
  },
  { names: ["General Knowledge"], short: ["gk", "gen knowledge", "samanya gyan"], hi: ["सामान्य ज्ञान"] },
  {
    names: ["Computer Science", "Computer Studies", "Computer Education", "Computer Applications"],
    short: ["comp", "comps", "computer", "computers", "cs", "comp sci", "computer sc"],
    hi: ["कंप्यूटर विज्ञान", "कंप्यूटर", "कम्प्यूटर"],
  },
  { names: ["Information Technology"], short: ["it", "info tech"], hi: ["सूचना प्रौद्योगिकी"] },
  { names: ["Art & Drawing", "Drawing", "Art", "Art & Craft", "Drawing & Painting", "Fine Arts"], short: ["drg"], hi: ["कला एवं चित्रकला", "चित्रकला"] },
  {
    names: ["Physical Education", "Physical Health & Education", "Health & Physical Education", "Sports"],
    short: ["pe", "pt", "phy ed", "phys ed", "hpe", "games"],
    hi: ["शारीरिक शिक्षा", "शारीरिक स्वास्थ्य एवं शिक्षा"],
  },
  { names: ["Socially Useful & Productive Work", "Work Experience"], short: ["supw", "work exp"], hi: ["समाजोपयोगी उत्पादक कार्य"] },
  { names: ["Moral Science", "Moral Education", "Value Education"], short: ["moral"], hi: ["नैतिक शिक्षा"] },
  { names: ["History"], short: ["hist", "itihas"], hi: ["इतिहास"] },
  { names: ["Geography"], short: ["geo", "geog", "bhugol"], hi: ["भूगोल"] },
  { names: ["Political Science"], short: ["pol sci", "polsci", "pol science", "political sc", "rajniti vigyan"], hi: ["राजनीति विज्ञान"] },
  { names: ["Economics"], short: ["eco", "econ", "arthshastra"], hi: ["अर्थशास्त्र"] },
  { names: ["Music"], short: ["sangeet"], hi: ["संगीत"] },
  { names: ["Home Science"], short: ["home sc", "h sc"], hi: ["गृह विज्ञान"] },
  { names: ["Physics"], short: ["phy", "phys"], hi: ["भौतिक विज्ञान"] },
  { names: ["Chemistry"], short: ["chem"], hi: ["रसायन विज्ञान"] },
  { names: ["Biology"], short: ["bio"], hi: ["जीव विज्ञान"] },
];

/** A subject name for matching: "G.K." → "gk", "Art & Drawing" → "art and drawing"; Hindi without the nukta dot. */
export function subjectKey(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/़/g, "")
    .replace(/&/g, " and ")
    .replace(/[.'’‘`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const compact = (s: string) => subjectKey(s).replace(/[\s-]/g, "");

/**
 * How many single-letter slips (a letter added, left out, changed, or two
 * swapped) turn one word into another. Stops counting past `max`.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], before[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    before = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** A subject named in a cell: one of the school's, or one to add. */
type SubjectHit = { kind: "existing"; id: string } | { kind: "new"; name: string; nameHi: string | null; typed: string };

const hasLatin = (s: string) => /[A-Za-z]/.test(s);

/** "music" → "Music"; words typed in capitals or mixed case stay as they are. */
function tidySubjectName(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t === t.toLowerCase() ? t.replace(/(^|[\s(&/-])(\p{Ll})/gu, (_m, p: string, c: string) => p + c.toUpperCase()) : t;
}

/**
 * Read a "Subjects taught" cell: "Hindi, Maths, EVS", "हिंदी / Hindi",
 * "Music". Each subject is matched to the school's list (English or Hindi
 * name, or a common short form such as Maths → Mathematics); a subject the
 * school doesn't have becomes one to add. `bad`: parts that can't be a
 * subject name (too short or too long), exactly as the file wrote them.
 */
/** The known subjects' comparison keys, worked out once (not again for every name typed in every row). */
let knownKeys: { k: KnownSubject; names: string[]; short: string[]; hi: string[] }[] | null = null;
function knownSubjectKeys() {
  knownKeys ??= KNOWN_SUBJECTS.map((k) => ({ k, names: k.names.map(compact), short: k.short.map(compact), hi: k.hi.map(subjectKey) }));
  return knownKeys;
}

export function matchSubjects(text: string, list: ImportReference["subjects"]): { hits: SubjectHit[]; bad: string[] } {
  const byKey = new Map<string, string>();
  for (const s of list) {
    byKey.set(subjectKey(s.name), s.id);
    if (s.nameHi) byKey.set(subjectKey(s.nameHi), s.id);
  }
  const existingFor = (k: KnownSubject) => {
    for (const n of [...k.names, ...k.hi]) {
      const id = byKey.get(subjectKey(n));
      if (id) return id;
    }
    return null;
  };
  /** One subject name, or null when it is neither the school's nor a known short form. */
  const resolve = (typed: string): SubjectHit | null => {
    const key = subjectKey(typed);
    const own = byKey.get(key);
    if (own) return { kind: "existing", id: own };
    const c = compact(typed);
    for (const { k, names, short, hi } of knownSubjectKeys()) {
      const at = names.indexOf(c);
      const asName = at >= 0 ? k.names[at] : undefined;
      const known = asName || short.includes(c) || hi.includes(key);
      if (!known) continue;
      const id = existingFor(k);
      if (id) return { kind: "existing", id };
      // Added under its proper name: the one typed if it is a proper name, otherwise the usual one ("Maths" → Mathematics).
      const name = asName ?? k.names[0];
      return { kind: "new", name, nameHi: name === k.names[0] ? k.hi[0] : null, typed };
    }
    return null;
  };
  const brandNew = (typed: string): SubjectHit => {
    const t = typed.replace(/\s+/g, " ").trim();
    return hasLatin(t) ? { kind: "new", name: tidySubjectName(t), nameHi: null, typed: t } : { kind: "new", name: t, nameHi: t, typed: t };
  };

  const hits: SubjectHit[] = [];
  const bad: string[] = [];
  const add = (h: SubjectHit) => {
    const same = hits.some((x) => (x.kind === "existing" && h.kind === "existing" ? x.id === h.id : x.kind === "new" && h.kind === "new" && subjectKey(x.name) === subjectKey(h.name)));
    if (!same) hits.push(h);
  };
  const whole = resolve(text);
  if (whole) return { hits: [whole], bad };
  for (const part of text
    .split(/[,;\n]/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)) {
    const hit = resolve(part);
    if (hit) {
      add(hit);
      continue;
    }
    const pieces = part
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);
    if (pieces.length === 2 && hasLatin(pieces[0]) && !hasLatin(pieces[1])) {
      // "Music / संगीत": one subject in both languages.
      const h = resolve(pieces[0]) ?? resolve(pieces[1]);
      if (h) add(h);
      else if (pieces[0].length < 2 || pieces[0].length > SUBJECT_NAME_MAX) bad.push(part);
      else add({ kind: "new", name: tidySubjectName(pieces[0]), nameHi: pieces[1], typed: part });
      continue;
    }
    // "Maths & Science", "Hindi and Sanskrit": several subjects, when each one is known (a name like "Art & Craft" stays whole otherwise).
    const joined = part
      .split(/\s*(?:\/|&|\band\b)\s*/i)
      .map((p) => p.trim())
      .filter(Boolean);
    const each = joined.length > 1 ? joined.map(resolve) : [];
    if (each.length && each.every(Boolean)) {
      each.forEach((h) => add(h!));
      continue;
    }
    for (const piece of pieces.length > 1 ? pieces : [part]) {
      const h = resolve(piece);
      if (h) add(h);
      else if (piece.length < 2 || piece.length > SUBJECT_NAME_MAX || !/\p{L}/u.test(piece)) bad.push(piece);
      else add(brandNew(piece));
    }
  }
  return { hits, bad };
}

/** Longest subject name the school's list takes (lib/services/classes.ts SUBJECT_LIMITS). */
const SUBJECT_NAME_MAX = SUBJECT_LIMITS.name;
/** More new subjects than this in one file is almost certainly a mistake in the column. */
const NEW_SUBJECTS_MAX = 25;

/**
 * "Did you mean Hindi?": the subject whose name (English or Hindi) is very
 * close to this one, shown by its English name (null when none is close).
 */
export function nearSubject(name: string, candidates: { match: string; show: string }[]): string | null {
  const key = subjectKey(name);
  if (key.length < 4) return null;
  const max = key.length <= 7 ? 1 : key.length <= 12 ? 2 : 3;
  let best: { show: string; d: number } | null = null;
  for (const c of candidates) {
    const d = editDistance(key, subjectKey(c.match), max);
    if (d > 0 && d <= max && (!best || d < best.d)) best = { show: c.show, d };
  }
  return best?.show ?? null;
}

function checkStaff(sheet: SheetRows, ref: ImportReference, date1904: boolean, issues: ImportIssue[], out: CheckedFile): CheckedStaff[] {
  const mapped = mapHeaders(sheet, STAFF_COLUMNS, "Staff", issues);
  if (!mapped) return [];
  const col = (k: StaffKey) => {
    const d = STAFF_COLUMNS.find((x) => x.key === k)!;
    return { label: d.label, letter: mapped.cols[k]?.letter ?? null };
  };
  const dataRows = sheet.rows.filter((r) => STAFF_COLUMNS.some((d) => mapped.cols[d.key] && r.cells[mapped.cols[d.key]!.col] !== undefined));
  out.rows.staff = dataRows.length;
  if (dataRows.length > IMPORT_LIMITS.staffRows || sheet.truncated) {
    issues.push({
      level: "error",
      sheet: "Staff",
      row: null,
      column: null,
      letter: null,
      problem: `The Staff sheet has ${sheet.truncated ? "more than " : ""}${dataRows.length.toLocaleString("en-IN")} filled rows. The portal imports up to ${IMPORT_LIMITS.staffRows} staff at a time.`,
      fix: "Check for rows that aren't staff members, or split the file in two.",
    });
    return [];
  }
  const classNames = new Set(ref.classes.map((c) => c.name));
  const classesText = classListText(ref.classes);
  const result: CheckedStaff[] = [];
  const seenEmp = new Map<string, number>();
  const classTeacherRow = new Map<string, number>();
  // Subjects the school doesn't have yet, in the order the file names them.
  const newSubjects = new Map<string, NewSubject>();

  for (const r of dataRows) {
    const ctx: RowCtx = { sheet: "Staff", row: r.row, issues, bad: false };
    const cell = (k: StaffKey): Cell => {
      const m = mapped.cols[k];
      return m ? (r.cells[m.col] ?? null) : null;
    };
    const broken = new Set<StaffKey>();
    for (const d of STAFF_COLUMNS) {
      const v = cell(d.key);
      if (isErrorCell(v)) {
        broken.add(d.key);
        problem(ctx, "error", col(d.key), `The cell shows the Excel error ${v.error}.`, "Type the value itself instead of a formula.");
      }
    }
    const val = (k: StaffKey) => (broken.has(k) ? null : cell(k));

    const empRaw = val("empNo");
    const empNo = registerNumber(empRaw);
    if (empNo === null) {
      if (!broken.has("empNo")) problem(ctx, "error", col("empNo"), "The employee number is missing.", `Type their number from the staff register, for example 12 (their login will be ${ref.school.loginPrefix}E12).`);
    } else if (empNo === "invalid") {
      problem(ctx, "error", col("empNo"), `“${shown(empRaw)}” isn't a valid employee number.`, "Use digits only, for example 12.");
    } else if (seenEmp.has(empNo)) {
      problem(ctx, "error", col("empNo"), `Employee No. ${empNo} is also in row ${seenEmp.get(empNo)}.`, "Each member of staff has their own number. Correct one of the two rows.");
    } else {
      seenEmp.set(empNo, r.row);
    }

    const name = cleanText(asText(val("name")), 200);
    if (!name) {
      if (!broken.has("name")) problem(ctx, "error", col("name"), "The name is missing.", "Type their full name.");
    } else if (name.length < 2 || name.length > 80 || !/\p{L}/u.test(name)) {
      problem(ctx, "error", col("name"), name.length > 80 ? "The name is longer than 80 characters." : `“${shown(name)}” doesn't look like a name.`, "Type their full name (2 to 80 characters).");
    }

    const designation = parseDesignation(asText(val("designation")));
    if (!designation && !broken.has("designation")) problem(ctx, "error", col("designation"), "The designation is missing.", "Choose from the list (for example Teacher), or type their post.");

    const accText = asText(val("access"));
    const access = parseAccess(accText);
    if (access === null) {
      if (!broken.has("access")) problem(ctx, "error", col("access"), "Portal access is missing.", "Choose from the list: Teacher, Office admin, Principal, Accounts or No login.");
    } else if (access === "invalid") {
      problem(ctx, "error", col("access"), `“${shown(accText)}” isn't one of the choices.`, "Choose from the list: Teacher, Office admin, Principal, Accounts or No login.");
    }

    // Mobile: needed for everyone who signs in (as in the template's Check column).
    const mobRaw = val("mobile");
    const mobile = parseMobile(asText(mobRaw));
    if (mobile === null) {
      if (access && access !== "invalid" && access !== "none" && !broken.has("mobile")) {
        problem(ctx, "error", col("mobile"), "The mobile number is missing.", "Type their own 10-digit mobile number. (It can be left empty only for staff with “No login”.)");
      }
    } else if (mobile === "invalid") {
      problem(ctx, "error", col("mobile"), `“${shown(mobRaw)}” isn't a 10-digit mobile number.`, "Type 10 digits starting with 6, 7, 8 or 9, for example 9876543210.");
    }

    const emailText = asText(val("email"));
    const email = emailText ? emailText.replace(/^mailto:/i, "").trim().toLowerCase() : null;
    if (email && (email.length > 120 || !EMAIL.test(email))) {
      problem(ctx, "error", col("email"), `“${shown(emailText)}” doesn't look like an email address.`, "Type one address such as name@example.com, or leave it empty.");
    }

    const ctText = asText(val("classTeacherOf"));
    const ctRefs = parseSectionRefs(ctText);
    let classTeacherOf: SectionRef[] | null = null;
    if (ctRefs === "invalid") {
      problem(ctx, "error", col("classTeacherOf"), `“${shown(ctText)}” isn't a class and section.`, "Write it like 5-A (or just 5 for section A). Leave it empty if they aren't a class teacher.");
    } else if (ctRefs) {
      const unknownClass = ctRefs.find((x) => !classNames.has(x.className));
      if (unknownClass) {
        problem(ctx, "error", col("classTeacherOf"), `${ref.school.name} has no ${classLabel(unknownClass.className)}.`, `Use one of: ${classesText}, with a section letter, for example 5-A.`);
      } else if (access && access !== "invalid" && !accessCanTeach(access)) {
        problem(
          ctx,
          "error",
          col("classTeacherOf"),
          `A class teacher takes attendance in the portal, but this person's portal access is “${access === "none" ? "No login" : "Accounts"}”.`,
          "Give them Teacher (or Principal / Office admin) access, or leave “Class teacher of” empty.",
        );
      } else {
        classTeacherOf = ctRefs;
        for (const x of ctRefs) {
          const key = sectionLabel(x.className, x.section);
          const other = classTeacherRow.get(key);
          if (other !== undefined && other !== r.row) {
            problem(ctx, "error", col("classTeacherOf"), `${key} already has a class teacher in row ${other}.`, "A section has one class teacher. Correct one of the two rows.");
          } else {
            classTeacherRow.set(key, r.row);
          }
        }
      }
    }

    const subjText = asText(val("subjects"));
    let subjectIds: string[] | null = null;
    const rowNew: SubjectHit[] = [];
    if (subjText && (subjText.length > 400 || subjText.split(/[,;\n/&]|\band\b/i).length > 40)) {
      problem(ctx, "error", col("subjects"), "The list of subjects is too long.", "Write each subject's name once, separated by commas, for example “Hindi, Maths, EVS”.");
    } else if (subjText) {
      const m = matchSubjects(subjText, ref.subjects);
      if (m.bad.length) {
        problem(
          ctx,
          "error",
          col("subjects"),
          `${m.bad.map((u) => `“${u}”`).join(", ")} ${m.bad.length === 1 ? "isn't a subject name" : "aren't subject names"} the portal can add.`,
          `Write each subject's name (2 to ${SUBJECT_NAME_MAX} characters), separated by commas, for example “Hindi, Maths, EVS”.`,
        );
      } else {
        subjectIds = m.hits.flatMap((h) => (h.kind === "existing" ? [h.id] : []));
        rowNew.push(...m.hits.filter((h) => h.kind === "new"));
      }
    }

    const joinRaw = val("joinedOn");
    const joinedOn = readDate(joinRaw, date1904);
    if (joinedOn === "invalid") {
      problem(ctx, "error", col("joinedOn"), `“${shown(joinRaw)}” isn't a date the portal can read.`, "Type it as DD-MM-YYYY, for example 01-07-2019, or leave it empty.");
    } else if (joinedOn && (joinedOn < "1960-01-01" || joinedOn > addDays(ref.today, 366))) {
      problem(ctx, "error", col("joinedOn"), `The date of joining ${formatDate(joinedOn)} doesn't look right.`, "Check the year (DD-MM-YYYY).");
    }

    if (ctx.bad || !empNo || empNo === "invalid" || !name || !designation || !access || access === "invalid" || mobile === "invalid") continue;
    const newKeys: string[] = [];
    for (const h of rowNew) {
      if (h.kind !== "new") continue;
      const key = subjectKey(h.name);
      const known = newSubjects.get(key);
      if (known) {
        if (!known.typed.includes(h.typed)) known.typed.push(h.typed);
        if (!known.rows.includes(r.row)) known.rows.push(r.row);
        known.nameHi ??= h.nameHi;
      } else {
        newSubjects.set(key, { key, name: h.name, nameHi: h.nameHi, typed: [h.typed], rows: [r.row] });
      }
      if (!newKeys.includes(key)) newKeys.push(key);
    }
    result.push({
      row: r.row,
      empNo,
      name,
      designation,
      access,
      mobile,
      email,
      classTeacherOf,
      subjectIds,
      ...(newKeys.length ? { newSubjects: newKeys } : {}),
      joinedOn: joinedOn && joinedOn !== "invalid" ? joinedOn : null,
    });
  }

  // Subjects the school doesn't have yet are added by the import (listed in the preview). A near-miss is worth a second look.
  const list = [...newSubjects.values()];
  out.newSubjects = list;
  const rowsText = (rows: number[]) => (rows.length === 1 ? `row ${rows[0]}` : `rows ${rows.slice(0, -1).join(", ")} and ${rows[rows.length - 1]}`);
  if (list.length > NEW_SUBJECTS_MAX) {
    issues.push({
      level: "error",
      sheet: "Staff",
      row: null,
      column: "Subjects taught",
      letter: mapped.cols.subjects?.letter ?? null,
      problem: `The “Subjects taught” column names ${list.length} subjects the school doesn't have yet. That is more than a school normally teaches, so nothing was imported.`,
      fix: "Check that column holds only subject names, separated by commas, for example “Hindi, Maths, EVS”. Add any unusual subjects on Classes & subjects first.",
    });
    return result;
  }
  const candidates = [
    ...ref.subjects.flatMap((s) => [{ match: s.name, show: s.name }, ...(s.nameHi ? [{ match: s.nameHi, show: s.name }] : [])]),
    ...KNOWN_SUBJECTS.flatMap((k) => [{ match: k.names[0], show: k.names[0] }, ...k.hi.map((h) => ({ match: h, show: k.names[0] }))]),
  ];
  for (const s of list) {
    const shownAs = s.typed.map((t) => `“${t}”`).join(" and ");
    const near = s.typed.map((t) => nearSubject(t, candidates)).find(Boolean) ?? null;
    if (near && subjectKey(near) !== s.key) {
      issues.push({
        level: "warning",
        sheet: "Staff",
        row: s.rows[0],
        column: "Subjects taught",
        letter: mapped.cols.subjects?.letter ?? null,
        problem: `${shownAs} isn't one of the school's subjects, so it will be added as a new subject. Did you mean ${near}?`,
        fix: `If you meant ${near}, correct ${rowsText(s.rows)} and upload the file again. If it really is another subject, nothing needs doing.`,
      });
    } else if (!hasLatin(s.name)) {
      issues.push({
        level: "warning",
        sheet: "Staff",
        row: s.rows[0],
        column: "Subjects taught",
        letter: mapped.cols.subjects?.letter ?? null,
        problem: `${shownAs} will be added as a new subject with only a Hindi name.`,
        fix: "After the import, add its English name on Classes & subjects (School subjects), or write it as “English name / हिंदी नाम” in the file.",
      });
    }
  }
  return result;
}

export const hasErrors = (issues: ImportIssue[]) => issues.some((i) => i.level === "error");

/* ================================================================== */
/* Planning: what the import will change                               */
/* ================================================================== */

export type PlannedStudent = {
  row: number;
  srNo: string;
  name: string;
  kind: "new" | "update" | "same";
  studentId: string | null;
  className: string;
  sectionName: string;
  /** "V-A" */
  sectionLabel: string;
  rollNo: number | null;
  rte: boolean;
  /** New: every field. Update: only the fields that change. */
  fields: Partial<StudentFields>;
  placementChanged: boolean;
  /** Plain words for the preview: "Parent's mobile changed", "Class V-A → VI-A". */
  changes: string[];
  admittedThisSession: boolean;
};

export type PlannedStaff = {
  row: number;
  empNo: string;
  name: string;
  kind: "new" | "update" | "same";
  staffId: string | null;
  designation: string;
  access: StaffAccess;
  /** New: every field. Update: only the fields that change. */
  fields: Partial<StaffFields>;
  /** Set only when the subject list changes. Subjects still to be added are "new:<key>" (see ImportPlan.subjectsToAdd). */
  subjectIds: string[] | null;
  subjectNames: string[];
  /** Class-teacher duties after the import (labels), when the cell is filled. */
  classTeacherOf: string[] | null;
  changes: string[];
};

export type PlannedSection = { classId: string; className: string; name: string; label: string; staffOnly: boolean };

export type ImportCounts = {
  studentsNew: number;
  studentsUpdated: number;
  studentsSame: number;
  staffNew: number;
  staffUpdated: number;
  staffSame: number;
  sections: number;
  /** Subjects added to the school's list (named in "Subjects taught"). */
  subjectsNew?: number;
};

export type ImportPlan = {
  students: PlannedStudent[];
  staff: PlannedStaff[];
  sectionsToCreate: PlannedSection[];
  /** Subjects named in the file that the school doesn't have yet: added to its list. */
  subjectsToAdd: NewSubject[];
  /** Section label → new class teacher (staff row, or null to clear). */
  classTeacherMoves: { sectionLabel: string; staffRow: number | null; staffId: string | null; previousId: string | null }[];
  issues: ImportIssue[];
  counts: ImportCounts;
  /** The admission-fee offer: new students admitted this session (RTE ones are never charged). */
  admission: { amount: number; eligible: number; rte: number; noDate: number } | null;
};

/** A short fingerprint of what will change, so a confirmation matches the preview it was made from. */
export function planKey(c: ImportCounts): string {
  return [c.studentsNew, c.studentsUpdated, c.staffNew, c.staffUpdated, c.sections, c.subjectsNew ?? 0].join(".");
}

/** Placeholder for a subject the import is about to add. */
const NEW_SUBJECT = "new:";

const GENDER_WORD: Record<string, string> = { M: "Boy", F: "Girl", O: "Other" };
const ACCESS_WORD: Record<StaffAccess, string> = { teacher: "Teacher", principal: "Principal", office_admin: "Office admin", accounts: "Accounts", none: "No login" };

/** Words for an optional contact detail that changes: "added", "changed". */
const contactChange = (label: string, before: string | null) => `${label} ${before ? "changed" : "added"}`;

/**
 * `mayManageAdmins`: the uploader is an AESRI administrator. For anyone
 * else, a row that would add a principal or office admin, or change anyone's
 * access to or from those, is an error (see lib/services/staff.ts).
 */
export async function planImport(
  tx: Tx,
  input: { schoolId: string; sessionId: string; file: CheckedFile; actorStaffId: string | null; mayManageAdmins: boolean },
): Promise<ImportPlan> {
  const { schoolId, sessionId, file } = input;
  const issues: ImportIssue[] = [];
  const srNos = [...new Set(file.students.map((s) => s.srNo))];

  const [classRows, sectionRows, existingStudents, staffRows, staffSubjectRows, subjectRows, session, plan] = await Promise.all([
    tx.select({ id: classes.id, name: classes.name, stream: classes.stream }).from(classes).where(eq(classes.schoolId, schoolId)),
    tx
      .select({ id: sections.id, classId: sections.classId, name: sections.name, className: classes.name, classTeacherId: sections.classTeacherId })
      .from(sections)
      .innerJoin(classes, eq(classes.id, sections.classId))
      .where(and(eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId))),
    srNos.length ? tx.select().from(students).where(and(eq(students.schoolId, schoolId), inArray(students.srNo, srNos))) : Promise.resolve([]),
    tx.select().from(staff).where(eq(staff.schoolId, schoolId)),
    tx
      .select({ staffId: staffSubjects.staffId, subjectId: staffSubjects.subjectId })
      .from(staffSubjects)
      .innerJoin(staff, eq(staff.id, staffSubjects.staffId))
      .where(eq(staff.schoolId, schoolId)),
    tx.select({ id: subjects.id, name: subjects.name, nameHi: subjects.nameHi, sortOrder: subjects.sortOrder }).from(subjects).where(eq(subjects.schoolId, schoolId)),
    tx.select({ startsOn: academicSessions.startsOn, endsOn: academicSessions.endsOn }).from(academicSessions).where(eq(academicSessions.id, sessionId)),
    currentPlan(tx, schoolId),
  ]);
  const sessionRow = session[0];
  if (!sessionRow) throw new ImportStateError("The session this preview was made for no longer exists.", "session");

  // Current placements this session: for the file's students, and everyone else (roll-number clashes).
  const placed = await tx
    .select({
      studentId: enrolments.studentId,
      sectionId: enrolments.sectionId,
      rollNo: enrolments.rollNo,
      name: students.name,
      srNo: students.srNo,
      status: students.status,
    })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(and(eq(enrolments.sessionId, sessionId), eq(students.schoolId, schoolId)));

  const classByName = new Map(classRows.map((c) => [c.name, c]));
  const sectionByKey = new Map(sectionRows.map((s) => [sectionLabel(s.className, s.name), s]));
  const sectionById = new Map(sectionRows.map((s) => [s.id, s]));
  const placedBy = new Map(placed.map((p) => [p.studentId, p]));
  const studentBySr = new Map(existingStudents.map((s) => [s.srNo, s]));
  const staffByEmp = new Map(staffRows.map((s) => [s.empNo, s]));
  const staffById = new Map(staffRows.map((s) => [s.id, s]));
  const subjectName = new Map(subjectRows.map((s) => [s.id, s.name]));
  const subjectOrder = new Map(subjectRows.map((s) => [s.id, s.sortOrder]));
  const subjectsOf = new Map<string, string[]>();
  for (const r of staffSubjectRows) subjectsOf.set(r.staffId, [...(subjectsOf.get(r.staffId) ?? []), r.subjectId]);

  // Subjects the file adds: one added to the school's list since the file was checked is simply used.
  const subjectByKey = new Map<string, string>();
  for (const s of subjectRows) {
    subjectByKey.set(subjectKey(s.name), s.id);
    if (s.nameHi) subjectByKey.set(subjectKey(s.nameHi), s.id);
  }
  const subjectsToAdd: NewSubject[] = [];
  const newSubjectId = new Map<string, string>();
  for (const s of file.newSubjects ?? []) {
    const have = subjectByKey.get(s.key) ?? (s.nameHi ? subjectByKey.get(subjectKey(s.nameHi)) : undefined);
    if (have) newSubjectId.set(s.key, have);
    else {
      newSubjectId.set(s.key, `${NEW_SUBJECT}${s.key}`);
      subjectsToAdd.push(s);
      subjectName.set(`${NEW_SUBJECT}${s.key}`, s.name);
      subjectOrder.set(`${NEW_SUBJECT}${s.key}`, Number.MAX_SAFE_INTEGER);
    }
  }
  /** Everything a staff row names in "Subjects taught", as subject IDs (or placeholders for subjects to add). Null: empty cell. */
  const subjectsInRow = (row: CheckedStaff): string[] | null => {
    if (!row.subjectIds) return null;
    const ids = [...row.subjectIds];
    for (const k of row.newSubjects ?? []) {
      const id = newSubjectId.get(k);
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  };
  const namesOf = (ids: string[]) =>
    [...ids]
      .sort((a, b) => (subjectOrder.get(a) ?? 0) - (subjectOrder.get(b) ?? 0))
      .map((id) => `${subjectName.get(id) ?? "?"}${id.startsWith(NEW_SUBJECT) ? " (new)" : ""}`);

  const toCreate = new Map<string, PlannedSection>();
  const needSection = (className: string, name: string, staffOnly: boolean) => {
    const label = sectionLabel(className, name);
    if (sectionByKey.has(label)) return;
    const cls = classByName.get(className);
    if (!cls) return;
    const cur = toCreate.get(label);
    if (cur) cur.staffOnly = cur.staffOnly && staffOnly;
    else toCreate.set(label, { classId: cls.id, className, name, label, staffOnly });
  };

  /* ---------------- students ---------------- */
  const plannedStudents: PlannedStudent[] = [];
  for (const row of file.students) {
    const cur = studentBySr.get(row.srNo);
    const note = (level: IssueLevel, column: string | null, text: string, fix: string | null) =>
      issues.push({ level, sheet: "Students", row: row.row, column, letter: null, problem: text, fix });
    if (cur && cur.status !== "active") {
      const status = { left: "has left the school", transferred: "was transferred", passed_out: "has passed out" }[cur.status as "left" | "transferred" | "passed_out"];
      note(
        "error",
        "SR No.",
        `SR No. ${row.srNo} belongs to ${cur.name}, who ${status}.`,
        "If this is a different child, check the SR No. If they have come back, mark them as studying again on the Students page first, then upload the file again.",
      );
      continue;
    }
    const now = cur ? placedBy.get(cur.id) : undefined;
    const nowSection = now ? sectionById.get(now.sectionId) : undefined;
    const sameClass = !!nowSection && nowSection.className === row.className;
    const sectionName = row.section ?? (sameClass ? nowSection!.name : "A");
    const label = sectionLabel(row.className, sectionName);
    const rollNo = row.rollNo ?? (nowSection && sectionLabel(nowSection.className, nowSection.name) === label ? (now?.rollNo ?? null) : null);
    needSection(row.className, sectionName, false);
    const admittedThisSession = !!row.admittedOn && row.admittedOn >= sessionRow.startsOn && row.admittedOn <= sessionRow.endsOn;

    const full: StudentFields = {
      srNo: row.srNo,
      name: row.name,
      gender: row.gender,
      dob: row.dob,
      admittedOn: row.admittedOn,
      fatherName: row.fatherName,
      motherName: row.motherName,
      guardianName: row.guardianName,
      guardianMobile: row.mobile,
      mobile2: row.mobile2,
      address: row.address,
      rte: row.rte,
    };
    if (!row.fatherName && !row.motherName && !row.guardianName && !(cur && (cur.fatherName || cur.motherName || cur.guardianName))) {
      note("warning", null, "No father's, mother's or guardian's name.", "Add at least one if you know it. It can also be added later on the student's page.");
    }
    if (!cur) {
      plannedStudents.push({
        row: row.row,
        srNo: row.srNo,
        name: row.name,
        kind: "new",
        studentId: null,
        className: row.className,
        sectionName,
        sectionLabel: label,
        rollNo,
        rte: row.rte,
        fields: full,
        placementChanged: true,
        changes: [],
        admittedThisSession,
      });
      continue;
    }

    // An update: only filled cells that differ from the record.
    const fields: Partial<StudentFields> = {};
    const changes: string[] = [];
    if (row.name !== cur.name) {
      fields.name = row.name;
      changes.push(`Name: ${cur.name} → ${row.name}`);
      const before = new Set(nameKey(cur.name).split(" "));
      if (!nameKey(row.name).split(" ").some((w) => w.length > 1 && before.has(w))) {
        note(
          "warning",
          "Student's full name",
          `The name in the file (${row.name}) is quite different from the name on record for SR No. ${row.srNo} (${cur.name}).`,
          "Check the SR No. Importing will rename this student.",
        );
      }
    }
    if (row.gender !== cur.gender) {
      fields.gender = row.gender;
      changes.push(`Gender: ${cur.gender ? GENDER_WORD[cur.gender] : "not set"} → ${GENDER_WORD[row.gender]}`);
    }
    if (row.dob !== cur.dob) {
      fields.dob = row.dob;
      changes.push(cur.dob ? `Date of birth: ${formatDate(cur.dob)} → ${formatDate(row.dob)}` : "Date of birth added");
    }
    if (row.admittedOn && row.admittedOn !== cur.admittedOn) {
      fields.admittedOn = row.admittedOn;
      changes.push(cur.admittedOn ? `Admission date: ${formatDate(cur.admittedOn)} → ${formatDate(row.admittedOn)}` : "Admission date added");
    }
    for (const [key, label2, value] of [
      ["fatherName", "Father's name", row.fatherName],
      ["motherName", "Mother's name", row.motherName],
      ["guardianName", "Guardian's name", row.guardianName],
      ["mobile2", "Second mobile", row.mobile2],
      ["address", "Village / address", row.address],
    ] as const) {
      if (value && value !== cur[key]) {
        fields[key] = value;
        changes.push(contactChange(label2, cur[key]));
      }
    }
    if (row.mobile !== cur.guardianMobile) {
      fields.guardianMobile = row.mobile;
      changes.push(contactChange("Parent's mobile", cur.guardianMobile));
    }
    if (row.rte !== cur.rte) {
      fields.rte = row.rte;
      changes.push(`RTE seat: ${cur.rte ? "Yes" : "No"} → ${row.rte ? "Yes" : "No"}`);
    }
    const oldLabel = nowSection ? sectionLabel(nowSection.className, nowSection.name) : null;
    let placementChanged = false;
    if (!oldLabel) {
      placementChanged = true;
      changes.push(`Placed in ${label} for ${sessionId}`);
    } else if (oldLabel !== label) {
      placementChanged = true;
      changes.push(`Class ${oldLabel} → ${label}`);
    }
    if ((now?.rollNo ?? null) !== rollNo && oldLabel) {
      placementChanged = true;
      if (oldLabel === label) changes.push(`Roll No. ${now?.rollNo ?? "none"} → ${rollNo ?? "none"}`);
      else if (rollNo !== null) changes.push(`Roll No. ${rollNo}`);
    }
    plannedStudents.push({
      row: row.row,
      srNo: row.srNo,
      name: row.name,
      kind: changes.length ? "update" : "same",
      studentId: cur.id,
      className: row.className,
      sectionName,
      sectionLabel: label,
      rollNo,
      rte: row.rte,
      fields,
      placementChanged,
      changes,
      admittedThisSession: false,
    });
  }

  // Roll numbers used twice in a section once the import is done.
  const inFile = new Set(plannedStudents.map((p) => p.studentId).filter(Boolean) as string[]);
  const rollHolder = new Map<string, { row: number | null; who: string }>();
  for (const p of placed) {
    if (inFile.has(p.studentId) || p.status !== "active" || p.rollNo === null) continue;
    const sec = sectionById.get(p.sectionId);
    if (sec) rollHolder.set(`${sectionLabel(sec.className, sec.name)}#${p.rollNo}`, { row: null, who: `${p.name} (SR No. ${p.srNo}), who isn't in this file` });
  }
  for (const p of plannedStudents) {
    if (p.rollNo === null) continue;
    const key = `${p.sectionLabel}#${p.rollNo}`;
    const other = rollHolder.get(key);
    if (other) {
      issues.push({
        level: "warning",
        sheet: "Students",
        row: p.row,
        column: "Roll No.",
        letter: null,
        problem: `Roll No. ${p.rollNo} in ${p.sectionLabel} is also given to ${other.row !== null ? `row ${other.row}` : other.who}.`,
        fix: "Check the roll numbers of this section. They can also be corrected later.",
      });
    } else {
      rollHolder.set(key, { row: p.row, who: `row ${p.row}` });
    }
  }

  /* ---------------- staff ---------------- */
  const plannedStaff: PlannedStaff[] = [];
  // Class teachers after the import, section by section (starting from today's).
  const ctNow = new Map(sectionRows.map((s) => [sectionLabel(s.className, s.name), s.classTeacherId]));
  const ctAfter = new Map<string, { staffRow: number | null; staffId: string | null }>();
  for (const [label, id] of ctNow) ctAfter.set(label, { staffRow: null, staffId: id });

  for (const row of file.staff) {
    const cur = staffByEmp.get(row.empNo);
    const note = (level: IssueLevel, column: string | null, text: string, fix: string | null) =>
      issues.push({ level, sheet: "Staff", row: row.row, column, letter: null, problem: text, fix });
    if (cur && cur.status === "left") {
      note(
        "error",
        "Employee No.",
        `Employee No. ${row.empNo} belongs to ${cur.name}, who has left the school.`,
        "If this is someone else, check the number. If they have rejoined, mark them as working again on the Staff page first, then upload the file again.",
      );
      continue;
    }
    if (cur && cur.id === input.actorStaffId && cur.access !== row.access) {
      note(
        "error",
        "Portal access",
        `This row is you, and it would change your own portal access (${ACCESS_WORD[cur.access]} → ${ACCESS_WORD[row.access]}).`,
        "Keep your own access as it is in the portal. The AESRI administrator can change it on the Staff page if needed.",
      );
      continue;
    }
    // Principal and Office admin access is given and taken away by AESRI administrators only.
    if (!input.mayManageAdmins && touchesAdminAccess(cur?.access ?? null, row.access)) {
      if (!cur) {
        note(
          "error",
          "Portal access",
          `This row would add ${row.name} with “${ACCESS_WORD[row.access]}” access. Only the AESRI administrator can give Principal or Office admin access.`,
          `Choose another access for this row (for example Teacher) and ask the AESRI administrator to change it later, or ask them to import the file.`,
        );
      } else {
        note(
          "error",
          "Portal access",
          `This row would change ${cur.name}’s portal access from ${ACCESS_WORD[cur.access]} to ${ACCESS_WORD[row.access]}. Only the AESRI administrator can give or take away Principal or Office admin access.`,
          `Put their access as it is in the portal (${ACCESS_WORD[cur.access]}), or ask the AESRI administrator to make the change.`,
        );
      }
      continue;
    }
    const labels = row.classTeacherOf?.map((x) => sectionLabel(x.className, x.section)) ?? null;
    for (const x of row.classTeacherOf ?? []) needSection(x.className, x.section, true);

    const named = subjectsInRow(row);
    const fields: Partial<StaffFields> = {};
    const changes: string[] = [];
    let subjectIds: string[] | null = null;
    if (!cur) {
      Object.assign(fields, {
        empNo: row.empNo,
        name: row.name,
        designation: row.designation,
        access: row.access,
        mobile: row.mobile,
        email: row.email,
        joinedOn: row.joinedOn,
      } satisfies StaffFields);
      subjectIds = named && named.length ? named : null;
    } else {
      if (row.name !== cur.name) {
        fields.name = row.name;
        changes.push(`Name: ${cur.name} → ${row.name}`);
      }
      if (row.designation !== cur.designation) {
        fields.designation = row.designation;
        changes.push(cur.designation ? `Designation: ${cur.designation} → ${row.designation}` : `Designation: ${row.designation}`);
      }
      if (row.access !== cur.access) {
        fields.access = row.access;
        changes.push(`Portal access: ${ACCESS_WORD[cur.access]} → ${ACCESS_WORD[row.access]}`);
      }
      if (row.mobile && row.mobile !== cur.mobile) {
        fields.mobile = row.mobile;
        changes.push(contactChange("Mobile", cur.mobile));
      }
      if (row.email && row.email !== cur.email) {
        fields.email = row.email;
        changes.push(contactChange("Email", cur.email));
      }
      if (row.joinedOn && row.joinedOn !== cur.joinedOn) {
        fields.joinedOn = row.joinedOn;
        changes.push(cur.joinedOn ? `Date of joining: ${formatDate(cur.joinedOn)} → ${formatDate(row.joinedOn)}` : "Date of joining added");
      }
      if (named) {
        const have = subjectsOf.get(cur.id) ?? [];
        const same = have.length === named.length && named.every((id) => have.includes(id));
        if (!same) {
          subjectIds = named;
          changes.push(`Subjects: ${have.length ? namesOf(have).join(", ") : "none"} → ${namesOf(named).join(", ")}`);
        }
      }
    }
    plannedStaff.push({
      row: row.row,
      empNo: row.empNo,
      name: row.name,
      kind: cur ? "same" : "new",
      staffId: cur?.id ?? null,
      designation: row.designation,
      access: row.access,
      fields,
      subjectIds,
      subjectNames: namesOf(named ?? (cur ? (subjectsOf.get(cur.id) ?? []) : [])),
      classTeacherOf: labels,
      changes,
    });
  }

  // Class-teacher duties: a filled cell lists every section the person is class teacher of.
  for (const p of plannedStaff) {
    if (!p.classTeacherOf) continue;
    if (p.staffId) {
      for (const [label, id] of ctNow) {
        if (id === p.staffId && !p.classTeacherOf.includes(label)) {
          const after = ctAfter.get(label)!;
          if (after.staffId === p.staffId && after.staffRow === null) ctAfter.set(label, { staffRow: null, staffId: null });
        }
      }
    }
  }
  for (const p of plannedStaff) {
    for (const label of p.classTeacherOf ?? []) ctAfter.set(label, { staffRow: p.row, staffId: p.staffId });
  }
  const moves: ImportPlan["classTeacherMoves"] = [];
  const staffByRow = new Map(plannedStaff.map((p) => [p.row, p]));
  const nameOfStaff = (id: string | null) => (id ? (staffById.get(id)?.name ?? "someone") : null);
  for (const [label, after] of ctAfter) {
    const before = ctNow.get(label) ?? null;
    const same = after.staffRow === null ? after.staffId === before : after.staffId !== null && after.staffId === before;
    if (same) continue;
    moves.push({ sectionLabel: label, staffRow: after.staffRow, staffId: after.staffId, previousId: before });
    const incoming = after.staffRow !== null ? staffByRow.get(after.staffRow) : undefined;
    if (incoming) {
      const prevName = before && before !== incoming.staffId ? nameOfStaff(before) : null;
      incoming.changes.push(`Class teacher of ${label}${prevName ? ` (instead of ${prevName})` : ""}`);
    }
    if (before) {
      const outgoing = plannedStaff.find((p) => p.staffId === before);
      if (outgoing && (!incoming || incoming.staffId !== before)) outgoing.changes.push(`No longer class teacher of ${label}`);
    }
  }
  for (const p of plannedStaff) if (p.staffId && p.changes.length) p.kind = "update";

  // Someone who stays a class teacher but, with their new access, can't take a class.
  for (const p of plannedStaff) {
    if (!p.staffId || accessCanTeach(p.access)) continue;
    const still = [...ctAfter].filter(([, a]) => a.staffId === p.staffId).map(([label]) => label);
    if (!still.length) continue;
    issues.push({
      level: "warning",
      sheet: "Staff",
      row: p.row,
      column: "Portal access",
      letter: null,
      problem: `${p.name} stays class teacher of ${still.join(", ")}, but with “${ACCESS_WORD[p.access]}” access they can't take attendance there.`,
      fix: "Choose another class teacher on the Classes & subjects page after the import, or give them Teacher access.",
    });
  }

  // Sections made only because someone is named as their class teacher.
  for (const s of toCreate.values()) {
    if (!s.staffOnly) continue;
    const who = plannedStaff.find((p) => p.classTeacherOf?.includes(s.label));
    issues.push({
      level: "warning",
      sheet: "Staff",
      row: who?.row ?? null,
      column: "Class teacher of",
      letter: null,
      problem: `${s.label} doesn't exist yet and has no students in this file. It will be created because ${who?.name ?? "a member of staff"} is named as its class teacher.`,
      fix: `If ${s.label} is a mistake, correct “Class teacher of” and upload the file again.`,
    });
  }

  const newStudents = plannedStudents.filter((p) => p.kind === "new");
  const fee = plan?.oneTime.find((o) => o.key === "admission");
  const eligible = newStudents.filter((p) => p.admittedThisSession);
  const counts: ImportCounts = {
    studentsNew: newStudents.length,
    studentsUpdated: plannedStudents.filter((p) => p.kind === "update").length,
    studentsSame: plannedStudents.filter((p) => p.kind === "same").length,
    staffNew: plannedStaff.filter((p) => p.kind === "new").length,
    staffUpdated: plannedStaff.filter((p) => p.kind === "update").length,
    staffSame: plannedStaff.filter((p) => p.kind === "same").length,
    sections: toCreate.size,
    subjectsNew: subjectsToAdd.length,
  };
  return {
    students: plannedStudents,
    staff: plannedStaff,
    sectionsToCreate: [...toCreate.values()].sort((a, b) => a.label.localeCompare(b.label)),
    subjectsToAdd,
    classTeacherMoves: moves,
    issues,
    counts,
    admission:
      fee && eligible.length
        ? { amount: fee.amount, eligible: eligible.length, rte: eligible.filter((p) => p.rte).length, noDate: newStudents.filter((p) => !p.fields.admittedOn).length }
        : null,
  };
}

/* ================================================================== */
/* Batches                                                             */
/* ================================================================== */

export type BatchSummary = {
  rows: { students: number; staff: number };
  errors: number;
  warnings: number;
  meta?: FileMeta;
  /** Filled in once imported. */
  result?: ImportResult;
  /**
   * Filled in once imported (missing in imports made before this was
   * recorded): the students and staff the import added — record IDs only,
   * no names — so the office can print the sign-in slips for exactly them.
   */
  created?: { studentIds: string[]; staffIds: string[] };
};

export type ImportResult = ImportCounts & {
  sectionsCreated: string[];
  /** Subjects added to the school's list (missing in results saved before this was recorded). */
  subjectsAdded?: string[];
  admissionFees: number;
  /** Sections that received new students (to print their activation slips). */
  slipSections: { id: string; label: string; students: number }[];
  /** New staff who can sign in (they need slips too). */
  staffWithLogin: number;
};

/** What a batch's payload holds while it waits. Errors-only batches keep no rows. */
export type BatchPayload = CheckedFile;

const SYSTEM: AuditActor = { accountId: null, loginId: "system" };

/** Keep a checked file as a preview. The uploader's earlier previews for this school are discarded. */
export async function savePreview(
  tx: Tx,
  input: { schoolId: string; sessionId: string; fileName: string; file: CheckedFile; planIssues: ImportIssue[] },
  actor: AuditActor & { accountId: string },
): Promise<{ id: string }> {
  const earlier = await tx
    .update(importBatches)
    .set({ status: "discarded", payload: null, finishedAt: new Date() })
    .where(and(eq(importBatches.schoolId, input.schoolId), eq(importBatches.createdBy, actor.accountId), eq(importBatches.status, "previewed")))
    .returning({ id: importBatches.id, fileName: importBatches.fileName });
  for (const e of earlier) {
    await audit(tx, actor, "import.discarded", { schoolId: input.schoolId, targetType: "import", targetId: e.id, details: { fileName: e.fileName, reason: "replaced" } });
  }
  const issues = [...input.file.issues, ...input.planIssues];
  const errors = issues.filter((i) => i.level === "error").length;
  // A file with errors can't be imported, so its rows (personal details) aren't kept — only the problems.
  // A clean file keeps its rows; the preview works out the changes (and their warnings) afresh each time.
  const payload: BatchPayload = errors ? { ...input.file, students: [], staff: [], issues } : input.file;
  const summary: BatchSummary = { rows: input.file.rows, errors, warnings: issues.length - errors, meta: input.file.meta };
  const [row] = await tx
    .insert(importBatches)
    .values({
      schoolId: input.schoolId,
      sessionId: input.sessionId,
      fileName: input.fileName,
      status: "previewed",
      payload: payload as unknown as Record<string, unknown>,
      summary: summary as unknown as Record<string, unknown>,
      createdBy: actor.accountId,
    })
    .returning({ id: importBatches.id });
  await audit(tx, actor, "import.previewed", {
    schoolId: input.schoolId,
    targetType: "import",
    targetId: row.id,
    details: { fileName: input.fileName, students: input.file.rows.students, staff: input.file.rows.staff, errors, warnings: summary.warnings },
  });
  return row;
}

export type BatchRow = typeof importBatches.$inferSelect;

/** A batch of this school, or null. */
export async function getBatch(tx: Tx, schoolId: string, batchId: string): Promise<BatchRow | null> {
  if (!isUuid(batchId)) return null;
  const [b] = await tx
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, batchId), eq(importBatches.schoolId, schoolId)));
  return b ?? null;
}

export const isExpired = (b: { createdAt: Date }, now = new Date()) => now.getTime() - b.createdAt.getTime() > PREVIEW_HOURS * 3600_000;

/** Discard a waiting preview (its rows are deleted). Returns false if it wasn't waiting any more. */
export async function discardBatch(tx: Tx, schoolId: string, batchId: string, actor: AuditActor, reason: "discarded" | "expired"): Promise<boolean> {
  if (!isUuid(batchId)) return false;
  const [b] = await tx
    .select({ id: importBatches.id, status: importBatches.status, fileName: importBatches.fileName })
    .from(importBatches)
    .where(and(eq(importBatches.id, batchId), eq(importBatches.schoolId, schoolId)))
    .for("update");
  if (!b || b.status !== "previewed") return false;
  await tx.update(importBatches).set({ status: "discarded", payload: null, finishedAt: new Date() }).where(eq(importBatches.id, b.id));
  await audit(tx, reason === "expired" ? SYSTEM : actor, "import.discarded", { schoolId, targetType: "import", targetId: b.id, details: { fileName: b.fileName, reason } });
  return true;
}

/** Discard every preview (in any school) that has waited longer than PREVIEW_HOURS. */
export async function discardExpiredPreviews(tx: Tx, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PREVIEW_HOURS * 3600_000);
  const gone = await tx
    .update(importBatches)
    .set({ status: "discarded", payload: null, finishedAt: now })
    .where(and(eq(importBatches.status, "previewed"), lt(importBatches.createdAt, cutoff)))
    .returning({ id: importBatches.id, schoolId: importBatches.schoolId, fileName: importBatches.fileName });
  for (const g of gone) {
    await audit(tx, SYSTEM, "import.discarded", { schoolId: g.schoolId, targetType: "import", targetId: g.id, details: { fileName: g.fileName, reason: "expired" } });
  }
  return gone.length;
}

/** Recent imports of a school, newest first (no rows, only counts). */
export async function recentBatches(schoolId: string, limit = 12) {
  const db = await getDb();
  return db
    .select({
      id: importBatches.id,
      fileName: importBatches.fileName,
      status: importBatches.status,
      // Without the long lists of the records each import added (the list only shows counts).
      summary: sql<Record<string, unknown> | null>`${importBatches.summary} - 'created'`,
      createdBy: importBatches.createdBy,
      createdAt: importBatches.createdAt,
      finishedAt: importBatches.finishedAt,
      sessionId: importBatches.sessionId,
    })
    .from(importBatches)
    .where(eq(importBatches.schoolId, schoolId))
    .orderBy(desc(importBatches.createdAt))
    .limit(limit);
}

/** The checked file kept with a waiting batch (null once imported or discarded). */
export function batchFile(b: Pick<BatchRow, "payload">): CheckedFile | null {
  const p = b.payload as unknown as CheckedFile | null;
  return p && p.version === 1 && Array.isArray(p.students) && Array.isArray(p.staff) && Array.isArray(p.issues) ? p : null;
}

/** The students and staff an import added (null unless imported, and for imports made before this was recorded). */
export function batchCreated(b: Pick<BatchRow, "status" | "summary">): { studentIds: string[]; staffIds: string[] } | null {
  if (b.status !== "imported") return null;
  const c = (b.summary as BatchSummary | null)?.created;
  if (!c || !Array.isArray(c.studentIds) || !Array.isArray(c.staffIds)) return null;
  return { studentIds: c.studentIds.filter(isUuid), staffIds: c.staffIds.filter(isUuid) };
}

/* ================================================================== */
/* Applying                                                            */
/* ================================================================== */

/**
 * Import a previewed batch, all or nothing. The batch row is locked and its
 * status checked first, so confirming twice never imports twice. The plan is
 * made again from the records as they are now; if it no longer matches the
 * preview the office confirmed (`expect`), nothing is changed.
 */
export async function applyImport(
  tx: Tx,
  input: { schoolId: string; sessionId: string; batchId: string; expect: string; chargeAdmissionFee: boolean; actorStaffId: string | null; mayManageAdmins: boolean },
  actor: AuditActor,
): Promise<ImportResult> {
  const [batch] = isUuid(input.batchId)
    ? await tx
        .select()
        .from(importBatches)
        .where(and(eq(importBatches.id, input.batchId), eq(importBatches.schoolId, input.schoolId)))
        .for("update")
    : [];
  if (!batch) throw new ImportStateError("That import was not found.", "discarded");
  if (batch.status === "imported") throw new ImportStateError("This file has already been imported.", "imported");
  if (batch.status !== "previewed") throw new ImportStateError("This preview was discarded, so it can't be imported. Upload the file again.", "discarded");
  if (isExpired(batch)) throw new ImportStateError(`This preview is more than ${PREVIEW_HOURS} hours old. Upload the file again to check it against today's records.`, "expired");
  if (batch.sessionId !== input.sessionId) throw new ImportStateError("This preview was made for another session. Upload the file again.", "session");
  const file = batchFile(batch);
  if (!file || hasErrors(file.issues)) throw new ImportStateError("This file has problems to fix before it can be imported.", "blocked");

  const plan = await planImport(tx, { schoolId: input.schoolId, sessionId: input.sessionId, file, actorStaffId: input.actorStaffId, mayManageAdmins: input.mayManageAdmins });
  if (hasErrors(plan.issues)) throw new ImportStateError("Some rows no longer match the portal's records. Check the problems listed below.", "changed");
  if (planKey(plan.counts) !== input.expect) {
    throw new ImportStateError("The portal's records have changed since this preview was made (for example, someone added a student). The preview below is now up to date: check it and confirm again.", "changed");
  }

  // 1. Sections named in the file that don't exist yet.
  const sectionIds = new Map<string, string>();
  const existing = await tx
    .select({ id: sections.id, name: sections.name, className: classes.name })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(and(eq(classes.schoolId, input.schoolId), eq(sections.sessionId, input.sessionId)));
  for (const s of existing) sectionIds.set(sectionLabel(s.className, s.name), s.id);
  for (const s of plan.sectionsToCreate) {
    const made = await createSection(tx, input.schoolId, input.sessionId, s.classId, s.name, actor, "import");
    sectionIds.set(s.label, made.id);
  }

  const rowError = (sheet: "Students" | "Staff", row: number, who: string, err: unknown): never => {
    if (err instanceof RecordError) throw new RecordError(`${sheet} sheet, row ${row} (${who}): ${err.message} Nothing was imported.`);
    throw err;
  };

  // 2. Students.
  let admissionFees = 0;
  const newBySection = new Map<string, number>();
  const createdStudentIds: string[] = [];
  for (const p of plan.students) {
    if (p.kind === "same") continue;
    const sectionId = sectionIds.get(p.sectionLabel);
    if (!sectionId) throw new Error(`Section ${p.sectionLabel} is missing after creation.`);
    try {
      if (p.kind === "new") {
        const charge = input.chargeAdmissionFee && p.admittedThisSession;
        const made = await createStudent(tx, input.schoolId, input.sessionId, p.fields as StudentFields, { sectionId, rollNo: p.rollNo }, actor, { chargeAdmissionFee: charge });
        createdStudentIds.push(made.id);
        if (charge) admissionFees++;
        newBySection.set(sectionId, (newBySection.get(sectionId) ?? 0) + 1);
      } else {
        if (Object.keys(p.fields).length) await updateStudent(tx, input.schoolId, input.sessionId, p.studentId!, p.fields, actor);
        if (p.placementChanged) await placeStudent(tx, input.schoolId, input.sessionId, p.studentId!, sectionId, p.rollNo, actor);
      }
    } catch (err) {
      rowError("Students", p.row, `SR No. ${p.srNo}, ${p.name}`, err);
    }
  }

  // 3. Subjects named in "Subjects taught" that the school doesn't have yet.
  const addedSubject = new Map<string, string>();
  for (const s of plan.subjectsToAdd) {
    try {
      const made = await addSubject(tx, input.schoolId, { name: s.name, nameHi: s.nameHi }, actor, "import");
      addedSubject.set(`${NEW_SUBJECT}${s.key}`, made.id);
    } catch (err) {
      if (err instanceof RecordError) throw new RecordError(`Staff sheet, “Subjects taught”: ${err.message} Nothing was imported.`);
      throw err;
    }
  }
  const realSubjects = (ids: string[]) => ids.map((id) => (id.startsWith(NEW_SUBJECT) ? addedSubject.get(id) : id)).filter((id): id is string => !!id);

  // 4. Staff.
  const staffIdByRow = new Map<number, string>();
  let staffWithLogin = 0;
  const createdStaffIds: string[] = [];
  for (const p of plan.staff) {
    try {
      if (p.kind === "new") {
        const made = await createStaff(tx, input.schoolId, p.fields as StaffFields, actor);
        staffIdByRow.set(p.row, made.id);
        createdStaffIds.push(made.id);
        if (made.loginId) staffWithLogin++;
        if (p.subjectIds?.length) await setStaffSubjects(tx, input.schoolId, made.id, realSubjects(p.subjectIds), actor);
      } else {
        staffIdByRow.set(p.row, p.staffId!);
        if (p.kind === "update") {
          if (Object.keys(p.fields).length) await updateStaff(tx, input.schoolId, p.staffId!, p.fields, actor);
          if (p.subjectIds) await setStaffSubjects(tx, input.schoolId, p.staffId!, realSubjects(p.subjectIds), actor);
        }
      }
    } catch (err) {
      rowError("Staff", p.row, `Employee No. ${p.empNo}, ${p.name}`, err);
    }
  }

  // 5. Class teachers (after new staff exist).
  for (const m of plan.classTeacherMoves) {
    const sectionId = sectionIds.get(m.sectionLabel);
    if (!sectionId) continue;
    const staffId = m.staffRow !== null ? (staffIdByRow.get(m.staffRow) ?? null) : m.staffId;
    try {
      await setClassTeacher(tx, input.schoolId, sectionId, staffId, actor);
    } catch (err) {
      rowError("Staff", m.staffRow ?? 0, `class teacher of ${m.sectionLabel}`, err);
    }
  }

  const labelOf = new Map([...sectionIds].map(([label, id]) => [id, label]));
  const result: ImportResult = {
    ...plan.counts,
    sectionsCreated: plan.sectionsToCreate.map((s) => s.label),
    subjectsAdded: plan.subjectsToAdd.map((s) => s.name),
    admissionFees,
    slipSections: [...newBySection]
      .map(([id, n]) => ({ id, label: labelOf.get(id) ?? "", students: n }))
      .sort((a, b) => {
        const order = (label: string) => {
          const cls = label.slice(0, label.lastIndexOf("-"));
          const i = ["Nursery", "LKG", "UKG", ...ROMAN].indexOf(cls);
          return i < 0 ? 99 : i;
        };
        return order(a.label) - order(b.label) || a.label.localeCompare(b.label);
      }),
    staffWithLogin,
  };
  const summary: BatchSummary = {
    ...((batch.summary as unknown as BatchSummary | null) ?? { rows: file.rows, errors: 0, warnings: 0 }),
    result,
    created: { studentIds: createdStudentIds, staffIds: createdStaffIds },
  };
  await tx
    .update(importBatches)
    .set({ status: "imported", payload: null, summary: summary as unknown as Record<string, unknown>, finishedAt: new Date() })
    .where(eq(importBatches.id, batch.id));
  await audit(tx, actor, "import.completed", {
    schoolId: input.schoolId,
    targetType: "import",
    targetId: batch.id,
    details: { fileName: batch.fileName, ...plan.counts, sectionsCreated: result.sectionsCreated, subjectsAdded: result.subjectsAdded, admissionFees },
  });
  return result;
}

/* ================================================================== */
/* Reference data for checking a file                                  */
/* ================================================================== */

/** The school's classes and subjects, the session and today's date, as the checker needs them. */
export async function importReference(tx: Tx, schoolId: string, sessionId: string, today: string, canSwitchSchool: boolean): Promise<ImportReference> {
  const [schoolRows, classRows, subjectRows, sessionRows] = await Promise.all([
    tx.select({ name: schools.name, loginPrefix: schools.loginPrefix }).from(schools).where(eq(schools.id, schoolId)),
    tx.select({ name: classes.name, stream: classes.stream }).from(classes).where(eq(classes.schoolId, schoolId)).orderBy(asc(classes.sortOrder)),
    tx
      .select({ id: subjects.id, name: subjects.name, nameHi: subjects.nameHi })
      .from(subjects)
      .where(eq(subjects.schoolId, schoolId))
      .orderBy(asc(subjects.sortOrder), asc(subjects.name)),
    tx
      .select({ id: academicSessions.id, startsOn: academicSessions.startsOn, endsOn: academicSessions.endsOn })
      .from(academicSessions)
      .where(eq(academicSessions.id, sessionId)),
  ]);
  const school = schoolRows[0];
  const session = sessionRows[0];
  if (!school || !session || !isValidIsoDate(session.startsOn)) throw new Error("School or session not found.");
  return { school, canSwitchSchool, session, today, classes: classRows, subjects: subjectRows };
}

/** Section letters, re-exported for pages. */
export { SECTION_LETTERS };
