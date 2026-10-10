/**
 * The class teacher's remark on each student's report card, one per exam,
 * written by the teacher. Like marks, remarks are locked once the section's
 * results for that exam are published, until an admin reopens them.
 * Families see a remark only on the published report card.
 *
 * Who may write them (the class teacher of the section, or an admin) is
 * checked by the page and action first (lib/page.ts, canManageSection);
 * this service checks the exam, section and students belong together and
 * writes an audit entry (counts only, not the text).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import { examPapers, examResults, exams, reportRemarks } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import { cleanLongText, isUuid, sectionOf, sectionRoll, type Writer } from "./attendance";
import { RecordError } from "./students";
import { expireHindi } from "@/lib/translate/cache";

/** Longest remark: it has to fit on the one-page report card with the marks. */
export const REPORT_REMARK_MAX = 600;

/** One box as the teacher left it: the text (empty = no remark). */
export type ReportRemarkEntry = { studentId: string; remark: string | null };

export type SaveReportRemarksResult = { written: number; cleared: number; withRemark: number; students: number };

/** Tidy a remark as typed: line breaks kept (no blank lines), spaces collapsed, at most REPORT_REMARK_MAX characters. */
export function cleanRemark(input: unknown): string | null {
  const s = cleanLongText(input, 10_000)?.replace(/\n{2,}/g, "\n") ?? null;
  return s ? s : null;
}

export async function saveReportRemarks(
  tx: Tx,
  scope: { schoolId: string; sessionId: string },
  ids: { examId: string; sectionId: string },
  entries: ReportRemarkEntry[],
  actor: Writer,
): Promise<SaveReportRemarksResult> {
  const [exam] = isUuid(ids.examId)
    ? await tx
        .select()
        .from(exams)
        .where(and(eq(exams.id, ids.examId), eq(exams.schoolId, scope.schoolId), eq(exams.sessionId, scope.sessionId)))
    : [];
  if (!exam) throw new RecordError("That exam was not found. Reload the page and try again.");
  const sec = await sectionOf(tx, ids.sectionId);
  if (!sec || sec.schoolId !== scope.schoolId || sec.sessionId !== scope.sessionId) throw new RecordError("That class section was not found. Reload the page and try again.");
  const [paper] = await tx
    .select({ id: examPapers.id })
    .from(examPapers)
    .where(and(eq(examPapers.examId, exam.id), eq(examPapers.classId, sec.classId)))
    .limit(1);
  if (!paper) throw new RecordError(`${exam.name} has no papers for ${sec.label}, so there is no report card to write on.`);

  // Locked like marks once the results are published (the row is locked for this transaction, as marks do).
  await tx.insert(examResults).values({ examId: exam.id, sectionId: sec.id }).onConflictDoNothing();
  const [state] = await tx
    .select({ status: examResults.status })
    .from(examResults)
    .where(and(eq(examResults.examId, exam.id), eq(examResults.sectionId, sec.id)))
    .for("update");
  if (state?.status === "published") {
    throw new RecordError(`${exam.name} results for ${sec.label} are published, so the report-card remarks are locked. Ask the office to reopen the results if a remark needs changing.`);
  }

  const roll = await sectionRoll(tx, sec.id);
  const onRoll = new Set(roll.map((s) => s.id));
  const seen = new Set<string>();
  const clean: { studentId: string; remark: string | null }[] = [];
  for (const e of entries) {
    if (!onRoll.has(e.studentId) || seen.has(e.studentId)) throw new RecordError("Some rows don't belong to this class any more. Reload the page and try again.");
    seen.add(e.studentId);
    const remark = cleanRemark(e.remark);
    if (remark && remark.length > REPORT_REMARK_MAX) throw new RecordError(`A remark can be at most ${REPORT_REMARK_MAX} characters, so it fits on the report card.`);
    clean.push({ studentId: e.studentId, remark });
  }

  const current = clean.length
    ? await tx
        .select({ studentId: reportRemarks.studentId, remark: reportRemarks.remark })
        .from(reportRemarks)
        .where(
          and(
            eq(reportRemarks.examId, exam.id),
            inArray(
              reportRemarks.studentId,
              clean.map((c) => c.studentId),
            ),
          ),
        )
    : [];
  const before = new Map(current.map((c) => [c.studentId, c]));

  const toClear: string[] = [];
  const toWrite: (typeof reportRemarks.$inferInsert)[] = [];
  const now = new Date();
  for (const c of clean) {
    const was = before.get(c.studentId);
    if (!c.remark) {
      if (was) toClear.push(c.studentId);
      continue;
    }
    if (was && was.remark === c.remark) continue;
    toWrite.push({ examId: exam.id, studentId: c.studentId, remark: c.remark, updatedBy: actor.accountId, updatedAt: now });
  }
  // The words being replaced or removed: their Hindi translation goes at the next daily clean-up (unless still read elsewhere).
  const replaced = [...toClear, ...toWrite.map((w) => w.studentId)].map((id) => before.get(id)?.remark ?? null);
  if (toClear.length) await tx.delete(reportRemarks).where(and(eq(reportRemarks.examId, exam.id), inArray(reportRemarks.studentId, toClear)));
  if (toWrite.length) {
    await tx
      .insert(reportRemarks)
      .values(toWrite)
      .onConflictDoUpdate({
        target: [reportRemarks.examId, reportRemarks.studentId],
        set: { remark: sql`excluded.remark`, updatedBy: sql`excluded.updated_by`, updatedAt: sql`excluded.updated_at` },
      });
  }
  await expireHindi(tx, replaced);

  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(reportRemarks)
    .where(
      and(
        eq(reportRemarks.examId, exam.id),
        roll.length
          ? inArray(
              reportRemarks.studentId,
              roll.map((r) => r.id),
            )
          : sql`false`,
      ),
    );
  if (toWrite.length || toClear.length) {
    await audit(tx, actor, "report_remarks.saved", {
      schoolId: scope.schoolId,
      targetType: "exam_result",
      targetId: `${exam.id}:${sec.id}`,
      details: {
        exam: exam.name,
        section: sec.label,
        written: toWrite.length,
        cleared: toClear.length,
        studentIds: [...toWrite.map((w) => w.studentId), ...toClear],
      },
    });
  }
  return { written: toWrite.length, cleared: toClear.length, withRemark: Number(n), students: roll.length };
}

export type SavedReportRemark = { remark: string; updatedBy: string; updatedAt: Date };

/** The saved remarks of one exam for some students. */
export async function reportRemarksFor(examId: string, studentIds: string[]): Promise<Map<string, SavedReportRemark>> {
  const out = new Map<string, SavedReportRemark>();
  if (!isUuid(examId) || !studentIds.length) return out;
  const db = await getDb();
  const rows = await db
    .select()
    .from(reportRemarks)
    .where(and(eq(reportRemarks.examId, examId), inArray(reportRemarks.studentId, studentIds)));
  for (const r of rows) out.set(r.studentId, { remark: r.remark, updatedBy: r.updatedBy, updatedAt: r.updatedAt });
  return out;
}
