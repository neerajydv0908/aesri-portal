/**
 * Teachers' remarks about a student: appreciation as well as concerns (what
 * the school calls "complaints"). Each has a category, the teacher's note,
 * any action taken, and whether the family can see it.
 *
 * Categories are stored as stable keys (e.g. "behaviour") so the records can
 * be counted and analysed later; the words shown are in REMARK_CATEGORIES.
 * There are deliberately no health or medical categories.
 *
 * Who sees which remarks is decided here, by the RemarkReader every read and
 * change is given (see remarkReaderCondition):
 *  - class teachers see and manage every remark about the students of their
 *    sections, and admins every remark in the school;
 *  - a subject teacher may add remarks about students of the sections they
 *    teach, but sees and changes only the remarks they wrote themselves;
 *  - families see only remarks about their child that were shared with them.
 * Pages still check the student is one the person works with (canSeeStudent).
 * Every change is audited, including what an edit replaced.
 *
 * When a remark is shared with the family (written as shared, or changed
 * from staff-only to shared) the family gets a text message saying there is
 * a new note and to read it on the portal — never the note itself
 * (lib/sms/outbox.ts). Deleting it or making it staff-only before the
 * message goes withdraws the message.
 */
import { and, count, desc, eq, gte, inArray, or, type SQL } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import { enrolments, remarks, students } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import type { Lang } from "@/lib/i18n";
import { queueRemark, withdrawRemark, type SimpleSmsResult } from "@/lib/sms/outbox";
import { expireHindi } from "@/lib/translate/cache";
import { cleanLongText, isUuid, peopleByAccount, type Person, type Writer } from "./attendance";
import { RecordError } from "./students";

export type RemarkKind = "appreciation" | "concern";
export const REMARK_KINDS: readonly RemarkKind[] = ["appreciation", "concern"];

export const REMARK_KIND_LABELS: Record<RemarkKind, { en: string; hi: string }> = {
  appreciation: { en: "Appreciation", hi: "सराहना" },
  concern: { en: "Concern", hi: "चिंता" },
};

export const REMARK_CATEGORIES = [
  { key: "studies", en: "Studies", hi: "पढ़ाई" },
  { key: "homework", en: "Homework", hi: "गृहकार्य" },
  { key: "behaviour", en: "Behaviour", hi: "व्यवहार" },
  { key: "attendance", en: "Attendance & punctuality", hi: "उपस्थिति और समय की पाबंदी" },
  { key: "participation", en: "Participation & activities", hi: "भागीदारी और गतिविधियाँ" },
  { key: "other", en: "Other", hi: "अन्य" },
] as const;
export type RemarkCategory = (typeof REMARK_CATEGORIES)[number]["key"];

export function isRemarkCategory(v: unknown): v is RemarkCategory {
  return REMARK_CATEGORIES.some((c) => c.key === v);
}

export function remarkCategoryLabel(key: string, lang: Lang = "en"): string {
  const c = REMARK_CATEGORIES.find((x) => x.key === key);
  return c ? c[lang] : key;
}

export const REMARK_LIMITS = { note: 1000, actionTaken: 500 };

export type RemarkFields = {
  kind: RemarkKind;
  category: RemarkCategory;
  note: string;
  actionTaken: string | null;
  visibleToGuardian: boolean;
};

/** Check typed values; returns the clean fields or a message per field. */
export function validateRemark(raw: {
  kind: unknown;
  category: unknown;
  note: unknown;
  actionTaken: unknown;
  visibleToGuardian: boolean;
}): { ok: true; fields: RemarkFields } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const note = cleanLongText(raw.note, REMARK_LIMITS.note);
  const actionTaken = cleanLongText(raw.actionTaken, REMARK_LIMITS.actionTaken);
  if (raw.kind !== "appreciation" && raw.kind !== "concern") errors.kind = "Choose Appreciation or Concern.";
  if (!isRemarkCategory(raw.category)) errors.category = "Choose what the remark is about.";
  if (!note) errors.note = "Write the remark: what happened, in a sentence or two.";
  if (Object.keys(errors).length || !note || !isRemarkCategory(raw.category)) return { ok: false, errors };
  return { ok: true, fields: { kind: raw.kind as RemarkKind, category: raw.category, note, actionTaken, visibleToGuardian: raw.visibleToGuardian } };
}

/* ------------------------------------------------------------------ */
/* Who may see which remarks                                           */
/* ------------------------------------------------------------------ */

/**
 * Who is reading or changing remarks:
 *  - `{ familyOf }`: a family, for their own child;
 *  - staff: their account, the session, whether they see the whole school
 *    (admins), and the sections where they are class teacher.
 */
export type RemarkReader =
  | { familyOf: string }
  | { accountId: string; sessionId: string; wholeSchool: boolean; classTeacherOf: readonly string[] };

/** The reader for a teaching page (/teach/*): admins see the whole school, teachers their own classes in full and their own remarks elsewhere. */
export function staffRemarkReader(ctx: {
  actor: { accountId: string };
  sessionId: string;
  isAdmin: boolean;
  classTeacherSections: readonly { id: string }[];
}): RemarkReader {
  return { accountId: ctx.actor.accountId, sessionId: ctx.sessionId, wholeSchool: ctx.isAdmin, classTeacherOf: ctx.classTeacherSections.map((s) => s.id) };
}

/**
 * The remarks this reader may see (and, for staff, change):
 *  - families: remarks about their child that were shared with them;
 *  - admins: every remark in the school (the caller always narrows to the school);
 *  - teachers: every remark about students now in a section where they are
 *    class teacher, and the remarks they wrote themselves.
 */
export function remarkReaderCondition(db: Tx, reader: RemarkReader): SQL | undefined {
  if ("familyOf" in reader) return and(eq(remarks.studentId, reader.familyOf), eq(remarks.visibleToGuardian, true));
  if (reader.wholeSchool) return undefined;
  const own = eq(remarks.recordedBy, reader.accountId);
  if (!reader.classTeacherOf.length) return own;
  const inTheirClasses = db
    .select({ id: enrolments.studentId })
    .from(enrolments)
    .where(and(eq(enrolments.sessionId, reader.sessionId), inArray(enrolments.sectionId, [...reader.classTeacherOf])));
  return or(own, inArray(remarks.studentId, inTheirClasses));
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export async function createRemark(
  tx: Tx,
  input: { schoolId: string; studentId: string; recordedOn: string } & RemarkFields,
  actor: Writer,
): Promise<{ id: string; sms: SimpleSmsResult | null }> {
  const [s] = isUuid(input.studentId) ? await tx.select({ schoolId: students.schoolId }).from(students).where(eq(students.id, input.studentId)) : [];
  if (!s || s.schoolId !== input.schoolId) throw new RecordError("Choose a student of this school.");
  const [row] = await tx
    .insert(remarks)
    .values({
      schoolId: input.schoolId,
      studentId: input.studentId,
      kind: input.kind,
      category: input.category,
      note: input.note,
      actionTaken: input.actionTaken,
      recordedOn: input.recordedOn,
      recordedBy: actor.accountId,
      visibleToGuardian: input.visibleToGuardian,
    })
    .returning({ id: remarks.id });
  await audit(tx, actor, "remark.created", {
    schoolId: input.schoolId,
    targetType: "remark",
    targetId: row.id,
    details: { studentId: input.studentId, kind: input.kind, category: input.category, visibleToGuardian: input.visibleToGuardian },
  });
  const sms = input.visibleToGuardian
    ? await queueRemark(tx, { schoolId: input.schoolId, remarkId: row.id, studentId: input.studentId, kind: input.kind, createdBy: actor.accountId })
    : null;
  return { id: row.id, sms };
}

/** A remark of this school that this member of staff may change (families change nothing), locked for the change. */
async function loadRemark(tx: Tx, schoolId: string, reader: RemarkReader, remarkId: string) {
  const [r] =
    isUuid(remarkId) && !("familyOf" in reader)
      ? await tx
          .select()
          .from(remarks)
          .where(and(eq(remarks.id, remarkId), eq(remarks.schoolId, schoolId), remarkReaderCondition(tx, reader)))
          .for("update")
      : [];
  if (!r) throw new RecordError("That remark was not found.");
  return r;
}

/** Change a remark. The audit entry keeps what each changed field said before. */
export async function updateRemark(
  tx: Tx,
  schoolId: string,
  reader: RemarkReader,
  remarkId: string,
  fields: RemarkFields,
  actor: Writer,
): Promise<{ changed: string[]; sms: SimpleSmsResult | null }> {
  const cur = await loadRemark(tx, schoolId, reader, remarkId);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of ["kind", "category", "note", "actionTaken", "visibleToGuardian"] as const) {
    if ((cur[k] ?? null) !== (fields[k] ?? null)) {
      before[k] = cur[k];
      after[k] = fields[k];
    }
  }
  const changed = Object.keys(after);
  if (!changed.length) return { changed, sms: null };
  await tx.update(remarks).set(after).where(eq(remarks.id, cur.id));
  await audit(tx, actor, "remark.updated", { schoolId, targetType: "remark", targetId: cur.id, details: { studentId: cur.studentId, before, after } });
  let sms: SimpleSmsResult | null = null;
  if (cur.visibleToGuardian && !fields.visibleToGuardian) {
    await withdrawRemark(tx, cur.id, "The remark was made staff-only before the message was sent.");
  } else if (fields.visibleToGuardian && (!cur.visibleToGuardian || cur.kind !== fields.kind)) {
    // Newly shared — or its kind changed before the message went, so the waiting message would say the wrong kind.
    if (cur.visibleToGuardian) await withdrawRemark(tx, cur.id, "The remark was changed before the message was sent.");
    sms = await queueRemark(tx, { schoolId, remarkId: cur.id, studentId: cur.studentId, kind: fields.kind, createdBy: actor.accountId });
  }
  // What the family no longer sees: its Hindi translation goes at the next daily clean-up.
  if (cur.visibleToGuardian) {
    const hidden = !fields.visibleToGuardian;
    await expireHindi(tx, [hidden || "note" in after ? cur.note : null, hidden || "actionTaken" in after ? cur.actionTaken : null]);
  }
  return { changed, sms };
}

/** Delete a remark. The audit entry keeps a copy of what it said. */
export async function deleteRemark(tx: Tx, schoolId: string, reader: RemarkReader, remarkId: string, actor: Writer): Promise<void> {
  const cur = await loadRemark(tx, schoolId, reader, remarkId);
  await withdrawRemark(tx, cur.id, "The remark was deleted before the message was sent.");
  await tx.delete(remarks).where(eq(remarks.id, cur.id));
  if (cur.visibleToGuardian) await expireHindi(tx, [cur.note, cur.actionTaken]);
  await audit(tx, actor, "remark.deleted", {
    schoolId,
    targetType: "remark",
    targetId: cur.id,
    details: {
      studentId: cur.studentId,
      kind: cur.kind,
      category: cur.category,
      note: cur.note,
      actionTaken: cur.actionTaken,
      recordedOn: cur.recordedOn,
      recordedBy: cur.recordedBy,
      visibleToGuardian: cur.visibleToGuardian,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export type RemarkRow = {
  id: string;
  studentId: string;
  studentName: string;
  rollNo: number | null;
  kind: RemarkKind;
  category: string;
  note: string;
  actionTaken: string | null;
  recordedOn: string;
  recordedBy: string;
  recordedByPerson: Person | null;
  visibleToGuardian: boolean;
  createdAt: Date;
};

/**
 * The remarks in a school this reader may see, newest first, for some
 * students (or one). Roll numbers are for the given session.
 */
export async function listRemarks(
  reader: RemarkReader,
  opts: {
    schoolId: string;
    studentIds?: string[];
    kind?: RemarkKind;
    sessionId?: string;
    limit?: number;
  },
): Promise<RemarkRow[]> {
  if (opts.studentIds && !opts.studentIds.length) return [];
  const db = await getDb();
  const conds: (SQL | undefined)[] = [eq(remarks.schoolId, opts.schoolId), remarkReaderCondition(db, reader)];
  if (opts.studentIds) conds.push(inArray(remarks.studentId, opts.studentIds));
  if (opts.kind) conds.push(eq(remarks.kind, opts.kind));
  const rows = await db
    .select({
      id: remarks.id,
      studentId: remarks.studentId,
      studentName: students.name,
      rollNo: enrolments.rollNo,
      kind: remarks.kind,
      category: remarks.category,
      note: remarks.note,
      actionTaken: remarks.actionTaken,
      recordedOn: remarks.recordedOn,
      recordedBy: remarks.recordedBy,
      visibleToGuardian: remarks.visibleToGuardian,
      createdAt: remarks.createdAt,
    })
    .from(remarks)
    .innerJoin(students, eq(students.id, remarks.studentId))
    .leftJoin(enrolments, and(eq(enrolments.studentId, remarks.studentId), eq(enrolments.sessionId, opts.sessionId ?? "")))
    .where(and(...conds))
    .orderBy(desc(remarks.recordedOn), desc(remarks.createdAt))
    .limit(opts.limit ?? 100);
  const people = await peopleByAccount(rows.map((r) => r.recordedBy));
  return rows.map((r) => ({ ...r, recordedByPerson: people.get(r.recordedBy) ?? null }));
}

/** One remark of this school, with who wrote it — or null if it doesn't exist or this reader may not see it. */
export async function remarkForReader(reader: RemarkReader, schoolId: string, remarkId: string) {
  if (!isUuid(remarkId)) return null;
  const db = await getDb();
  const [r] = await db
    .select({ remark: remarks, studentName: students.name })
    .from(remarks)
    .innerJoin(students, eq(students.id, remarks.studentId))
    .where(and(eq(remarks.id, remarkId), eq(remarks.schoolId, schoolId), remarkReaderCondition(db, reader)));
  if (!r) return null;
  const people = await peopleByAccount([r.remark.recordedBy]);
  return { ...r.remark, studentName: r.studentName, recordedByPerson: people.get(r.remark.recordedBy) ?? null };
}

/**
 * How many of the remarks this reader may see were recorded on or after
 * `since` (a date), split by kind. Narrow it to some students if needed.
 */
export async function recentRemarksCount(
  reader: RemarkReader,
  opts: {
    schoolId: string;
    since: string;
    studentIds?: string[];
  },
): Promise<{ appreciation: number; concern: number; total: number }> {
  const out = { appreciation: 0, concern: 0, total: 0 };
  if (opts.studentIds && !opts.studentIds.length) return out;
  const db = await getDb();
  const conds: (SQL | undefined)[] = [eq(remarks.schoolId, opts.schoolId), gte(remarks.recordedOn, opts.since), remarkReaderCondition(db, reader)];
  if (opts.studentIds) conds.push(inArray(remarks.studentId, opts.studentIds));
  const rows = await db
    .select({ kind: remarks.kind, n: count() })
    .from(remarks)
    .where(and(...conds))
    .groupBy(remarks.kind);
  for (const r of rows) {
    out[r.kind] = Number(r.n);
    out.total += Number(r.n);
  }
  return out;
}
