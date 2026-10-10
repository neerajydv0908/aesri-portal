/**
 * The "Needs support" colours, for teachers only (never families or students).
 * Most urgent first:
 *
 *   red    Needs support    Stud-AI's estimated risk of not passing the next exam is 50% or more in a
 *                           subject, OR attendance is below 70% together with 3 or more concerns in the
 *                           last 7 days
 *   amber  Review needed    none of that, but a subject's most recent exam result is below the school's
 *                           pass mark or absent (in any subject, estimated by Stud-AI or not)
 *   grey   Not enough data  none of that, and no current Stud-AI answer for every subject it was given:
 *                           no marks yet, Stud-AI isn't available, its results are out of date, a subject
 *                           got no answer, or only subjects it wasn't trained on
 *   green  On track         none of that: Stud-AI answered for every subject it was given, with an
 *                           estimate below 50% in each subject it was trained on
 *
 * Subjects Stud-AI was never trained on (Hindi, Sanskrit, EVS…) come back
 * without an estimate: "Not enough data as of now". They are listed as such
 * and don't hold a student back from green on their own, but their marks
 * still count through the pass-mark check, so a child failing one of them (or
 * absent from its latest exam) is never shown as on track. A result that
 * can't be read (an estimate without a percentage) counts as uncertain and
 * can never make a student green.
 *
 * The three attendance/concern settings are the school's settings (Settings → "Needs support"
 * colours); the defaults are in DEFAULT_SUPPORT_RULE. The pass mark is the
 * school's exam setting. Every reason behind red and amber is shown to the
 * teacher, with Stud-AI's result for each subject (lib/studai/estimates.ts).
 * Attendance counts once MIN_ATTENDANCE_DAYS register days are recorded.
 *
 * An estimate is a prompt to help a student early, not a judgement: it is
 * never shown to families or students, and never used for marks, promotion
 * or admission.
 *
 * Pure (no database), so the unit tests can check it.
 */
import type { SupportRuleSettings } from "@/lib/db/schema";
import {
  MIN_ATTENDANCE_DAYS,
  REMARK_AREA_WORDS,
  attendancePercent,
  examTrend,
  homeworkChecked,
  homeworkPercent,
  latestExam,
  latestSubjectResults,
  pct,
  round1,
  type StudentFigures,
} from "./figures";

export type SupportRule = SupportRuleSettings;

export const DEFAULT_SUPPORT_RULE: SupportRule = { attendanceRedPercent: 70, concernsRed: 3, concernDays: 7 };

/** Allowed values for each setting (whole numbers). */
export const SUPPORT_RULE_LIMITS: Record<keyof SupportRule, { min: number; max: number }> = {
  attendanceRedPercent: { min: 1, max: 100 },
  concernsRed: { min: 1, max: 20 },
  concernDays: { min: 1, max: 60 },
};

/** The school's rule with anything missing or out of range replaced by the default. */
export function resolveSupportRule(s: Partial<SupportRule> | null | undefined): SupportRule {
  const out = { ...DEFAULT_SUPPORT_RULE };
  for (const k of Object.keys(DEFAULT_SUPPORT_RULE) as (keyof SupportRule)[]) {
    const v = Number(s?.[k]);
    const { min, max } = SUPPORT_RULE_LIMITS[k];
    if (Number.isInteger(v) && v >= min && v <= max) out[k] = v;
  }
  return out;
}

/** Information that never changes the colour. */
export const SUPPORT_INFO = {
  /** Register days needed before attendance counts. */
  minAttendanceDays: MIN_ATTENDANCE_DAYS,
  /** Homework checks needed before homework counts (strengths only). */
  minHomeworkChecks: 3,
  /** "Recent" attendance, for the trend: the last 30 days against the rest of the session. */
  attendanceTrendDays: 30,
  /** Shown as a trend when those differ by this many points. */
  attendanceTrendPoints: 10,
  /** Strengths: attendance, homework and subject percentages at or above these. */
  strongAttendance: 90,
  strongHomework: 90,
  strongSubject: 75,
} as const;

export type SupportColour = "red" | "amber" | "grey" | "green";

/** Most urgent first: the order of the filter and of the list. */
export const COLOURS: readonly SupportColour[] = ["red", "amber", "grey", "green"];

export const COLOUR_WORDS: Record<SupportColour, string> = {
  red: "Needs support",
  amber: "Review needed",
  grey: "Not enough data yet",
  green: "On track",
};

export const isSupportColour = (v: unknown): v is SupportColour => typeof v === "string" && (COLOURS as readonly string[]).includes(v);

/** The school's pass mark (exam table, strengths and the "Review needed" check) and attendance warning level. */
export type Thresholds = { passPercent: number; attendanceWarnPercent: number };

/** The pass mark when the school's setting is missing or unusable (the same default as the exam pages). */
export const DEFAULT_PASS_PERCENT = 33;

/** Red at a Stud-AI estimate of this many percent or more (risk of not passing the next exam) in a subject. */
export const STUD_AI_RED_PERCENT = 50;

/** One subject's Stud-AI result, as the rule needs it. */
export type EstimateFigure = {
  /** The portal's subject (to match the result to what Stud-AI was given). */
  subjectId?: string;
  subjectName: string;
  /** The estimated risk of not passing the next exam, 1–99 (%); null when there is no estimate. */
  percent: number | null;
  /** False: Stud-AI wasn't trained on this subject, so it gave no estimate ("Not enough data as of now"). */
  knownSubject: boolean;
};

/**
 * Stud-AI wasn't trained on this subject, so it gave no estimate for it
 * ("Not enough data as of now").
 */
export const notCovered = (e: EstimateFigure): boolean => e.knownSubject === false;

type Kind = "needs_support" | "on_track" | "uncertain" | "misnamed" | "not_covered";

/** What a result means for the colour. Anything unexpected counts as uncertain, never as on track. */
function kindOf(e: EstimateFigure, misnamed: ReadonlyMap<string, string>): Kind {
  if (notCovered(e)) {
    // Not trained on it, but the name looks like a subject Stud-AI does cover ("English Core"): unsure, never ignored.
    return e.subjectId !== undefined && misnamed.has(e.subjectId) ? "misnamed" : "not_covered";
  }
  // An estimate needs its percentage; anything else can't be read, so it counts as uncertain.
  if (e.knownSubject !== true || typeof e.percent !== "number" || !Number.isFinite(e.percent)) return "uncertain";
  return e.percent >= STUD_AI_RED_PERCENT ? "needs_support" : "on_track";
}

/**
 * What else the rule needs to know about this student's Stud-AI results
 * (lib/studai/estimates.ts supportContext). Every field is required, so a
 * caller can't leave a check out by accident.
 */
export type SupportContext = {
  /** The page's Stud-AI state: "off" (not set up), "problem", "stale" or "ok". Green needs "ok" or "stale". */
  studAi: string;
  /** The saved results were worked out before the latest records and couldn't be updated: they can't make a student green. */
  outdated: boolean;
  /** The subjects Stud-AI was given with at least one test mark: each needs an answer before the student can be green. */
  given: { subjectId: string; subjectName: string }[];
  /** "Not covered" results to count as unsure: a name that looks like a subject Stud-AI covers (subject → that subject), or "" when its subject list couldn't be read. */
  misnamed: { subjectId: string; like: string }[];
};

export type SupportStatus = {
  colour: SupportColour;
  /** Why the student is red (empty otherwise). */
  reasons: string[];
  /** What a teacher should look at: why the student is amber, and shown with red too. */
  review: string[];
  /** Worth knowing, but not enough to change the colour on their own. */
  notes: string[];
  /** Subjects Stud-AI wasn't trained on: "Not enough data as of now" (listed for the teacher; their marks still count through the pass mark). */
  notCovered: string[];
  /** Results without an estimate whose name looks like a covered subject: shown as "Review needed" (subject → the subject it looks like). */
  misnamed: { subjectId: string; like: string }[];
  /** Positive facts. */
  strengths: string[];
  /** Changes over time (information only). */
  trends: string[];
  /** Why the student is grey, in words (null for the other colours). */
  greyWhy: string | null;
  /** The most urgent subject result Stud-AI gave, if any (needs support, then uncertain, then on track). */
  highest: EstimateFigure | null;
  attendance: number | null;
  homework: number | null;
  homeworkChecks: number;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The school's pass mark, or the default when it is missing or unusable (never 0, so marks are always checked). */
export function usablePassPercent(passPercent: number | null | undefined): number {
  const p = Number(passPercent);
  return Number.isFinite(p) && p > 0 ? Math.min(p, 100) : DEFAULT_PASS_PERCENT;
}

/** Apply the rule to one student's figures and Stud-AI results. `passPercent`: the school's pass mark. */
export function supportStatus(f: StudentFigures, estimates: EstimateFigure[], rule: SupportRule, passPercent: number, ctx: SupportContext): SupportStatus {
  const I = SUPPORT_INFO;
  const pass = usablePassPercent(passPercent);
  const reasons: string[] = [];
  const review: string[] = [];
  const notes: string[] = [];
  const strengths: string[] = [];
  const trends: string[] = [];

  // 1. Stud-AI's results. Subjects it wasn't trained on are listed, and never decide the colour by themselves.
  const misnamed = new Map(ctx.misnamed.map((m) => [m.subjectId, m.like]));
  const kind = (e: EstimateFigure) => kindOf(e, misnamed);
  const order: Record<Kind, number> = { needs_support: 0, uncertain: 1, misnamed: 1, on_track: 2, not_covered: 3 };
  const sorted = [...estimates].sort((a, b) => order[kind(a)] - order[kind(b)] || a.subjectName.localeCompare(b.subjectName));
  const covered = sorted.filter((e) => kind(e) !== "not_covered");
  const uncovered = sorted.filter((e) => kind(e) === "not_covered").map((e) => e.subjectName);
  for (const e of covered) {
    const k = kind(e);
    if (k === "needs_support") reasons.push(`${e.subjectName}: Stud-AI estimates a ${e.percent}% risk of not passing the next exam`);
    else if (k === "uncertain") review.push(`${e.subjectName}: Stud-AI’s result couldn’t be read, so check the marks`);
    else if (k === "misnamed") {
      const like = misnamed.get(e.subjectId!)!;
      review.push(
        like
          ? `${e.subjectName}: Stud-AI doesn’t recognise this subject name (it looks like ${like.replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase())}), so check the marks`
          : `${e.subjectName}: Stud-AI’s list of subjects it covers couldn’t be read, so check the marks`,
      );
    }
  }
  if (uncovered.length) notes.push(`not enough data as of now for Stud-AI to estimate ${uncovered.join(", ")} (check their marks yourself)`);

  // 2. Each subject's most recent exam result, covered by Stud-AI or not: below the pass mark (the
  //    report card's exact check, or the percentage) or absent needs a teacher's look.
  for (const { exam, subject: s } of latestSubjectResults(f.exams)) {
    if (s.absent && s.percent === null) review.push(`${s.name}: absent from ${exam.name}`);
    else if (s.percent !== null && (s.belowPass === true || s.percent / 10 < pass)) {
      const shown = s.percent / 10 < pass ? pct(s.percent / 10) : `just under ${pass}%`;
      review.push(`${s.name}: ${shown} in ${exam.name}, below the pass mark (${pass}%)`);
    }
  }

  // Stud-AI must have answered, with current results, for every subject it was given before anyone is green.
  const answered = new Set(estimates.map((e) => e.subjectId).filter((id): id is string => typeof id === "string"));
  const missing = (ctx.given ?? []).filter((g) => !answered.has(g.subjectId)).map((g) => g.subjectName);
  if (missing.length) notes.push(`Stud-AI couldn’t give a result for ${missing.join(", ")}`);
  if (ctx.outdated && estimates.length) notes.push("Stud-AI’s results are out of date: they were worked out before the latest records");

  // 3. Attendance together with concerns
  const att = attendancePercent(f.attendance, I.minAttendanceDays);
  const concerns = f.remarks.concernsRecent;
  const lowAtt = att !== null && att < rule.attendanceRedPercent;
  const manyConcerns = concerns >= rule.concernsRed;
  const concernWords = `${plural(concerns, "concern", "concerns")} in the last ${plural(rule.concernDays, "day", "days")}`;
  if (lowAtt && manyConcerns) reasons.push(`attendance ${pct(att!)} (below ${rule.attendanceRedPercent}%) and ${concernWords}`);
  else if (lowAtt) notes.push(`attendance ${pct(att!)}, below ${rule.attendanceRedPercent}%`);
  else if (manyConcerns) notes.push(concernWords);

  // Strengths (information only)
  if (att !== null && att >= I.strongAttendance) strengths.push(`attendance ${pct(att)}`);
  const exam = latestExam(f.exams);
  if (exam) {
    const good = exam.subjects.filter((s) => s.percent !== null && s.percent / 10 >= I.strongSubject).sort((a, b) => b.percent! - a.percent!);
    for (const g of good.slice(0, 3)) strengths.push(`${g.name} ${pct(g.percent! / 10)} in ${exam.name}`);
  }
  const checks = homeworkChecked(f.homework);
  const hw = homeworkPercent(f.homework, I.minHomeworkChecks);
  if (hw !== null && hw >= I.strongHomework) strengths.push(`homework done ${pct(hw)} of the time`);
  if (f.remarks.appreciations > 0) {
    const areas = f.remarks.appreciationAreas.map((a) => REMARK_AREA_WORDS[a]).join(", ");
    strengths.push(`${plural(f.remarks.appreciations, "appreciation", "appreciations")} this session${areas ? ` (${areas})` : ""}`);
  }

  // Trends (information only)
  const tr = examTrend(f.exams);
  if (tr && tr.trend !== "steady") {
    trends.push(`overall ${pct(tr.current.percent! / 10)} in ${tr.current.name}, ${tr.trend === "improving" ? "up" : "down"} from ${pct(tr.previous.percent! / 10)} in ${tr.previous.name}`);
  }
  const recent = attendancePercent(f.attendanceRecent, I.minAttendanceDays);
  if (att !== null && recent !== null) {
    const earlierDays = f.attendance.days - f.attendanceRecent.days;
    if (earlierDays >= I.minAttendanceDays) {
      const earlier = round1(((f.attendance.present + f.attendance.late - f.attendanceRecent.present - f.attendanceRecent.late) / earlierDays) * 100);
      if (Math.abs(recent - earlier) >= I.attendanceTrendPoints) trends.push(`attendance ${pct(recent)} in the last ${I.attendanceTrendDays} days, ${pct(earlier)} before that`);
    }
  }

  // Green only when nothing above applies, Stud-AI's results are current and complete, and its
  // estimate is below the red level in every subject it covers (at least one).
  const confident = covered.length > 0 && covered.every((e) => kind(e) === "on_track");
  const running = ctx.studAi === "ok" || ctx.studAi === "stale";
  const colour: SupportColour = reasons.length
    ? "red"
    : review.length
      ? "amber"
      : confident && running && !missing.length && !ctx.outdated
        ? "green"
        : "grey";
  return {
    colour,
    reasons,
    review,
    notes,
    notCovered: uncovered,
    misnamed: ctx.misnamed.filter((m) => estimates.some((e) => e.subjectId === m.subjectId)),
    strengths,
    trends,
    greyWhy: colour === "grey" ? noResultWords(ctx, { missing, onlyNotCovered: !covered.length && uncovered.length > 0 }) : null,
    highest: covered[0] ?? null,
    attendance: att,
    homework: hw,
    homeworkChecks: checks,
  };
}

/** Why a student is grey, in words. */
export function noResultWords(ctx: SupportContext, why: { missing: string[]; onlyNotCovered: boolean }): string {
  if (ctx.studAi !== "ok" && ctx.studAi !== "stale") return "No Stud-AI result: Stud-AI isn’t available on this server.";
  if (ctx.outdated) return "Stud-AI’s results are out of date: it couldn’t run just now.";
  if (why.missing.length) return `Stud-AI couldn’t give a result for ${why.missing.join(", ")}.`;
  if (why.onlyNotCovered) return "No Stud-AI estimate yet: not enough data as of now for the subjects with marks so far.";
  return "No estimate yet: there are no marks this session.";
}

/** The rule in plain words, for the page (with this school's numbers). */
export function ruleSentences(rule: SupportRule, passPercent: number): Record<SupportColour, string[]> {
  return {
    red: [
      `Stud-AI’s estimated risk of not passing the next exam is ${STUD_AI_RED_PERCENT}% or more in a subject.`,
      `Attendance below ${rule.attendanceRedPercent}% together with ${rule.concernsRed} or more concerns recorded in the last ${plural(rule.concernDays, "day", "days")}.`,
    ],
    amber: [
      `In any subject, the most recent exam mark is below the pass mark (${usablePassPercent(passPercent)}%), or the student was absent from it.`,
      "Stud-AI can’t use a subject’s result: its name looks like a subject Stud-AI covers but isn’t recognised, or the result can’t be read.",
    ],
    grey: ["None of the above, and no current Stud-AI result for every subject: no marks yet, Stud-AI isn’t available or is out of date, or not enough data as of now for the subjects with marks."],
    green: [`None of the above, and Stud-AI’s estimate is below ${STUD_AI_RED_PERCENT}% in every subject it was trained on.`],
  };
}
