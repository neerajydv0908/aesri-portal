/**
 * Creating and updating student records, their enrolment for the session,
 * their sign-in account and their fee charges — always together, so the
 * records never disagree.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import {
  accounts,
  authSessions,
  classes,
  enrolments,
  examResults,
  exams,
  marks,
  oneTimeCodes,
  paymentAllocations,
  paymentOrders,
  payments,
  sections,
  studentCharges,
  students,
} from "@/lib/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { forgetTrustedBrowsers } from "@/lib/auth/trusted";
import { classLabel, sectionLabel } from "@/lib/classes";
import { displayLoginId } from "@/lib/ids";
import { ensureStudentAccount } from "./accounts";
import {
  addAdmissionCharge,
  currentPlan,
  ensureSessionCharges,
  instalmentLineLabels,
  isLineOf,
  isRteWaiver,
  lineLikePattern,
  lockStudent,
  refundedByCharge,
  rupees,
  RTE_WAIVER_NOTE,
  splitAnnual,
} from "./fees";

export type StudentFields = {
  srNo: string;
  name: string;
  dob?: string | null;
  gender?: "M" | "F" | "O" | null;
  fatherName?: string | null;
  motherName?: string | null;
  guardianName?: string | null;
  guardianMobile?: string | null;
  mobile2?: string | null;
  address?: string | null;
  admittedOn?: string | null;
  rte?: boolean;
};

export type StudentStatus = "active" | "left" | "transferred" | "passed_out";

export class RecordError extends Error {}

/** The section must belong to this school and session. */
export async function assertSectionInSchool(tx: Tx, sectionId: string, schoolId: string, sessionId: string) {
  const [row] = await tx
    .select({ id: sections.id, className: classes.name, stream: classes.stream })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(and(eq(sections.id, sectionId), eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId)));
  if (!row) throw new RecordError("Choose a class and section of this school.");
  return row;
}

export async function createStudent(
  tx: Tx,
  schoolId: string,
  sessionId: string,
  fields: StudentFields,
  placement: { sectionId: string; rollNo?: number | null },
  actor: AuditActor,
  opts: { chargeAdmissionFee: boolean },
): Promise<{ id: string; loginId: string }> {
  await assertSectionInSchool(tx, placement.sectionId, schoolId, sessionId);
  const [dupe] = await tx.select({ id: students.id }).from(students).where(and(eq(students.schoolId, schoolId), eq(students.srNo, fields.srNo)));
  if (dupe) throw new RecordError(`SR number ${fields.srNo} is already used by another student at this school.`);
  const [s] = await tx
    .insert(students)
    .values({ schoolId, ...fields, rte: fields.rte ?? false })
    .returning({ id: students.id });
  await tx.insert(enrolments).values({ studentId: s.id, sessionId, sectionId: placement.sectionId, rollNo: placement.rollNo ?? null });
  const acc = await ensureStudentAccount(tx, s.id);
  await ensureSessionCharges(tx, s.id, sessionId, actor);
  if (opts.chargeAdmissionFee) await addAdmissionCharge(tx, s.id, sessionId, actor);
  await audit(tx, actor, "student.created", { schoolId, targetType: "student", targetId: s.id, details: { srNo: fields.srNo, name: fields.name } });
  return { id: s.id, loginId: acc.loginId };
}

/** Paid so far on each charge (less refunds), and whether any payment (even a cancelled one) ever touched it. */
async function allocationsFor(tx: Tx, chargeIds: string[]): Promise<Map<string, { paid: number; touched: boolean }>> {
  if (!chargeIds.length) return new Map();
  const [rows, refunded] = await Promise.all([
    tx
      .select({
        chargeId: paymentAllocations.chargeId,
        paid: sql<string>`coalesce(sum(${paymentAllocations.amount}) filter (where ${payments.status} = 'completed'), 0)`.mapWith(Number),
      })
      .from(paymentAllocations)
      .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
      .where(inArray(paymentAllocations.chargeId, chargeIds))
      .groupBy(paymentAllocations.chargeId),
    refundedByCharge(tx, chargeIds),
  ]);
  return new Map(rows.map((r) => [r.chargeId, { paid: r.paid - (refunded.get(r.chargeId) ?? 0), touched: true }]));
}

/**
 * RTE status changed: only this session's lines are affected, and paid
 * money stays paid. Turning RTE on waives what is still due; turning it off
 * restores only the lines that were waived because of RTE.
 */
async function applyRteChange(tx: Tx, schoolId: string, sessionId: string, studentId: string, rte: boolean, actor: AuditActor) {
  const lines = await tx.select().from(studentCharges).where(and(eq(studentCharges.studentId, studentId), eq(studentCharges.sessionId, sessionId)));
  const paidBy = await allocationsFor(
    tx,
    lines.map((l) => l.id),
  );
  let changed = 0;
  let alreadyPaid = 0;
  for (const l of lines) {
    const paid = paidBy.get(l.id)?.paid ?? 0;
    if (rte) {
      alreadyPaid += Math.min(paid, l.amount);
      if (l.waived || paid >= l.amount) continue;
      await tx.update(studentCharges).set({ waived: true, waiverNote: RTE_WAIVER_NOTE }).where(eq(studentCharges.id, l.id));
      changed++;
    } else if (l.waived && isRteWaiver(l.waiverNote)) {
      await tx.update(studentCharges).set({ waived: false, waiverNote: null }).where(eq(studentCharges.id, l.id));
      changed++;
    }
  }
  await audit(tx, actor, rte ? "fees.rte_waived" : "fees.rte_restored", {
    schoolId,
    targetType: "student",
    targetId: studentId,
    details: { sessionId, lines: changed, ...(rte && alreadyPaid ? { alreadyPaid } : {}) },
  });
  return { changed, alreadyPaid };
}

/** What happened to the family's sign-in when the student's status changed (null: nothing changed). */
export type FamilySignInChange = "disabled" | "active" | "pending" | null;

/**
 * Keep the family's sign-in in step with the student's status. A student who
 * is no longer current (left, transferred, passed out) can't sign in: the
 * account is turned off, signed out everywhere and any unused slip code is
 * cancelled. Back to current: the account works again — "active" if the
 * family had set a password, otherwise "pending" until a new slip is used.
 * The account itself is kept, so the activity log stays readable.
 */
async function syncFamilySignIn(tx: Tx, schoolId: string, studentId: string, status: StudentStatus, actor: AuditActor): Promise<FamilySignInChange> {
  const [acc] = await tx.select().from(accounts).where(eq(accounts.studentId, studentId));
  if (status === "active") {
    if (!acc) {
      const created = await ensureStudentAccount(tx, studentId);
      await audit(tx, actor, "account.enabled", { schoolId, targetType: "account", targetId: created.id, details: { loginId: displayLoginId(created.loginId), reason: "student_current" } });
      return "pending";
    }
    if (acc.status !== "disabled") return null;
    const next = acc.passwordHash ? "active" : "pending";
    await tx.update(accounts).set({ status: next }).where(eq(accounts.id, acc.id));
    await forgetTrustedBrowsers(tx, acc.id);
    await audit(tx, actor, "account.enabled", { schoolId, targetType: "account", targetId: acc.id, details: { loginId: displayLoginId(acc.loginId), reason: "student_current", status: next } });
    return next;
  }
  if (!acc || acc.status === "disabled") return null;
  await tx.update(accounts).set({ status: "disabled" }).where(eq(accounts.id, acc.id));
  await tx.delete(authSessions).where(eq(authSessions.accountId, acc.id));
  await forgetTrustedBrowsers(tx, acc.id);
  await tx
    .update(oneTimeCodes)
    .set({ revokedAt: new Date() })
    .where(and(eq(oneTimeCodes.accountId, acc.id), isNull(oneTimeCodes.usedAt), isNull(oneTimeCodes.revokedAt)));
  await audit(tx, actor, "account.disabled", { schoolId, targetType: "account", targetId: acc.id, details: { loginId: displayLoginId(acc.loginId), reason: `student_${status}` } });
  return "disabled";
}

export type UpdateStudentResult = {
  changed: string[];
  rte?: { changed: number; alreadyPaid: number };
  /** Set when a change of status turned the family's sign-in off or back on. */
  signIn?: FamilySignInChange;
};

export async function updateStudent(
  tx: Tx,
  schoolId: string,
  sessionId: string,
  studentId: string,
  fields: Partial<StudentFields> & { status?: StudentStatus; leftOn?: string | null },
  actor: AuditActor,
): Promise<UpdateStudentResult> {
  const [cur] = await tx.select().from(students).where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)));
  if (!cur) throw new RecordError("Student not found.");
  if (fields.srNo && fields.srNo !== cur.srNo) {
    throw new RecordError("The SR number can't be changed here, because it is the student's login ID. Ask the AESRI administrator.");
  }
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (k !== "srNo" && v !== undefined && (cur as Record<string, unknown>)[k] !== v) changes[k] = v;
  // A current student has no leaving date.
  if ((changes.status ?? cur.status) === "active") {
    if (cur.leftOn !== null) changes.leftOn = null;
    else delete changes.leftOn;
  }
  if (!Object.keys(changes).length) return { changed: [] };
  if (changes.rte !== undefined) await lockStudent(tx, studentId, schoolId); // money changes are serialised per student
  await tx.update(students).set({ ...changes, updatedAt: new Date() }).where(eq(students.id, studentId));
  const result: UpdateStudentResult = { changed: Object.keys(changes) };
  if (changes.rte !== undefined) result.rte = await applyRteChange(tx, schoolId, sessionId, studentId, Boolean(changes.rte), actor);
  if (changes.status !== undefined) result.signIn = await syncFamilySignIn(tx, schoolId, studentId, changes.status as StudentStatus, actor);
  await audit(tx, actor, "student.updated", {
    schoolId,
    targetType: "student",
    targetId: studentId,
    details: {
      fields: Object.keys(changes),
      ...(changes.status !== undefined ? { status: { from: cur.status, to: changes.status }, leftOn: changes.status === "active" ? null : (changes.leftOn ?? cur.leftOn) } : {}),
      ...(changes.rte !== undefined ? { rte: { from: cur.rte, to: changes.rte } } : {}),
    },
  });
  return result;
}

/**
 * The class changed during the session: bring the instalment lines in line
 * with the new class's fee, and name the new class on them ("Term I —
 * Class III", even when the amount stays the same). Lines no payment ever
 * touched are simply recreated; lines with payments keep their receipts and
 * get the new amount and label, unless more has already been paid on a line
 * than the new fee for it.
 */
async function repriceInstalments(tx: Tx, schoolId: string, sessionId: string, studentId: string, className: string, stream: string | null, actor: AuditActor) {
  const lines = await tx
    .select()
    .from(studentCharges)
    .where(and(eq(studentCharges.studentId, studentId), eq(studentCharges.sessionId, sessionId), eq(studentCharges.kind, "instalment")));
  if (!lines.length) {
    await ensureSessionCharges(tx, studentId, sessionId, actor);
    return;
  }
  const plan = await currentPlan(tx, schoolId);
  const band = plan?.bands.find((b) => b.classNames.includes(className));
  if (!plan || !band) throw new RecordError(`The fee plan has no fee for ${classLabel(className, stream)}, so the class can't be changed here.`);

  const cutoff = new Date(Date.now() - 30 * 60_000);
  const [open] = await tx
    .select({ id: paymentOrders.id })
    .from(paymentOrders)
    .where(and(eq(paymentOrders.studentId, studentId), eq(paymentOrders.status, "created"), gte(paymentOrders.createdAt, cutoff)))
    .limit(1);
  if (open) throw new RecordError("This family is paying fees online right now. Please try again in half an hour.");

  const alloc = await allocationsFor(
    tx,
    lines.map((l) => l.id),
  );
  const instalments = plan.instalments;
  const amounts = splitAnnual(
    band.annualAmount,
    instalments.map((i) => i.percent),
  );
  const before = lines.map((l) => ({ label: l.label, amount: l.amount }));

  if (![...alloc.values()].some((a) => a.touched)) {
    // Nothing was ever paid: recreate the lines, keeping waivers made by hand.
    const manual = lines.filter((l) => l.waived && !isRteWaiver(l.waiverNote));
    await tx.delete(studentCharges).where(inArray(studentCharges.id, lines.map((l) => l.id)));
    await ensureSessionCharges(tx, studentId, sessionId, actor);
    for (const m of manual) {
      const ins = instalments.find((i) => isLineOf(i, m.label));
      if (!ins) continue;
      await tx
        .update(studentCharges)
        .set({ waived: true, waiverNote: m.waiverNote })
        .where(
          and(
            eq(studentCharges.studentId, studentId),
            eq(studentCharges.sessionId, sessionId),
            eq(studentCharges.kind, "instalment"),
            sql`${studentCharges.label} like ${lineLikePattern(ins)}`,
          ),
        );
    }
  } else {
    for (const l of lines) {
      const idx = instalments.findIndex((i) => isLineOf(i, l.label));
      if (idx < 0) throw new RecordError("This student's fee lines don't match the current fee plan. Check the fee page before changing the class.");
      const ins = instalments[idx];
      const paid = alloc.get(l.id)?.paid ?? 0;
      if (paid > amounts[idx]) {
        throw new RecordError(
          `${rupees(paid)} has already been paid towards ${ins.label}, which is more than the ${rupees(amounts[idx])} fee for ${classLabel(className, stream)}. Correct that payment on the student's fee page first, then change the class.`,
        );
      }
      await tx
        .update(studentCharges)
        .set({ amount: amounts[idx], ...instalmentLineLabels(ins, className, stream), planId: plan.id })
        .where(eq(studentCharges.id, l.id));
    }
  }
  await audit(tx, actor, "fees.charges_repriced", {
    schoolId,
    targetType: "student",
    targetId: studentId,
    details: { sessionId, className, before, after: amounts.map((a, i) => ({ label: instalmentLineLabels(instalments[i], className, stream).label, amount: a })) },
  });
}

/* ------------------------------------------------------------------ */
/* Exam results when a student moves (used by placeStudent)            */
/* ------------------------------------------------------------------ */

/** An exam of the session in which a student has marks, and the sections where its results are published. */
export type ExamWithMarks = { id: string; name: string; publishedIn: Set<string> };

/** The session's exams in which this student has marks (or is marked absent), in exam order. */
export async function examsWithMarks(tx: Tx, schoolId: string, sessionId: string, studentId: string): Promise<ExamWithMarks[]> {
  const rows = await tx
    .selectDistinct({ id: exams.id, name: exams.name, sortOrder: exams.sortOrder })
    .from(marks)
    .innerJoin(exams, eq(exams.id, marks.examId))
    .where(and(eq(marks.studentId, studentId), eq(exams.schoolId, schoolId), eq(exams.sessionId, sessionId), or(eq(marks.absent, true), isNotNull(marks.marks))))
    .orderBy(asc(exams.sortOrder), asc(exams.name));
  if (!rows.length) return [];
  const published = await tx
    .select({ examId: examResults.examId, sectionId: examResults.sectionId })
    .from(examResults)
    .where(
      and(
        inArray(
          examResults.examId,
          rows.map((r) => r.id),
        ),
        eq(examResults.status, "published"),
      ),
    );
  return rows.map((r) => ({ id: r.id, name: r.name, publishedIn: new Set(published.filter((p) => p.examId === r.id).map((p) => p.sectionId)) }));
}

/**
 * Results are published section by section and a student's marks go with
 * them, so a move between two sections would show or hide a result for
 * every exam published in one of them and not the other.
 */
export function resultMismatches(list: ExamWithMarks[], fromSectionId: string, toSectionId: string): ExamWithMarks[] {
  return list.filter((e) => e.publishedIn.has(fromSectionId) !== e.publishedIn.has(toSectionId));
}

/**
 * Lock both sections' results rows for every exam of the session (creating
 * missing rows for the length of the change), in a fixed order, so that
 * while a student moves nobody can publish or reopen those results or save
 * marks in the old section. Returns a function that removes the rows that
 * were created only for this.
 */
async function lockSectionResults(tx: Tx, schoolId: string, sessionId: string, sectionIds: string[]): Promise<() => Promise<void>> {
  const examIds = (
    await tx
      .select({ id: exams.id })
      .from(exams)
      .where(and(eq(exams.schoolId, schoolId), eq(exams.sessionId, sessionId)))
      .orderBy(asc(exams.id))
  ).map((e) => e.id);
  if (!examIds.length) return async () => {};
  const secs = [...new Set(sectionIds)].sort();
  const created = await tx
    .insert(examResults)
    .values(examIds.flatMap((examId) => secs.map((sectionId) => ({ examId, sectionId }))))
    .onConflictDoNothing()
    .returning({ examId: examResults.examId, sectionId: examResults.sectionId });
  await tx
    .select({ examId: examResults.examId })
    .from(examResults)
    .where(and(inArray(examResults.examId, examIds), inArray(examResults.sectionId, secs)))
    .orderBy(asc(examResults.examId), asc(examResults.sectionId))
    .for("update");
  return async () => {
    for (const c of created) await tx.delete(examResults).where(and(eq(examResults.examId, c.examId), eq(examResults.sectionId, c.sectionId)));
  };
}

const nameList = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * Put a student in a section for the session (or move them). A change of
 * class also changes the instalment lines to the new class's fee.
 *
 * Exam results are published per section and a student's marks go with
 * them, so once the student has marks this session: the class can't change
 * (the marks are for the old class's papers), and a move to another section
 * is refused while an exam with their marks is published in one section and
 * not the other — it would show unpublished marks to the family, or hide a
 * published result and report card.
 */
export async function placeStudent(tx: Tx, schoolId: string, sessionId: string, studentId: string, sectionId: string, rollNo: number | null, actor: AuditActor) {
  const target = await assertSectionInSchool(tx, sectionId, schoolId, sessionId);
  const current = () =>
    tx
      .select({
        id: enrolments.id,
        sectionId: enrolments.sectionId,
        rollNo: enrolments.rollNo,
        sectionName: sections.name,
        classId: classes.id,
        className: classes.name,
        stream: classes.stream,
      })
      .from(enrolments)
      .innerJoin(sections, eq(sections.id, enrolments.sectionId))
      .innerJoin(classes, eq(classes.id, sections.classId))
      .where(and(eq(enrolments.studentId, studentId), eq(enrolments.sessionId, sessionId)));
  // A move locks the two sections' results first (the order marks entry takes its locks in), then the student.
  const [before] = await current();
  const release = before && before.sectionId !== sectionId ? await lockSectionResults(tx, schoolId, sessionId, [before.sectionId, sectionId]) : null;
  const student = await lockStudent(tx, studentId, schoolId);
  const [cur] = await current();
  if (!cur) {
    await tx.insert(enrolments).values({ studentId, sessionId, sectionId, rollNo });
    await ensureSessionCharges(tx, studentId, sessionId, actor);
  } else {
    if (cur.sectionId === sectionId && cur.rollNo === rollNo) {
      await release?.();
      return;
    }
    if (cur.sectionId !== sectionId) {
      if (!release || cur.sectionId !== before?.sectionId) throw new RecordError(`${student.name}’s class was changed by someone else just now. Reload the page and try again.`);
      const [to] = await tx.select({ classId: sections.classId, name: sections.name }).from(sections).where(eq(sections.id, sectionId));
      const withMarks = await examsWithMarks(tx, schoolId, sessionId, studentId);
      const fromClass = classLabel(cur.className, cur.stream);
      if (withMarks.length && to.classId !== cur.classId) {
        throw new RecordError(
          `${student.name} already has marks this session (${nameList(withMarks.map((e) => e.name))}). They are for ${fromClass}’s papers, so the class can’t be changed now. ` +
            `If ${fromClass} is wrong, reopen any published results and ask the subject teachers to clear ${student.name}’s marks, then change the class.`,
        );
      }
      const clashes = resultMismatches(withMarks, cur.sectionId, sectionId);
      if (clashes.length) {
        const fromLabel = sectionLabel(cur.className, cur.sectionName);
        const toLabel = sectionLabel(target.className, to.name);
        const pair = (e: ExamWithMarks) => (e.publishedIn.has(sectionId) ? { published: toLabel, unpublished: fromLabel } : { published: fromLabel, unpublished: toLabel });
        const facts = clashes.map((e) => `${e.name} results are published for ${pair(e).published} but not for ${pair(e).unpublished}`);
        const shows = clashes.every((e) => e.publishedIn.has(sectionId));
        const hides = clashes.every((e) => !e.publishedIn.has(sectionId));
        const effect = shows
          ? `the family would see ${student.name}’s marks before the office has published them`
          : hides
            ? `${student.name}’s published result and report card would disappear for the family`
            : "results would appear or disappear for the family";
        const remedy = clashes.map((e) => `publish ${pair(e).unpublished}’s ${e.name} results or reopen ${pair(e).published}’s`);
        throw new RecordError(`${student.name} can’t move to ${toLabel} yet: ${nameList(facts)}, so ${effect}. First ${nameList(remedy)}, then move ${student.name}.`);
      }
    }
    await tx.update(enrolments).set({ sectionId, rollNo }).where(eq(enrolments.id, cur.id));
    if (cur.className !== target.className) await repriceInstalments(tx, schoolId, sessionId, studentId, target.className, target.stream, actor);
  }
  await release?.();
  await audit(tx, actor, "student.placed", { schoolId, targetType: "student", targetId: studentId, details: { sectionId, rollNo, from: cur?.sectionId ?? null } });
}
