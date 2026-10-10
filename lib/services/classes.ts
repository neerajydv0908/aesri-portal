/**
 * Classes, sections and subjects for a session: adding and removing
 * sections, the school's list of subjects, which subjects each class is
 * taught, and who teaches them.
 *
 * Writes take the caller's transaction, check that every ID belongs to the
 * school (and session), and write an audit entry. Who may do this — the
 * school office — is checked by the pages and actions (lib/page.ts).
 * Nothing here imports "server-only" code, so scripts and tests can use it.
 */
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import {
  attendance,
  attendanceRegisters,
  classSubjects,
  classes,
  enrolments,
  examPapers,
  examResults,
  exams,
  homework,
  marks,
  notices,
  sections,
  staff,
  staffSubjects,
  students,
  subjects,
  teachingAssignments,
} from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { classLabel, sectionLabel } from "@/lib/classes";
import type { StaffAccess } from "@/lib/roles";
import { RecordError } from "./students";
import { accessCanTeach, setClassSubjects, setClassTeacher, setTeacherFor } from "./staff";

/** Sections are lettered A to F. */
export const SECTION_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** IDs from forms and URLs are checked for shape before they reach a query. */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** PostgreSQL error code of a failed statement (drizzle may wrap the driver's error). */
export function pgErrorCode(err: unknown): string | null {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Scope checks                                                        */
/* ------------------------------------------------------------------ */

export async function classOfSchool(tx: Tx, schoolId: string, classId: string) {
  const [c] = isUuid(classId)
    ? await tx
        .select()
        .from(classes)
        .where(and(eq(classes.id, classId), eq(classes.schoolId, schoolId)))
    : [];
  if (!c) throw new RecordError("That class was not found. Reload the page and try again.");
  return c;
}

/** A section of this school in this session, locked for the rest of the transaction when `lock` is set. */
async function sectionInSession(tx: Tx, schoolId: string, sessionId: string, sectionId: string, lock = false) {
  if (!isUuid(sectionId)) throw new RecordError("That section was not found. Reload the page and try again.");
  const q = tx
    .select({
      id: sections.id,
      name: sections.name,
      classId: sections.classId,
      classTeacherId: sections.classTeacherId,
      className: classes.name,
      stream: classes.stream,
    })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(and(eq(sections.id, sectionId), eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId)));
  const [s] = lock ? await q.for("update", { of: sections }) : await q;
  if (!s) throw new RecordError("That section was not found. Reload the page and try again.");
  return { ...s, label: sectionLabel(s.className, s.name) };
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

/** Create a lettered section of a class for the session. `via` says where it came from (for the activity log). */
export async function createSection(
  tx: Tx,
  schoolId: string,
  sessionId: string,
  classId: string,
  letter: string,
  actor: AuditActor,
  via: "classes" | "import" = "classes",
): Promise<{ id: string; label: string }> {
  const cls = await classOfSchool(tx, schoolId, classId);
  const name = letter.trim().toUpperCase();
  if (!(SECTION_LETTERS as readonly string[]).includes(name)) throw new RecordError("Sections are lettered A to F.");
  const [have] = await tx
    .select({ id: sections.id })
    .from(sections)
    .where(and(eq(sections.classId, cls.id), eq(sections.sessionId, sessionId), eq(sections.name, name)));
  if (have) throw new RecordError(`${sectionLabel(cls.name, name)} already exists.`);
  let row: { id: string };
  try {
    [row] = await tx.insert(sections).values({ classId: cls.id, sessionId, name }).returning({ id: sections.id });
  } catch (err) {
    if (pgErrorCode(err) === "23505") throw new RecordError(`${sectionLabel(cls.name, name)} was added by someone else a moment ago. Reload the page.`);
    throw err;
  }
  const label = sectionLabel(cls.name, name);
  await audit(tx, actor, "section.added", { schoolId, targetType: "section", targetId: row.id, details: { section: label, classId: cls.id, sessionId, via } });
  return { id: row.id, label };
}

/** Add the next free section letter (A–F) to a class. */
export async function addNextSection(tx: Tx, schoolId: string, sessionId: string, classId: string, actor: AuditActor): Promise<{ id: string; label: string }> {
  const cls = await classOfSchool(tx, schoolId, classId);
  const used = await tx
    .select({ name: sections.name })
    .from(sections)
    .where(and(eq(sections.classId, cls.id), eq(sections.sessionId, sessionId)));
  const taken = new Set(used.map((u) => u.name));
  const next = SECTION_LETTERS.find((l) => !taken.has(l));
  if (!next) throw new RecordError(`${classLabel(cls.name, cls.stream)} already has six sections (A to F), the most the portal allows.`);
  return createSection(tx, schoolId, sessionId, cls.id, next, actor, "classes");
}

export type SectionUsage = {
  /** Students ever placed in it (including any who have since left). */
  enrolments: number;
  /** Days its register was taken. */
  attendanceDays: number;
  /** Attendance marks recorded in it (normally covered by attendanceDays). */
  attendanceMarks: number;
  homework: number;
  /** Exam result records (sent to the office or published). */
  results: number;
  notices: number;
  /** Subjects with a teacher assigned. */
  subjectTeachers: number;
};

const emptyUsage = (): SectionUsage => ({ enrolments: 0, attendanceDays: 0, attendanceMarks: 0, homework: 0, results: 0, notices: 0, subjectTeachers: 0 });

/** What refers to each section — anything here stops it being removed. */
export async function sectionUsage(tx: Tx, sectionIds: string[]): Promise<Map<string, SectionUsage>> {
  const out = new Map<string, SectionUsage>(sectionIds.map((id) => [id, emptyUsage()]));
  if (!sectionIds.length) return out;
  const counted = async (key: keyof SectionUsage, rows: Promise<{ id: string; n: number }[]>) => {
    for (const r of await rows) {
      const u = out.get(r.id);
      if (u) u[key] = Number(r.n);
    }
  };
  await Promise.all([
    counted(
      "enrolments",
      tx.select({ id: enrolments.sectionId, n: count() }).from(enrolments).where(inArray(enrolments.sectionId, sectionIds)).groupBy(enrolments.sectionId),
    ),
    counted(
      "attendanceDays",
      tx
        .select({ id: attendanceRegisters.sectionId, n: count() })
        .from(attendanceRegisters)
        .where(inArray(attendanceRegisters.sectionId, sectionIds))
        .groupBy(attendanceRegisters.sectionId),
    ),
    counted(
      "attendanceMarks",
      tx.select({ id: attendance.sectionId, n: count() }).from(attendance).where(inArray(attendance.sectionId, sectionIds)).groupBy(attendance.sectionId),
    ),
    counted("homework", tx.select({ id: homework.sectionId, n: count() }).from(homework).where(inArray(homework.sectionId, sectionIds)).groupBy(homework.sectionId)),
    counted(
      "results",
      tx.select({ id: examResults.sectionId, n: count() }).from(examResults).where(inArray(examResults.sectionId, sectionIds)).groupBy(examResults.sectionId),
    ),
    counted(
      "notices",
      tx
        .select({ id: sql<string>`${notices.sectionId}`, n: count() })
        .from(notices)
        .where(inArray(notices.sectionId, sectionIds))
        .groupBy(notices.sectionId),
    ),
    counted(
      "subjectTeachers",
      tx
        .select({ id: teachingAssignments.sectionId, n: count() })
        .from(teachingAssignments)
        .where(inArray(teachingAssignments.sectionId, sectionIds))
        .groupBy(teachingAssignments.sectionId),
    ),
  ]);
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why a section can't be removed, in plain words (empty when nothing uses it). */
export function sectionUsageReasons(u: SectionUsage): string[] {
  const out: string[] = [];
  if (u.enrolments) out.push(`${plural(u.enrolments, "student is", "students are")} placed in it`);
  if (u.attendanceDays || u.attendanceMarks) out.push(u.attendanceDays ? `attendance was taken on ${plural(u.attendanceDays, "day", "days")}` : "it has attendance records");
  if (u.homework) out.push(`it has ${plural(u.homework, "homework", "homework entries")}`);
  if (u.results) out.push("it has exam results");
  if (u.notices) out.push(`it has ${plural(u.notices, "class notice", "class notices")}`);
  if (u.subjectTeachers) out.push(`${plural(u.subjectTeachers, "subject has a teacher", "subjects have teachers")} assigned`);
  return out;
}

/**
 * Remove a section nothing uses. A class keeps at least one section, so it
 * never disappears from the session's lists.
 */
export async function removeSection(tx: Tx, schoolId: string, sessionId: string, sectionId: string, actor: AuditActor): Promise<{ label: string }> {
  // Locking the row makes anyone placing a student in it wait until this finishes.
  const sec = await sectionInSession(tx, schoolId, sessionId, sectionId, true);
  const [{ n: siblings }] = await tx
    .select({ n: count() })
    .from(sections)
    .where(and(eq(sections.classId, sec.classId), eq(sections.sessionId, sessionId), ne(sections.id, sec.id)));
  if (!Number(siblings)) throw new RecordError(`${sec.label} is the only section of ${classLabel(sec.className, sec.stream)}, so it stays.`);
  const reasons = sectionUsageReasons((await sectionUsage(tx, [sec.id])).get(sec.id) ?? emptyUsage());
  if (reasons.length) throw new RecordError(`${sec.label} can't be removed, because ${reasons.join("; ")}.`);
  try {
    await tx.delete(sections).where(eq(sections.id, sec.id));
  } catch (err) {
    if (pgErrorCode(err) === "23503") throw new RecordError(`${sec.label} is now in use, so it can't be removed. Reload the page.`);
    throw err;
  }
  await audit(tx, actor, "section.removed", {
    schoolId,
    targetType: "section",
    targetId: sec.id,
    details: { section: sec.label, classId: sec.classId, sessionId, classTeacherId: sec.classTeacherId },
  });
  return { label: sec.label };
}

/* ------------------------------------------------------------------ */
/* Teachers of a section                                               */
/* ------------------------------------------------------------------ */

async function teachableStaff(tx: Tx, schoolId: string, staffId: string) {
  const [s] = isUuid(staffId)
    ? await tx
        .select({ id: staff.id, name: staff.name, access: staff.access, status: staff.status })
        .from(staff)
        .where(and(eq(staff.id, staffId), eq(staff.schoolId, schoolId)))
    : [];
  if (!s || s.status !== "active") throw new RecordError("Choose a current member of staff of this school.");
  if (!accessCanTeach(s.access)) {
    throw new RecordError(
      `${s.name} has “${s.access === "accounts" ? "Accounts" : "No login"}” portal access, so they can’t take a class. Change their portal access on the Staff page first.`,
    );
  }
  return s;
}

/** Make someone the class teacher of a section (null: no class teacher). */
export async function assignClassTeacher(
  tx: Tx,
  schoolId: string,
  sessionId: string,
  sectionId: string,
  staffId: string | null,
  actor: AuditActor,
): Promise<{ label: string; changed: boolean; name: string | null }> {
  const sec = await sectionInSession(tx, schoolId, sessionId, sectionId);
  if (sec.classTeacherId === staffId) return { label: sec.label, changed: false, name: null };
  const person = staffId ? await teachableStaff(tx, schoolId, staffId) : null;
  await setClassTeacher(tx, schoolId, sec.id, person?.id ?? null, actor);
  return { label: sec.label, changed: true, name: person?.name ?? null };
}

/**
 * Who teaches each subject in a section. `wanted` maps subject → staff (or
 * null for nobody); subjects not mentioned are left as they are. Only real
 * changes are saved (and logged).
 */
export async function saveSectionTeachers(
  tx: Tx,
  schoolId: string,
  sessionId: string,
  sectionId: string,
  wanted: Map<string, string | null>,
  actor: AuditActor,
): Promise<{ label: string; changed: number }> {
  const sec = await sectionInSession(tx, schoolId, sessionId, sectionId);
  const taught = await tx.select({ subjectId: classSubjects.subjectId }).from(classSubjects).where(eq(classSubjects.classId, sec.classId));
  const taughtIds = new Set(taught.map((t) => t.subjectId));
  const current = await tx
    .select({ subjectId: teachingAssignments.subjectId, staffId: teachingAssignments.staffId })
    .from(teachingAssignments)
    .where(eq(teachingAssignments.sectionId, sec.id));
  const now = new Map(current.map((c) => [c.subjectId, c.staffId]));
  let changed = 0;
  for (const [subjectId, staffId] of wanted) {
    if (!taughtIds.has(subjectId)) throw new RecordError(`A subject on this form is no longer taught in ${sec.label}. Reload the page and try again.`);
    if ((now.get(subjectId) ?? null) === staffId) continue;
    if (staffId) await teachableStaff(tx, schoolId, staffId);
    await setTeacherFor(tx, schoolId, sec.id, subjectId, staffId, actor);
    changed++;
  }
  return { label: sec.label, changed };
}

/* ------------------------------------------------------------------ */
/* Subjects of a class                                                 */
/* ------------------------------------------------------------------ */

/**
 * Set which subjects a class is taught. Unticking a subject also removes who
 * teaches it in the class's sections; it is refused while this session's
 * exams have a paper for it in the class (remove the paper first).
 */
export async function updateClassSubjects(
  tx: Tx,
  schoolId: string,
  sessionId: string,
  classId: string,
  subjectIds: string[],
  actor: AuditActor,
): Promise<{ label: string; added: number; removed: number; teachersRemoved: number }> {
  const cls = await classOfSchool(tx, schoolId, classId);
  const label = classLabel(cls.name, cls.stream);
  const wanted = [...new Set(subjectIds)];
  if (!wanted.every(isUuid)) throw new RecordError("One of the subjects was not found. Reload the page and try again.");
  const current = await tx.select({ subjectId: classSubjects.subjectId }).from(classSubjects).where(eq(classSubjects.classId, cls.id));
  const keep = new Set(wanted);
  const removed = current.map((c) => c.subjectId).filter((id) => !keep.has(id));
  const have = new Set(current.map((c) => c.subjectId));
  const added = wanted.filter((id) => !have.has(id));
  if (!removed.length && !added.length) return { label, added: 0, removed: 0, teachersRemoved: 0 };

  let teachersRemoved = 0;
  if (removed.length) {
    const papers = await tx
      .select({ subject: subjects.name, exam: exams.name })
      .from(examPapers)
      .innerJoin(exams, eq(exams.id, examPapers.examId))
      .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
      .where(and(eq(examPapers.classId, cls.id), inArray(examPapers.subjectId, removed), eq(exams.schoolId, schoolId), eq(exams.sessionId, sessionId)))
      .orderBy(asc(exams.sortOrder), asc(subjects.sortOrder));
    if (papers.length) {
      const bySubject = new Map<string, string[]>();
      for (const p of papers) bySubject.set(p.subject, [...(bySubject.get(p.subject) ?? []), p.exam]);
      const list = [...bySubject].map(([subject, examNames]) => `${subject} (${examNames.join(", ")})`).join(", ");
      throw new RecordError(
        `${label} has exam papers for ${list}, so ${bySubject.size === 1 ? "that subject stays" : "those subjects stay"}. Remove the ${papers.length === 1 ? "paper" : "papers"} on the Exams page first if ${papers.length === 1 ? "it was" : "they were"} set by mistake.`,
      );
    }
    const [{ n }] = await tx
      .select({ n: count() })
      .from(teachingAssignments)
      .innerJoin(sections, eq(sections.id, teachingAssignments.sectionId))
      .where(and(eq(sections.classId, cls.id), inArray(teachingAssignments.subjectId, removed)));
    teachersRemoved = Number(n);
  }
  await setClassSubjects(tx, schoolId, cls.id, wanted, actor);
  return { label, added: added.length, removed: removed.length, teachersRemoved };
}

/* ------------------------------------------------------------------ */
/* The school's subjects                                               */
/* ------------------------------------------------------------------ */

export const SUBJECT_LIMITS = { name: 60 };

/** Tidy one line of text: single spaces, trimmed. */
const oneLine = (v: unknown) => (typeof v === "string" ? v.normalize("NFC").replace(/\s+/g, " ").trim() : "");

/** Check a subject's names as typed; returns clean names or a message per field. */
export function validateSubjectNames(raw: { name: unknown; nameHi: unknown }): { ok: true; name: string; nameHi: string | null } | { ok: false; errors: Record<string, string> } {
  const name = oneLine(raw.name);
  const nameHi = oneLine(raw.nameHi) || null;
  const errors: Record<string, string> = {};
  if (name.length < 2 || name.length > SUBJECT_LIMITS.name || !/\p{L}/u.test(name)) {
    errors.name = `Type the subject’s English name (2 to ${SUBJECT_LIMITS.name} characters), for example “Science”.`;
  } else if (/[,;]/.test(name)) {
    errors.name = "Leave out commas and semicolons: the Excel import uses them to separate subjects.";
  }
  if (nameHi !== null && (nameHi.length > SUBJECT_LIMITS.name || !/\p{L}/u.test(nameHi))) {
    errors.nameHi = `Type the Hindi name (up to ${SUBJECT_LIMITS.name} characters), or leave it empty.`;
  } else if (nameHi && /[,;]/.test(nameHi)) {
    errors.nameHi = "Leave out commas and semicolons.";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, name, nameHi };
}

/** Another subject of the school already has this English or Hindi name? */
async function assertNamesFree(tx: Tx, schoolId: string, name: string, nameHi: string | null, exceptId?: string) {
  const rows = await tx
    .select({ id: subjects.id, name: subjects.name, nameHi: subjects.nameHi })
    .from(subjects)
    .where(eq(subjects.schoolId, schoolId));
  for (const r of rows) {
    if (r.id === exceptId) continue;
    const lower = name.toLowerCase();
    if (r.name.toLowerCase() === lower || r.nameHi?.toLowerCase() === lower) throw new RecordError(`There is already a subject called “${r.name}”.`);
    if (nameHi && (r.nameHi === nameHi || r.name.toLowerCase() === nameHi.toLowerCase())) throw new RecordError(`“${nameHi}” is already the name of ${r.name}.`);
  }
}

async function subjectOfSchool(tx: Tx, schoolId: string, subjectId: string) {
  const [s] = isUuid(subjectId)
    ? await tx
        .select()
        .from(subjects)
        .where(and(eq(subjects.id, subjectId), eq(subjects.schoolId, schoolId)))
    : [];
  if (!s) throw new RecordError("That subject was not found. Reload the page and try again.");
  return s;
}

/** Add a subject to the school's list. `via` says where it came from (for the activity log): this page, or a staff member's "Subjects taught" in an Excel import. */
export async function addSubject(
  tx: Tx,
  schoolId: string,
  names: { name: string; nameHi: string | null },
  actor: AuditActor,
  via: "classes" | "import" = "classes",
): Promise<{ id: string }> {
  const v = validateSubjectNames(names);
  if (!v.ok) throw new RecordError(`“${names.name}” can't be added as a subject: ${Object.values(v.errors)[0]}`);
  await assertNamesFree(tx, schoolId, names.name, names.nameHi);
  const [{ top }] = await tx
    .select({ top: sql<number | null>`max(${subjects.sortOrder})` })
    .from(subjects)
    .where(eq(subjects.schoolId, schoolId));
  let row: { id: string };
  try {
    [row] = await tx
      .insert(subjects)
      .values({ schoolId, name: names.name, nameHi: names.nameHi, sortOrder: Number(top ?? -1) + 1 })
      .returning({ id: subjects.id });
  } catch (err) {
    if (pgErrorCode(err) === "23505") throw new RecordError(`There is already a subject called “${names.name}”.`);
    throw err;
  }
  await audit(tx, actor, "subject.added", { schoolId, targetType: "subject", targetId: row.id, details: { name: names.name, nameHi: names.nameHi, via } });
  return row;
}

export async function renameSubject(
  tx: Tx,
  schoolId: string,
  subjectId: string,
  names: { name: string; nameHi: string | null },
  actor: AuditActor,
): Promise<{ changed: boolean; before: string }> {
  const cur = await subjectOfSchool(tx, schoolId, subjectId);
  if (cur.name === names.name && (cur.nameHi ?? null) === names.nameHi) return { changed: false, before: cur.name };
  await assertNamesFree(tx, schoolId, names.name, names.nameHi, cur.id);
  try {
    await tx.update(subjects).set({ name: names.name, nameHi: names.nameHi }).where(eq(subjects.id, cur.id));
  } catch (err) {
    if (pgErrorCode(err) === "23505") throw new RecordError(`There is already a subject called “${names.name}”.`);
    throw err;
  }
  await audit(tx, actor, "subject.renamed", {
    schoolId,
    targetType: "subject",
    targetId: cur.id,
    details: { before: { name: cur.name, nameHi: cur.nameHi }, after: names },
  });
  return { changed: true, before: cur.name };
}

export type SubjectUsage = {
  classes: number;
  papers: number;
  marks: number;
  homework: number;
  /** Sections where someone is assigned to teach it. */
  assignments: number;
  /** Staff members who have it in their list of subjects. */
  staff: number;
};

const emptySubjectUsage = (): SubjectUsage => ({ classes: 0, papers: 0, marks: 0, homework: 0, assignments: 0, staff: 0 });

/** What refers to each of a school's subjects — anything here stops it being removed. */
export async function subjectUsage(tx: Tx, schoolId: string, only?: string[]): Promise<Map<string, SubjectUsage>> {
  const ids = only ?? (await tx.select({ id: subjects.id }).from(subjects).where(eq(subjects.schoolId, schoolId))).map((s) => s.id);
  const out = new Map<string, SubjectUsage>(ids.map((id) => [id, emptySubjectUsage()]));
  if (!ids.length) return out;
  const counted = async (key: keyof SubjectUsage, rows: Promise<{ id: string; n: number }[]>) => {
    for (const r of await rows) {
      const u = out.get(r.id);
      if (u) u[key] = Number(r.n);
    }
  };
  await Promise.all([
    counted("classes", tx.select({ id: classSubjects.subjectId, n: count() }).from(classSubjects).where(inArray(classSubjects.subjectId, ids)).groupBy(classSubjects.subjectId)),
    counted("papers", tx.select({ id: examPapers.subjectId, n: count() }).from(examPapers).where(inArray(examPapers.subjectId, ids)).groupBy(examPapers.subjectId)),
    counted("marks", tx.select({ id: marks.subjectId, n: count() }).from(marks).where(inArray(marks.subjectId, ids)).groupBy(marks.subjectId)),
    counted(
      "homework",
      tx
        .select({ id: sql<string>`${homework.subjectId}`, n: count() })
        .from(homework)
        .where(inArray(homework.subjectId, ids))
        .groupBy(homework.subjectId),
    ),
    counted(
      "assignments",
      tx
        .select({ id: teachingAssignments.subjectId, n: count() })
        .from(teachingAssignments)
        .where(inArray(teachingAssignments.subjectId, ids))
        .groupBy(teachingAssignments.subjectId),
    ),
    counted("staff", tx.select({ id: staffSubjects.subjectId, n: count() }).from(staffSubjects).where(inArray(staffSubjects.subjectId, ids)).groupBy(staffSubjects.subjectId)),
  ]);
  return out;
}

/** Why a subject can't be removed, in plain words (empty when nothing uses it). */
export function subjectUsageReasons(u: SubjectUsage): string[] {
  const out: string[] = [];
  if (u.classes) out.push(`it is taught in ${plural(u.classes, "class", "classes")}`);
  if (u.assignments) out.push(`teachers are assigned to it in ${plural(u.assignments, "section", "sections")}`);
  if (u.staff) out.push(`${plural(u.staff, "member of staff lists", "members of staff list")} it as a subject they teach`);
  if (u.papers) out.push(`it has ${plural(u.papers, "exam paper", "exam papers")}`);
  if (u.marks) out.push("marks have been entered for it");
  if (u.homework) out.push("homework has been set in it");
  return out;
}

/** Remove a subject nothing uses (for example one added by mistake). */
export async function removeSubject(tx: Tx, schoolId: string, subjectId: string, actor: AuditActor): Promise<{ name: string }> {
  const cur = await subjectOfSchool(tx, schoolId, subjectId);
  const [locked] = await tx.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, cur.id)).for("update");
  if (!locked) throw new RecordError("That subject was not found. Reload the page and try again.");
  const reasons = subjectUsageReasons((await subjectUsage(tx, schoolId, [cur.id])).get(cur.id) ?? emptySubjectUsage());
  if (reasons.length) throw new RecordError(`${cur.name} can't be removed, because ${reasons.join("; ")}.`);
  try {
    await tx.delete(subjects).where(eq(subjects.id, cur.id));
  } catch (err) {
    if (pgErrorCode(err) === "23503") throw new RecordError(`${cur.name} is now in use, so it can't be removed. Reload the page.`);
    throw err;
  }
  await audit(tx, actor, "subject.removed", { schoolId, targetType: "subject", targetId: cur.id, details: { name: cur.name, nameHi: cur.nameHi } });
  return { name: cur.name };
}

/* ------------------------------------------------------------------ */
/* Reads for the Classes & subjects page                               */
/* ------------------------------------------------------------------ */

export type SectionSummary = {
  id: string;
  name: string;
  label: string;
  classTeacherId: string | null;
  classTeacherName: string | null;
  students: number;
};

export type ClassSummary = {
  id: string;
  name: string;
  stream: string | null;
  label: string;
  sortOrder: number;
  sections: SectionSummary[];
  classTeachersSet: number;
  subjects: number;
  /** Sections × subjects with a teacher assigned. */
  assignmentsSet: number;
  assignmentsNeeded: number;
  students: number;
};

/** Every class of the school with its sections (this session), subjects and how complete its teaching is. */
export async function classesOverview(schoolId: string, sessionId: string): Promise<ClassSummary[]> {
  const db = await getDb();
  const [cls, secs, sizes, subjectCounts, assigned] = await Promise.all([
    db.select().from(classes).where(eq(classes.schoolId, schoolId)).orderBy(asc(classes.sortOrder)),
    db
      .select({
        id: sections.id,
        name: sections.name,
        classId: sections.classId,
        classTeacherId: sections.classTeacherId,
        classTeacherName: staff.name,
      })
      .from(sections)
      .innerJoin(classes, eq(classes.id, sections.classId))
      .leftJoin(staff, eq(staff.id, sections.classTeacherId))
      .where(and(eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId)))
      .orderBy(asc(sections.name)),
    db
      .select({ sectionId: enrolments.sectionId, n: count() })
      .from(enrolments)
      .innerJoin(students, eq(students.id, enrolments.studentId))
      .where(and(eq(enrolments.sessionId, sessionId), eq(students.schoolId, schoolId), eq(students.status, "active")))
      .groupBy(enrolments.sectionId),
    db
      .select({ classId: classSubjects.classId, n: count() })
      .from(classSubjects)
      .innerJoin(classes, eq(classes.id, classSubjects.classId))
      .where(eq(classes.schoolId, schoolId))
      .groupBy(classSubjects.classId),
    db
      .select({ sectionId: teachingAssignments.sectionId, n: count() })
      .from(teachingAssignments)
      .innerJoin(sections, eq(sections.id, teachingAssignments.sectionId))
      .innerJoin(classSubjects, and(eq(classSubjects.classId, sections.classId), eq(classSubjects.subjectId, teachingAssignments.subjectId)))
      .innerJoin(classes, eq(classes.id, sections.classId))
      .where(and(eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId)))
      .groupBy(teachingAssignments.sectionId),
  ]);
  const size = new Map(sizes.map((s) => [s.sectionId, Number(s.n)]));
  const subjectsBy = new Map(subjectCounts.map((s) => [s.classId, Number(s.n)]));
  const assignedBy = new Map(assigned.map((a) => [a.sectionId, Number(a.n)]));
  return cls.map((c) => {
    const mine = secs
      .filter((s) => s.classId === c.id)
      .map((s) => ({
        id: s.id,
        name: s.name,
        label: sectionLabel(c.name, s.name),
        classTeacherId: s.classTeacherId,
        classTeacherName: s.classTeacherName,
        students: size.get(s.id) ?? 0,
      }));
    const subjectsN = subjectsBy.get(c.id) ?? 0;
    return {
      id: c.id,
      name: c.name,
      stream: c.stream,
      label: classLabel(c.name, c.stream),
      sortOrder: c.sortOrder,
      sections: mine,
      classTeachersSet: mine.filter((s) => s.classTeacherId).length,
      subjects: subjectsN,
      assignmentsSet: mine.reduce((a, s) => a + (assignedBy.get(s.id) ?? 0), 0),
      assignmentsNeeded: mine.length * subjectsN,
      students: mine.reduce((a, s) => a + s.students, 0),
    };
  });
}

export type StaffOption = {
  id: string;
  name: string;
  empNo: string;
  access: StaffAccess;
  status: "active" | "left";
  /** Can take a class or teach a subject in the portal (active, with teacher-type access). */
  canTeach: boolean;
  subjectIds: string[];
};

/** Everything the page needs to set up one class. Null if the class isn't this school's. */
export async function classDetail(schoolId: string, sessionId: string, classId: string) {
  if (!isUuid(classId)) return null;
  const db = await getDb();
  const [cls] = await db
    .select()
    .from(classes)
    .where(and(eq(classes.id, classId), eq(classes.schoolId, schoolId)));
  if (!cls) return null;
  const [overview, taught, allSubjects, staffRows, staffSubjectRows, papers] = await Promise.all([
    classesOverview(schoolId, sessionId),
    db
      .select({ id: subjects.id, name: subjects.name, nameHi: subjects.nameHi })
      .from(classSubjects)
      .innerJoin(subjects, eq(subjects.id, classSubjects.subjectId))
      .where(eq(classSubjects.classId, cls.id))
      .orderBy(asc(subjects.sortOrder), asc(subjects.name)),
    db
      .select({ id: subjects.id, name: subjects.name, nameHi: subjects.nameHi })
      .from(subjects)
      .where(eq(subjects.schoolId, schoolId))
      .orderBy(asc(subjects.sortOrder), asc(subjects.name)),
    db
      .select({ id: staff.id, name: staff.name, empNo: staff.empNo, access: staff.access, status: staff.status })
      .from(staff)
      .where(eq(staff.schoolId, schoolId))
      .orderBy(asc(staff.name)),
    db
      .select({ staffId: staffSubjects.staffId, subjectId: staffSubjects.subjectId })
      .from(staffSubjects)
      .innerJoin(staff, eq(staff.id, staffSubjects.staffId))
      .where(eq(staff.schoolId, schoolId)),
    db
      .select({ subjectId: examPapers.subjectId, exam: exams.name })
      .from(examPapers)
      .innerJoin(exams, eq(exams.id, examPapers.examId))
      .where(and(eq(examPapers.classId, cls.id), eq(exams.schoolId, schoolId), eq(exams.sessionId, sessionId))),
  ]);
  const summary = overview.find((c) => c.id === cls.id)!;
  const sectionIds = summary.sections.map((s) => s.id);
  const [assignments, usage] = await Promise.all([
    sectionIds.length
      ? db
          .select({ sectionId: teachingAssignments.sectionId, subjectId: teachingAssignments.subjectId, staffId: teachingAssignments.staffId })
          .from(teachingAssignments)
          .where(inArray(teachingAssignments.sectionId, sectionIds))
      : Promise.resolve([] as { sectionId: string; subjectId: string; staffId: string }[]),
    sectionUsage(db, sectionIds),
  ]);
  const subjectsOf = new Map<string, string[]>();
  for (const r of staffSubjectRows) subjectsOf.set(r.staffId, [...(subjectsOf.get(r.staffId) ?? []), r.subjectId]);
  const staffOptions: StaffOption[] = staffRows.map((s) => ({
    ...s,
    canTeach: s.status === "active" && accessCanTeach(s.access),
    subjectIds: subjectsOf.get(s.id) ?? [],
  }));
  const papersBySubject = new Map<string, string[]>();
  for (const p of papers) papersBySubject.set(p.subjectId, [...(papersBySubject.get(p.subjectId) ?? []), p.exam]);
  return {
    cls: { ...cls, label: classLabel(cls.name, cls.stream) },
    summary,
    sections: summary.sections.map((s) => ({ ...s, usage: usage.get(s.id) ?? emptyUsage() })),
    taught,
    allSubjects,
    staff: staffOptions,
    assignments,
    papersBySubject,
    overview,
  };
}
export type ClassDetail = NonNullable<Awaited<ReturnType<typeof classDetail>>>;

export type SubjectRow = { id: string; name: string; nameHi: string | null; usage: SubjectUsage };

/** The school's subjects in order, with what uses each one. */
export async function subjectList(schoolId: string): Promise<SubjectRow[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: subjects.id, name: subjects.name, nameHi: subjects.nameHi })
    .from(subjects)
    .where(eq(subjects.schoolId, schoolId))
    .orderBy(asc(subjects.sortOrder), asc(subjects.name));
  const usage = await subjectUsage(
    db,
    schoolId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, usage: usage.get(r.id) ?? emptySubjectUsage() }));
}
