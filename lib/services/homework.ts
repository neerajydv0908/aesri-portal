/**
 * Homework set for a section (and usually a subject), and whether each
 * student did it: done, late, not done or excused. No check row means
 * "not checked yet".
 *
 * Who may do what is decided by the pages (lib/auth/dal: canTeach,
 * canManageSection). These functions check that records belong to the
 * school, keep the data consistent and write an audit entry for every change.
 */
import { and, asc, count, desc, eq, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import { classSubjects, homework, homeworkChecks, subjects } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import { addDays, isValidIsoDate } from "@/lib/dates";
import { cleanLongText, isUuid, peopleByAccount, sectionOf, sectionRoll, sessionBounds, type Person, type Writer } from "./attendance";
import { RecordError } from "./students";

export type HomeworkCheck = "done" | "late" | "not_done" | "excused";
export const HOMEWORK_CHECKS: readonly HomeworkCheck[] = ["done", "late", "not_done", "excused"];

export function isHomeworkCheck(v: unknown): v is HomeworkCheck {
  return typeof v === "string" && (HOMEWORK_CHECKS as readonly string[]).includes(v);
}

export const HOMEWORK_CHECK_LABELS: Record<HomeworkCheck, { en: string; hi: string }> = {
  done: { en: "Done", hi: "पूरा किया" },
  late: { en: "Late", hi: "देर से जमा किया" },
  not_done: { en: "Not done", hi: "नहीं किया" },
  excused: { en: "Excused", hi: "छूट दी गई" },
};
export const NOT_CHECKED_LABEL = { en: "Not checked yet", hi: "अभी जाँचा नहीं गया" };

/** Label for homework without a subject (set by the class teacher). */
export const GENERAL_SUBJECT = { en: "General", hi: "सामान्य" };

export const HOMEWORK_LIMITS = { title: 150, details: 2000 };

export type HomeworkFields = { title: string; details: string | null; assignedOn: string; dueOn: string };

/** Check typed values; returns the clean fields or a message per field. */
export function validateHomework(raw: {
  title: unknown;
  details: unknown;
  assignedOn: unknown;
  dueOn: unknown;
}): { ok: true; fields: HomeworkFields } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const title = cleanLongText(raw.title, HOMEWORK_LIMITS.title)?.replace(/\s+/g, " ") ?? null;
  const details = cleanLongText(raw.details, HOMEWORK_LIMITS.details);
  const assignedOn = typeof raw.assignedOn === "string" ? raw.assignedOn.trim() : "";
  const dueOn = typeof raw.dueOn === "string" ? raw.dueOn.trim() : "";
  if (!title) errors.title = "Write a short title, for example “Exercise 4.2, questions 1–10”.";
  if (!isValidIsoDate(assignedOn)) errors.assignedOn = "Choose the date the homework is set.";
  if (!isValidIsoDate(dueOn)) errors.dueOn = "Choose the date it is due.";
  else if (isValidIsoDate(assignedOn) && dueOn < assignedOn) errors.dueOn = "The due date can't be before the day it is set.";
  if (Object.keys(errors).length || !title) return { ok: false, errors };
  return { ok: true, fields: { title, details, assignedOn, dueOn } };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

async function loadHomework(tx: Tx, schoolId: string, homeworkId: string) {
  if (!isUuid(homeworkId)) throw new RecordError("That homework was not found.");
  const [hw] = await tx.select().from(homework).where(eq(homework.id, homeworkId));
  const sec = hw ? await sectionOf(tx, hw.sectionId) : null;
  if (!hw || !sec || sec.schoolId !== schoolId) throw new RecordError("That homework was not found.");
  return { hw, sec };
}

async function assertDatesInSession(tx: Tx, sessionId: string, f: HomeworkFields) {
  const b = await sessionBounds(sessionId, tx);
  if (f.assignedOn < b.startsOn || f.dueOn > b.endsOn) {
    throw new RecordError(`Homework dates must be inside the ${b.id} session (${b.startsOn} to ${b.endsOn}).`);
  }
}

/** Set homework for a section. `subjectId` null means general homework from the class teacher. */
export async function createHomework(
  tx: Tx,
  input: { schoolId: string; sectionId: string; subjectId: string | null } & HomeworkFields,
  actor: Writer,
): Promise<{ id: string }> {
  const sec = await sectionOf(tx, input.sectionId);
  if (!sec || sec.schoolId !== input.schoolId) throw new RecordError("Choose one of your classes.");
  if (input.subjectId) {
    const [taught] = await tx
      .select({ id: classSubjects.subjectId })
      .from(classSubjects)
      .where(and(eq(classSubjects.classId, sec.classId), eq(classSubjects.subjectId, input.subjectId)));
    if (!taught) throw new RecordError("That subject isn't taught in this class.");
  }
  if (input.dueOn < input.assignedOn) throw new RecordError("The due date can't be before the day it is set.");
  await assertDatesInSession(tx, sec.sessionId, input);
  const [row] = await tx
    .insert(homework)
    .values({
      sectionId: sec.id,
      subjectId: input.subjectId,
      title: input.title,
      details: input.details,
      assignedOn: input.assignedOn,
      dueOn: input.dueOn,
      createdBy: actor.accountId,
    })
    .returning({ id: homework.id });
  await audit(tx, actor, "homework.created", {
    schoolId: sec.schoolId,
    targetType: "homework",
    targetId: row.id,
    details: { section: sec.label, sectionId: sec.id, subjectId: input.subjectId, title: input.title, assignedOn: input.assignedOn, dueOn: input.dueOn },
  });
  return { id: row.id };
}

/** Change a homework's title, details or dates. The class and subject stay the same. */
export async function updateHomework(tx: Tx, schoolId: string, homeworkId: string, fields: HomeworkFields, actor: Writer): Promise<{ changed: string[] }> {
  const { hw, sec } = await loadHomework(tx, schoolId, homeworkId);
  if (fields.dueOn < fields.assignedOn) throw new RecordError("The due date can't be before the day it is set.");
  await assertDatesInSession(tx, sec.sessionId, fields);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of ["title", "details", "assignedOn", "dueOn"] as const) {
    if ((hw[k] ?? null) !== (fields[k] ?? null)) {
      before[k] = hw[k];
      after[k] = fields[k];
    }
  }
  const changed = Object.keys(after);
  if (!changed.length) return { changed };
  await tx.update(homework).set(after).where(eq(homework.id, hw.id));
  await audit(tx, actor, "homework.updated", { schoolId, targetType: "homework", targetId: hw.id, details: { section: sec.label, before, after } });
  return { changed };
}

/** Delete homework and every check recorded for it. */
export async function deleteHomework(tx: Tx, schoolId: string, homeworkId: string, actor: Writer): Promise<{ checksRemoved: number }> {
  const { hw, sec } = await loadHomework(tx, schoolId, homeworkId);
  const removed = await tx.delete(homeworkChecks).where(eq(homeworkChecks.homeworkId, hw.id)).returning({ studentId: homeworkChecks.studentId });
  await tx.delete(homework).where(eq(homework.id, hw.id));
  await audit(tx, actor, "homework.deleted", {
    schoolId,
    targetType: "homework",
    targetId: hw.id,
    details: {
      section: sec.label,
      sectionId: hw.sectionId,
      subjectId: hw.subjectId,
      title: hw.title,
      assignedOn: hw.assignedOn,
      dueOn: hw.dueOn,
      createdBy: hw.createdBy,
      checksRemoved: removed.length,
    },
  });
  return { checksRemoved: removed.length };
}

export type CheckCounts = Record<HomeworkCheck, number> & { checked: number };
const emptyCheckCounts = (): CheckCounts => ({ done: 0, late: 0, not_done: 0, excused: 0, checked: 0 });

/**
 * Record who did the homework. `status: null` means "not checked yet" and
 * removes an earlier check. Only students on the section's roll are
 * accepted; checks for anyone who has since left are kept as they were.
 */
export async function saveHomeworkChecks(
  tx: Tx,
  schoolId: string,
  homeworkId: string,
  marks: { studentId: string; status: HomeworkCheck | null }[],
  actor: Writer,
): Promise<{ changed: number; counts: CheckCounts }> {
  const { hw, sec } = await loadHomework(tx, schoolId, homeworkId);
  const roll = await sectionRoll(tx, sec.id);
  const onRoll = new Map(roll.map((s) => [s.id, s]));
  const existing = await tx
    .select({ studentId: homeworkChecks.studentId, status: homeworkChecks.status })
    .from(homeworkChecks)
    .where(eq(homeworkChecks.homeworkId, hw.id));
  const before = new Map(existing.map((e) => [e.studentId, e.status]));
  const now = new Date();
  const changes: { studentId: string; name: string; from: HomeworkCheck | null; to: HomeworkCheck | null }[] = [];
  const upserts: (typeof homeworkChecks.$inferInsert)[] = [];
  const clears: string[] = [];
  const seen = new Set<string>();
  for (const m of marks) {
    const s = onRoll.get(m.studentId);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    const to = isHomeworkCheck(m.status) ? m.status : null;
    const from = before.get(s.id) ?? null;
    if (from === to) continue;
    changes.push({ studentId: s.id, name: s.name, from, to });
    if (to) upserts.push({ homeworkId: hw.id, studentId: s.id, status: to, checkedBy: actor.accountId, checkedAt: now });
    else clears.push(s.id);
  }
  if (upserts.length) {
    await tx
      .insert(homeworkChecks)
      .values(upserts)
      .onConflictDoUpdate({
        target: [homeworkChecks.homeworkId, homeworkChecks.studentId],
        set: { status: sql`excluded.status`, checkedBy: sql`excluded.checked_by`, checkedAt: sql`excluded.checked_at` },
      });
  }
  if (clears.length) await tx.delete(homeworkChecks).where(and(eq(homeworkChecks.homeworkId, hw.id), inArray(homeworkChecks.studentId, clears)));

  const after = new Map(before);
  for (const c of changes) {
    if (c.to) after.set(c.studentId, c.to);
    else after.delete(c.studentId);
  }
  const counts = emptyCheckCounts();
  for (const status of after.values()) {
    counts[status]++;
    counts.checked++;
  }
  if (changes.length) {
    await audit(tx, actor, "homework.checked", {
      schoolId,
      targetType: "homework",
      targetId: hw.id,
      details: { section: sec.label, title: hw.title, counts, changes },
    });
  }
  return { changed: changes.length, counts };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export type HomeworkRow = {
  id: string;
  sectionId: string;
  subjectId: string | null;
  /** Null for general homework (see GENERAL_SUBJECT). */
  subjectName: string | null;
  subjectNameHi: string | null;
  title: string;
  details: string | null;
  assignedOn: string;
  dueOn: string;
  createdBy: string;
  createdByPerson: Person | null;
  createdAt: Date;
  checks: CheckCounts;
};

/**
 * Homework the reader may see, newest first. `scope` picks it:
 *  - `sectionIds`: all homework in these sections (class teachers, admins)
 *  - `pairs`: homework for these (section, subject) pairs (subject teachers)
 * Rows matching either are returned.
 */
export async function listHomework(
  scope: { sectionIds?: string[]; pairs?: { sectionId: string; subjectId: string }[] },
  opts: { limit?: number; onlySection?: string } = {},
): Promise<HomeworkRow[]> {
  const conds: SQL[] = [];
  if (scope.sectionIds?.length) conds.push(inArray(homework.sectionId, scope.sectionIds));
  for (const p of scope.pairs ?? []) conds.push(and(eq(homework.sectionId, p.sectionId), eq(homework.subjectId, p.subjectId))!);
  if (!conds.length) return [];
  const db = await getDb();
  const where = opts.onlySection ? and(or(...conds), eq(homework.sectionId, opts.onlySection)) : or(...conds);
  const rows = await db
    .select({
      id: homework.id,
      sectionId: homework.sectionId,
      subjectId: homework.subjectId,
      subjectName: subjects.name,
      subjectNameHi: subjects.nameHi,
      title: homework.title,
      details: homework.details,
      assignedOn: homework.assignedOn,
      dueOn: homework.dueOn,
      createdBy: homework.createdBy,
      createdAt: homework.createdAt,
    })
    .from(homework)
    .leftJoin(subjects, eq(subjects.id, homework.subjectId))
    .where(where)
    .orderBy(desc(homework.assignedOn), desc(homework.createdAt))
    .limit(opts.limit ?? 60);
  return withChecksAndPeople(rows);
}

async function withChecksAndPeople<T extends { id: string; createdBy: string }>(
  rows: T[],
): Promise<(T & { createdByPerson: Person | null; checks: CheckCounts })[]> {
  if (!rows.length) return [];
  const db = await getDb();
  const [tally, people] = await Promise.all([
    db
      .select({ homeworkId: homeworkChecks.homeworkId, status: homeworkChecks.status, n: count() })
      .from(homeworkChecks)
      .where(
        inArray(
          homeworkChecks.homeworkId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(homeworkChecks.homeworkId, homeworkChecks.status),
    peopleByAccount(rows.map((r) => r.createdBy)),
  ]);
  const byHw = new Map<string, CheckCounts>();
  for (const t of tally) {
    const c = byHw.get(t.homeworkId) ?? emptyCheckCounts();
    c[t.status] += Number(t.n);
    c.checked += Number(t.n);
    byHw.set(t.homeworkId, c);
  }
  return rows.map((r) => ({ ...r, createdByPerson: people.get(r.createdBy) ?? null, checks: byHw.get(r.id) ?? emptyCheckCounts() }));
}

/** One homework with its subject and author, or null. The caller checks access. */
export async function homeworkById(homeworkId: string): Promise<HomeworkRow | null> {
  if (!isUuid(homeworkId)) return null;
  const db = await getDb();
  const rows = await db
    .select({
      id: homework.id,
      sectionId: homework.sectionId,
      subjectId: homework.subjectId,
      subjectName: subjects.name,
      subjectNameHi: subjects.nameHi,
      title: homework.title,
      details: homework.details,
      assignedOn: homework.assignedOn,
      dueOn: homework.dueOn,
      createdBy: homework.createdBy,
      createdAt: homework.createdAt,
    })
    .from(homework)
    .leftJoin(subjects, eq(subjects.id, homework.subjectId))
    .where(eq(homework.id, homeworkId));
  return (await withChecksAndPeople(rows))[0] ?? null;
}

/** Each student's check for one homework (students without a check are "not checked yet"). */
export async function checksFor(homeworkId: string): Promise<Map<string, { status: HomeworkCheck; checkedAt: Date; checkedBy: string }>> {
  const db = await getDb();
  const rows = await db
    .select({ studentId: homeworkChecks.studentId, status: homeworkChecks.status, checkedAt: homeworkChecks.checkedAt, checkedBy: homeworkChecks.checkedBy })
    .from(homeworkChecks)
    .where(eq(homeworkChecks.homeworkId, homeworkId));
  return new Map(rows.map((r) => [r.studentId, { status: r.status, checkedAt: r.checkedAt, checkedBy: r.checkedBy }]));
}

export type FamilyHomework = {
  id: string;
  title: string;
  details: string | null;
  subjectName: string | null;
  subjectNameHi: string | null;
  assignedOn: string;
  dueOn: string;
  /** This child's check; null = not checked yet. */
  status: HomeworkCheck | null;
};

/**
 * Homework for a child's section, with the child's own status.
 *  - `upcoming`: due today or later, soonest first
 *  - `recent`: due in the last `recentDays` days (default 14), newest first
 * Homework set for a future day isn't shown until that day.
 */
export async function homeworkDueForFamily(
  studentId: string,
  sectionId: string | null,
  today: string,
  opts: { recentDays?: number; limit?: number } = {},
): Promise<{ upcoming: FamilyHomework[]; recent: FamilyHomework[] }> {
  if (!sectionId) return { upcoming: [], recent: [] };
  const db = await getDb();
  const from = addDays(today, -(opts.recentDays ?? 14));
  const rows = await db
    .select({
      id: homework.id,
      title: homework.title,
      details: homework.details,
      subjectName: subjects.name,
      subjectNameHi: subjects.nameHi,
      assignedOn: homework.assignedOn,
      dueOn: homework.dueOn,
    })
    .from(homework)
    .leftJoin(subjects, eq(subjects.id, homework.subjectId))
    .where(and(eq(homework.sectionId, sectionId), gte(homework.dueOn, from), lte(homework.assignedOn, today)))
    .orderBy(asc(homework.dueOn), asc(subjects.sortOrder), asc(homework.createdAt))
    .limit(opts.limit ?? 100);
  const checks = rows.length
    ? await db
        .select({ homeworkId: homeworkChecks.homeworkId, status: homeworkChecks.status })
        .from(homeworkChecks)
        .where(
          and(
            eq(homeworkChecks.studentId, studentId),
            inArray(
              homeworkChecks.homeworkId,
              rows.map((r) => r.id),
            ),
          ),
        )
    : [];
  const mine = new Map(checks.map((c) => [c.homeworkId, c.status]));
  const all = rows.map((r) => ({ ...r, status: mine.get(r.id) ?? null }));
  return { upcoming: all.filter((r) => r.dueOn >= today), recent: all.filter((r) => r.dueOn < today).reverse() };
}
