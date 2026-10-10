/** Shared read queries about a school's structure. */
import "server-only";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { classes, enrolments, schools, sections, staff, students, subjects, classSubjects, teachingAssignments } from "@/lib/db/schema";
import { classLabel, sectionLabel } from "@/lib/classes";

export async function getSchool(id: string) {
  const db = await getDb();
  const [s] = await db.select().from(schools).where(eq(schools.id, id));
  return s ?? null;
}

export type SectionRow = {
  id: string;
  name: string;
  classId: string;
  className: string;
  stream: string | null;
  label: string; // "V-A"
  longLabel: string; // "Class V, section A"
  classTeacherId: string | null;
  classTeacherName: string | null;
  studentCount: number;
  sortOrder: number;
};

/** Every section of a school in a session, in class order, with its class teacher and size. */
export async function listSections(schoolId: string, sessionId: string): Promise<SectionRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: sections.id,
      name: sections.name,
      classId: classes.id,
      className: classes.name,
      stream: classes.stream,
      sortOrder: classes.sortOrder,
      classTeacherId: sections.classTeacherId,
      classTeacherName: staff.name,
    })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(staff, eq(staff.id, sections.classTeacherId))
    .where(and(eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId)))
    .orderBy(asc(classes.sortOrder), asc(sections.name));
  const counts = rows.length
    ? await db
        .select({ sectionId: enrolments.sectionId, n: count() })
        .from(enrolments)
        .innerJoin(students, eq(students.id, enrolments.studentId))
        .where(and(inArray(enrolments.sectionId, rows.map((r) => r.id)), eq(students.status, "active")))
        .groupBy(enrolments.sectionId)
    : [];
  const byId = new Map(counts.map((c) => [c.sectionId, Number(c.n)]));
  return rows.map((r) => ({
    ...r,
    label: sectionLabel(r.className, r.name),
    longLabel: `${classLabel(r.className, r.stream)}, section ${r.name}`,
    studentCount: byId.get(r.id) ?? 0,
  }));
}

export async function listClasses(schoolId: string) {
  const db = await getDb();
  return db.select().from(classes).where(eq(classes.schoolId, schoolId)).orderBy(asc(classes.sortOrder));
}

export async function listSubjects(schoolId: string) {
  const db = await getDb();
  return db.select().from(subjects).where(eq(subjects.schoolId, schoolId)).orderBy(asc(subjects.sortOrder), asc(subjects.name));
}

/** Subjects taught in a class. */
export async function classSubjectList(classId: string) {
  const db = await getDb();
  return db
    .select({ id: subjects.id, name: subjects.name, nameHi: subjects.nameHi, sortOrder: subjects.sortOrder })
    .from(classSubjects)
    .innerJoin(subjects, eq(subjects.id, classSubjects.subjectId))
    .where(eq(classSubjects.classId, classId))
    .orderBy(asc(subjects.sortOrder), asc(subjects.name));
}

export async function listStaff(schoolId: string, opts: { activeOnly?: boolean } = {}) {
  const db = await getDb();
  return db
    .select()
    .from(staff)
    .where(opts.activeOnly ? and(eq(staff.schoolId, schoolId), eq(staff.status, "active")) : eq(staff.schoolId, schoolId))
    .orderBy(asc(staff.name));
}

/** Students enrolled in a section this session (active ones, by roll number then name). */
export async function sectionStudents(sectionId: string) {
  const db = await getDb();
  return db
    .select({ id: students.id, name: students.name, srNo: students.srNo, rollNo: enrolments.rollNo, gender: students.gender })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(and(eq(enrolments.sectionId, sectionId), eq(students.status, "active")))
    .orderBy(asc(enrolments.rollNo), asc(students.name));
}

export async function teachingFor(sectionIds: string[]) {
  if (!sectionIds.length) return [];
  const db = await getDb();
  return db
    .select({ sectionId: teachingAssignments.sectionId, subjectId: teachingAssignments.subjectId, staffId: teachingAssignments.staffId, subjectName: subjects.name, staffName: staff.name })
    .from(teachingAssignments)
    .innerJoin(subjects, eq(subjects.id, teachingAssignments.subjectId))
    .innerJoin(staff, eq(staff.id, teachingAssignments.staffId))
    .where(inArray(teachingAssignments.sectionId, sectionIds));
}
