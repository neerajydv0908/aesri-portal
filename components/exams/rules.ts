/**
 * Exam arithmetic shared by the server and the marks grid: reading typed
 * marks, rounding, pass marks and a student's overall result.
 *
 * Pure functions (no database, no React), so the numbers are identical on
 * every screen. Marks are handled as whole "tenths" (18.5 → 185) so sums and
 * comparisons are exact; percentages as tenths of a percent (74.0% → 740).
 */

/** Largest maximum a paper may have. */
export const MAX_PAPER_MARKS = 500;

export type MarkValue = { tenths: number | null; absent: boolean };

/** What teachers commonly type for "absent" in a marks box. */
const ABSENT_WORDS = new Set(["a", "ab", "abs", "absent", "अ", "अनु", "अनुपस्थित"]);

export type ParsedMark = { ok: true; tenths: number | null; absent: boolean } | { ok: false; error: string };

/**
 * Read one marks box. Accepts whole or half marks ("18", "18.5", "18,5"),
 * "AB" for absent, or an empty box (not entered yet).
 */
export function parseMarkInput(raw: string | null | undefined, absentTicked: boolean, max: number): ParsedMark {
  const s = (raw ?? "").trim();
  if (s && ABSENT_WORDS.has(s.toLowerCase())) return { ok: true, tenths: null, absent: true };
  if (absentTicked) {
    if (s) return { ok: false, error: "Marked absent, so leave the marks box empty (or untick Absent)." };
    return { ok: true, tenths: null, absent: true };
  }
  if (!s) return { ok: true, tenths: null, absent: false };
  const t = s.replace(",", ".");
  if (/^[-−–]/.test(t)) return { ok: false, error: "Marks can't be negative." };
  if (!/^(\d{1,4}(\.\d*)?|\.\d+)$/.test(t)) return { ok: false, error: `"${s}" is not a number. Type marks like 18 or 18.5, or tick Absent.` };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, error: `"${s}" is not a number. Type marks like 18 or 18.5, or tick Absent.` };
  const halves = n * 2;
  if (Math.abs(halves - Math.round(halves)) > 1e-9) return { ok: false, error: "Use whole or half marks, like 18 or 18.5." };
  const tenths = Math.round(halves) * 5;
  if (tenths > max * 10) return { ok: false, error: `${formatMarks(tenths)} is more than the maximum of ${max}.` };
  return { ok: true, tenths, absent: false };
}

/** A numeric(5,1) value from the database ("18.5") → 185. */
export function tenthsFromDb(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) : null;
}

/** 185 → "18.5" (for the database). */
export function tenthsToDb(tenths: number): string {
  return (tenths / 10).toFixed(1);
}

/** 185 → "18.5", 180 → "18", null → "—". */
export function formatMarks(tenths: number | null | undefined): string {
  if (tenths === null || tenths === undefined) return "—";
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
}

/** Percentage in tenths of a percent, rounded half up: 18.5 of 25 → 740 (74.0%). */
export function percentTenths(tenths: number, max: number): number {
  return max > 0 ? Math.round((tenths * 100) / max) : 0;
}

/** 740 → "74.0%", null → "—". */
export function formatPercent(pctTenths: number | null | undefined): string {
  if (pctTenths === null || pctTenths === undefined) return "—";
  return `${(pctTenths / 10).toFixed(1)}%`;
}

/** Does this mark reach the pass mark (a percentage of the maximum)? Exact, not rounded. */
export function passes(tenths: number, max: number, passPercent: number): boolean {
  return tenths * 10 >= passPercent * max - 1e-9;
}

/** The lowest whole-or-half mark that passes: 33% of 25 → 8.5 (85 tenths). */
export function minPassTenths(max: number, passPercent: number): number {
  const exact = Math.ceil((passPercent * max) / 10 - 1e-9);
  return Math.ceil(exact / 5) * 5;
}

/* ------------------------------------------------------------------ */
/* A student's result in one exam                                      */
/* ------------------------------------------------------------------ */

export type SubjectOutcome = "passed" | "below" | "absent" | "missing";
/** "absent": marked absent in every paper — no total, percentage or pass/fail, and left out of class averages. */
export type OverallOutcome = "passed" | "improve" | "incomplete" | "none" | "absent";

export type PaperRef = { subjectId: string; maxMarks: number };

export type SubjectLine<P extends PaperRef> = P & {
  tenths: number | null;
  outcome: SubjectOutcome;
  /** Tenths of a percent; null when absent or not entered. */
  percent: number | null;
};

export type StudentResult<P extends PaperRef> = {
  lines: SubjectLine<P>[];
  /** Marks obtained, in tenths (a paper missed through absence counts as 0). */
  totalTenths: number;
  /** Sum of the maxima of subjects with marks or marked absent; 0 when the student sat no paper. */
  maxTotal: number;
  /** Overall percentage in tenths; null when the student has no marks in any paper (nothing entered, or absent throughout). */
  percent: number | null;
  /** Marks at or above the pass mark in every subject. */
  passedAll: boolean;
  /** Subjects below the pass mark or missed (absent). */
  needsImprovement: SubjectLine<P>[];
  /** Subjects with no marks entered. */
  missing: SubjectLine<P>[];
  outcome: OverallOutcome;
};

/**
 * Work out a student's result from the exam's papers for their class and
 * their marks. Subjects without marks are left out of the total and listed
 * as missing. A paper missed through absence counts as 0 marks when the
 * student sat other papers; a student absent from every paper entered has no
 * total or percentage (outcome "absent" once every paper is entered), so they
 * aren't shown as scoring 0% and don't pull down the class average.
 */
export function computeResult<P extends PaperRef>(papers: P[], marks: Map<string, MarkValue> | undefined, passPercent: number): StudentResult<P> {
  const lines: SubjectLine<P>[] = papers.map((p) => {
    const m = marks?.get(p.subjectId);
    if (m?.absent) return { ...p, tenths: null, outcome: "absent", percent: null };
    if (!m || m.tenths === null) return { ...p, tenths: null, outcome: "missing", percent: null };
    return {
      ...p,
      tenths: m.tenths,
      outcome: passes(m.tenths, p.maxMarks, passPercent) ? "passed" : "below",
      percent: percentTenths(m.tenths, p.maxMarks),
    };
  });
  const satAny = lines.some((l) => l.outcome === "passed" || l.outcome === "below");
  let totalTenths = 0;
  let maxTotal = 0;
  if (satAny) {
    for (const l of lines) {
      if (l.outcome === "missing") continue;
      totalTenths += l.tenths ?? 0;
      maxTotal += l.maxMarks;
    }
  }
  const needsImprovement = lines.filter((l) => l.outcome === "below" || l.outcome === "absent");
  const missing = lines.filter((l) => l.outcome === "missing");
  const passedAll = lines.length > 0 && lines.every((l) => l.outcome === "passed");
  const absentAll = lines.length > 0 && lines.every((l) => l.outcome === "absent");
  const outcome: OverallOutcome =
    !lines.length || missing.length === lines.length
      ? "none"
      : absentAll
        ? "absent"
        : passedAll
          ? "passed"
          : satAny && needsImprovement.length
            ? "improve"
            : "incomplete";
  return {
    lines,
    totalTenths,
    maxTotal,
    percent: maxTotal > 0 ? Math.round((totalTenths * 100) / maxTotal) : null,
    passedAll,
    needsImprovement,
    missing,
    outcome,
  };
}

/** Average of several percentages (tenths), rounded; null for none. */
export function averagePercent(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

/** Hindi for the usual exam names ("Unit Test 1" → "इकाई परीक्षा 1"); other names are kept as typed. */
export function examNameHi(name: string): string {
  const s = name.trim();
  let m = /^unit\s*test\s*[-–]?\s*(\d+)$/i.exec(s);
  if (m) return `इकाई परीक्षा ${m[1]}`;
  m = /^(?:periodic\s*test|pt)\s*[-–]?\s*(\d+)$/i.exec(s);
  if (m) return `आवधिक परीक्षा ${m[1]}`;
  if (/^half[\s-]*yearly(\s+exam(ination)?)?$/i.test(s)) return "अर्धवार्षिक परीक्षा";
  if (/^(annual|final|yearly)(\s+exam(ination)?)?$/i.test(s)) return "वार्षिक परीक्षा";
  if (/^quarterly(\s+exam(ination)?)?$/i.test(s)) return "त्रैमासिक परीक्षा";
  if (/^pre[\s-]*board(\s+exam(ination)?)?$/i.test(s)) return "प्री-बोर्ड परीक्षा";
  return s;
}
