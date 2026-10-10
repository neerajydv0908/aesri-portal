/**
 * Demo data: Exams, marks and results. Fictional only — see lib/demo/core.ts.
 *
 *   Unit Test 1   25 marks per subject, fully marked and published everywhere.
 *   Half-yearly   100 marks (50 for Nursery–UKG, where they have subjects);
 *                 about half the sections published, the rest sent to the
 *                 office or still open (some with marks missing, one empty).
 *
 * Marks follow a realistic spread: most students between 50% and 90%, a few
 * below the pass mark in a subject and one or two absences per exam. Rows are
 * inserted in batches, deterministically (same demo every time).
 */
import { inArray } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { accounts, auditLog, classSubjects, examPapers, examResults, exams, marks, teachingAssignments } from "@/lib/db/schema";
import { sectionLabel } from "@/lib/classes";
import type { DemoContext, DemoSection } from "./core";

const PRE_PRIMARY = ["Nursery", "LKG", "UKG"];

/** Small deterministic random numbers (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A date and time in IST. */
const ist = (iso: string, time = "11:00") => new Date(`${iso}T${time}:00+05:30`);

async function insertInChunks<T>(rows: T[], size: number, insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

type HalfYearlyState = "published" | "submitted" | "open-partial" | "open-empty";

export async function seedDemoExams(tx: Tx, ctx: DemoContext): Promise<string[]> {
  const log: string[] = [];

  for (const [si, school] of ctx.schools.entries()) {
    const r = rng(2026 + si * 101);
    const { schoolId } = school;

    // Who enters and who publishes
    const staffIds = [school.principalId, ...school.teacherIds];
    const accRows = await tx.select({ id: accounts.id, staffId: accounts.staffId, loginId: accounts.loginId }).from(accounts).where(inArray(accounts.staffId, staffIds));
    const accOf = new Map(accRows.map((a) => [a.staffId!, a]));
    const principal = accOf.get(school.principalId) ?? { id: ctx.adminAccountId, loginId: "aesri.demo" };

    const secIds = school.sections.map((s) => s.id);
    const classIds = [...new Set(school.sections.map((s) => s.classId))];
    const [cs, ta] = await Promise.all([
      tx.select().from(classSubjects).where(inArray(classSubjects.classId, classIds)),
      tx.select().from(teachingAssignments).where(inArray(teachingAssignments.sectionId, secIds)),
    ]);
    const subjectsOf = (classId: string) => cs.filter((c) => c.classId === classId).map((c) => c.subjectId);
    const teacherAccount = (sectionId: string, subjectId: string) => {
      const staffId = ta.find((t) => t.sectionId === sectionId && t.subjectId === subjectId)?.staffId;
      return (staffId && accOf.get(staffId)?.id) || principal.id;
    };

    const [ut1, hy] = await tx
      .insert(exams)
      .values([
        { schoolId, sessionId: ctx.sessionId, name: "Unit Test 1", sortOrder: 1, createdAt: ist("2026-07-01", "10:00") },
        { schoolId, sessionId: ctx.sessionId, name: "Half-yearly", sortOrder: 2, createdAt: ist("2026-08-25", "10:00") },
      ])
      .returning();

    // Papers: every subject taught in the class
    const classNameOf = new Map(school.sections.map((s) => [s.classId, s.className]));
    const paperRows: (typeof examPapers.$inferInsert)[] = [];
    const maxOf = new Map<string, number>(); // `${examId}:${classId}` → max
    for (const classId of classIds) {
      const subs = subjectsOf(classId);
      if (!subs.length) continue;
      const pre = PRE_PRIMARY.includes(classNameOf.get(classId)!);
      maxOf.set(`${ut1.id}:${classId}`, 25);
      maxOf.set(`${hy.id}:${classId}`, pre ? 50 : 100);
      for (const subjectId of subs) {
        paperRows.push({ examId: ut1.id, classId, subjectId, maxMarks: 25 });
        paperRows.push({ examId: hy.id, classId, subjectId, maxMarks: pre ? 50 : 100 });
      }
    }
    if (paperRows.length) await tx.insert(examPapers).values(paperRows);

    const examined = school.sections.filter((s) => subjectsOf(s.classId).length > 0);
    // Each student's general ability (0.5–0.9, centred on 0.7)
    const ability = new Map<string, number>();
    for (const s of examined) for (const id of s.studentIds) ability.set(id, 0.5 + 0.4 * ((r() + r()) / 2));
    // Some subjects are harder than others
    const difficulty = new Map<string, number>();
    for (const c of cs) if (!difficulty.has(c.subjectId)) difficulty.set(c.subjectId, (r() - 0.5) * 0.1);

    // A few weak papers (below the pass mark) and one or two absences per exam
    const allPairs = examined.flatMap((s) => s.studentIds.flatMap((studentId) => subjectsOf(s.classId).map((subjectId) => `${studentId}:${subjectId}`)));
    const pickSome = (n: number) => {
      const out = new Set<string>();
      while (out.size < Math.min(n, allPairs.length)) out.add(allPairs[Math.floor(r() * allPairs.length)]);
      return out;
    };

    const markRows: (typeof marks.$inferInsert)[] = [];
    const addMarks = (
      examId: string,
      sec: DemoSection,
      opts: { weak: Set<string>; absent: Set<string>; enteredOn: string; skip?: (studentIdx: number, subjectIdx: number) => boolean },
    ) => {
      const max = maxOf.get(`${examId}:${sec.classId}`)!;
      const subs = subjectsOf(sec.classId);
      sec.studentIds.forEach((studentId, i) => {
        subs.forEach((subjectId, j) => {
          if (opts.skip?.(i, j)) return;
          const key = `${studentId}:${subjectId}`;
          const base = {
            examId,
            studentId,
            subjectId,
            enteredBy: teacherAccount(sec.id, subjectId),
            enteredAt: ist(opts.enteredOn, `${String(10 + (j % 6)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}`),
          };
          if (opts.absent.has(key)) {
            markRows.push({ ...base, marks: null, absent: true });
            return;
          }
          let pct = opts.weak.has(key) ? 0.16 + r() * 0.14 : ability.get(studentId)! + difficulty.get(subjectId)! + (r() - 0.5) * 0.16;
          pct = Math.min(0.98, Math.max(opts.weak.has(key) ? 0.1 : 0.36, pct));
          const tenths = Math.round(pct * max * 2) * 5; // whole or half marks
          markRows.push({ ...base, marks: (tenths / 10).toFixed(1), absent: false });
        });
      });
    };

    const resultRows: (typeof examResults.$inferInsert)[] = [];
    const auditRows: (typeof auditLog.$inferInsert)[] = [];
    const logEvent = (action: string, at: Date, by: { id: string; loginId: string }, examId: string, sec: DemoSection, examName: string) =>
      auditRows.push({
        at,
        actorId: by.id,
        actorLogin: by.loginId,
        schoolId,
        action,
        targetType: "exam_result",
        targetId: `${examId}:${sec.id}`,
        details: { exam: examName, section: sectionLabel(sec.className, sec.name), demo: true },
      });

    // Unit Test 1 — everything marked and published
    const utWeak = pickSome(3);
    const utAbsent = pickSome(1 + Math.floor(r() * 2));
    for (const [k, sec] of examined.entries()) {
      addMarks(ut1.id, sec, { weak: utWeak, absent: utAbsent, enteredOn: "2026-07-20" });
      const publishedAt = ist("2026-07-25", `${String(10 + (k % 5)).padStart(2, "0")}:15`);
      resultRows.push({ examId: ut1.id, sectionId: sec.id, status: "published", publishedBy: principal.id, publishedAt });
      logEvent("exam.results_published", publishedAt, principal, ut1.id, sec, ut1.name);
    }

    // Half-yearly — in progress: about half published, the rest sent to the office or still open
    const hyWeak = pickSome(4);
    const hyAbsent = pickSome(1 + Math.floor(r() * 2));
    const counts: Record<HalfYearlyState, number> = { published: 0, submitted: 0, "open-partial": 0, "open-empty": 0 };
    for (const [k, sec] of examined.entries()) {
      const state: HalfYearlyState = k === examined.length - 1 ? "open-empty" : k % 2 === 1 ? "published" : k % 4 === 0 ? "submitted" : "open-partial";
      counts[state]++;
      const subs = subjectsOf(sec.classId);
      if (state === "open-empty") continue; // no marks yet: nothing recorded
      addMarks(hy.id, sec, {
        weak: hyWeak,
        absent: hyAbsent,
        enteredOn: "2026-09-24",
        // Still being marked: the last subject not started, the first missing one student
        skip: state === "open-partial" ? (i, j) => j === subs.length - 1 || (j === 0 && i === sec.studentIds.length - 1) : undefined,
      });
      const teacher = (sec.classTeacherId && accOf.get(sec.classTeacherId)) || principal;
      if (state === "published") {
        const submittedAt = ist("2026-09-25", "14:30");
        const publishedAt = ist("2026-09-26", `${String(10 + (k % 5)).padStart(2, "0")}:30`);
        resultRows.push({ examId: hy.id, sectionId: sec.id, status: "published", publishedBy: principal.id, publishedAt });
        logEvent("exam.results_submitted", submittedAt, teacher, hy.id, sec, hy.name);
        logEvent("exam.results_published", publishedAt, principal, hy.id, sec, hy.name);
      } else if (state === "submitted") {
        resultRows.push({ examId: hy.id, sectionId: sec.id, status: "submitted" });
        logEvent("exam.results_submitted", ist("2026-09-27", "13:45"), teacher, hy.id, sec, hy.name);
      } else {
        resultRows.push({ examId: hy.id, sectionId: sec.id, status: "open" });
      }
    }

    await insertInChunks(markRows, 500, (chunk) => tx.insert(marks).values(chunk));
    if (resultRows.length) await tx.insert(examResults).values(resultRows);
    if (auditRows.length) await tx.insert(auditLog).values(auditRows);

    log.push(
      `Exams (${schoolId}): Unit Test 1 published in ${examined.length} sections; Half-yearly published in ${counts.published}, ` +
        `sent to office in ${counts.submitted}, open in ${counts["open-partial"] + counts["open-empty"]} · ${markRows.length} marks`,
    );
  }
  return log;
}
