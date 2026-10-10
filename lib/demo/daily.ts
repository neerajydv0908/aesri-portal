/**
 * Demo data: attendance, homework, remarks and notices. Fictional only — see
 * lib/demo/core.ts.
 *
 *  - 25 school days of registers (Mon–Sat) up to 28 Sep 2026, about 94%
 *    present, with a few absences, late arrivals and leave; three students
 *    per school are below 75% so the warning shows.
 *  - Homework for the main subjects over the last three weeks, most of it
 *    checked (mostly done, some late or not done).
 *  - About ten remarks per school (appreciation and concerns), and two school
 *    notices, one staff notice and one class notice per school.
 *
 * Everything is inserted in batches, so this takes well under a second.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import {
  accounts,
  attendance,
  attendanceRegisters,
  auditLog,
  homework,
  homeworkChecks,
  notices,
  remarks,
  sections,
  subjects,
  teachingAssignments,
} from "@/lib/db/schema";
import { addDays, weekdayOf } from "@/lib/dates";
import type { AttendanceStatus } from "@/lib/services/attendance";
import type { HomeworkCheck } from "@/lib/services/homework";
import type { DemoContext, DemoSchool } from "./core";
import { APPRECIATIONS, CONCERNS, HOMEWORK_IDEAS, LOW_ATTENDANCE_CONCERN, type RemarkIdea } from "./texts";

/** The demo is written as seen on this day. */
const DEMO_TODAY = "2026-09-29";
const LAST_REGISTER_DAY = "2026-09-28";
const SCHOOL_DAYS = 25;

/** Small deterministic random numbers (mulberry32), so the demo is the same every time. */
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

/** "2026-09-28" + 9:12 → a Date at that time in India. */
const at = (iso: string, h: number, m: number) => new Date(`${iso}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+05:30`);

async function insertInChunks<T>(rows: T[], size: number, insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

/** The last `n` Mondays-to-Saturdays up to and including `last`, oldest first. */
function schoolDaysUpTo(last: string, n: number): string[] {
  const out: string[] = [];
  for (let d = last; out.length < n; d = addDays(d, -1)) if (weekdayOf(d) !== 0) out.unshift(d);
  return out;
}

const nextSchoolDay = (iso: string, steps = 1) => {
  let d = iso;
  for (let i = 0; i < steps;) {
    d = addDays(d, 1);
    if (weekdayOf(d) !== 0) i++;
  }
  return d;
};

/* ------------------------------------------------------------------ */

export async function seedDemoDaily(tx: Tx, ctx: DemoContext): Promise<string[]> {
  const log: string[] = [];
  const days = schoolDaysUpTo(LAST_REGISTER_DAY, SCHOOL_DAYS);

  for (const [si, school] of ctx.schools.entries()) {
    const r = rng(101 + si * 17);
    const staffIds = [...school.teacherIds, school.principalId];
    const accRows = await tx.select({ id: accounts.id, staffId: accounts.staffId }).from(accounts).where(inArray(accounts.staffId, staffIds));
    const accountOf = new Map(accRows.map((a) => [a.staffId!, a.id]));
    const principalAcc = accountOf.get(school.principalId)!;
    const teacherAcc = (staffId: string | null) => (staffId ? (accountOf.get(staffId) ?? principalAcc) : principalAcc);

    /* ---------------- Attendance ---------------- */
    const registers: (typeof attendanceRegisters.$inferInsert)[] = [];
    const marks: (typeof attendance.$inferInsert)[] = [];
    const lowStudents = pickLowAttendance(school);
    const familyStudent = school.sections[5]?.studentIds[0];
    for (const sec of school.sections) {
      if (!sec.studentIds.length) continue;
      // A few children are away together (a family wedding) for 2–3 days.
      const wedding = sec.studentIds.length > 4 ? { student: sec.studentIds[3], from: 10 + Math.floor(r() * 8), len: 2 + Math.floor(r() * 2) } : null;
      for (const [di, date] of days.entries()) {
        // Now and then the principal takes the register for an absent teacher.
        const by = r() < 0.04 ? principalAcc : teacherAcc(sec.classTeacherId);
        const takenAt = at(date, 9, 2 + Math.floor(r() * 35));
        registers.push({ sectionId: sec.id, date, takenBy: by, takenAt });
        for (const studentId of sec.studentIds) {
          let status: AttendanceStatus;
          const low = lowStudents.get(studentId);
          if (low) status = low[di];
          else if (studentId === familyStudent) status = di === 6 || di === 7 ? "absent" : di === 15 ? "late" : di === 20 ? "leave" : "present";
          else if (wedding && studentId === wedding.student && di >= wedding.from && di < wedding.from + wedding.len) status = "leave";
          else {
            const x = r();
            status = x < 0.03 ? "absent" : x < 0.045 ? "late" : x < 0.052 ? "leave" : "present";
          }
          marks.push({ studentId, date, sectionId: sec.id, status, markedBy: by, markedAt: takenAt });
        }
      }
    }
    await insertInChunks(registers, 1000, (c) => tx.insert(attendanceRegisters).values(c));
    await insertInChunks(marks, 1000, (c) => tx.insert(attendance).values(c));
    const present = marks.filter((m) => m.status === "present").length;
    log.push(
      `${school.schoolId}: ${registers.length} attendance registers over ${days.length} school days (${Math.round((present / marks.length) * 100)}% present; ${lowStudents.size} students below 75%)`,
    );

    /* ---------------- Homework ---------------- */
    const pairs = await tx
      .select({
        sectionId: teachingAssignments.sectionId,
        subjectId: teachingAssignments.subjectId,
        staffId: teachingAssignments.staffId,
        subject: subjects.name,
      })
      .from(teachingAssignments)
      .innerJoin(subjects, eq(subjects.id, teachingAssignments.subjectId))
      .innerJoin(sections, eq(sections.id, teachingAssignments.sectionId))
      .where(and(eq(subjects.schoolId, school.schoolId), eq(sections.sessionId, ctx.sessionId)));
    const hwDays = schoolDaysUpTo(DEMO_TODAY, 16); // about three weeks
    const hwRows: (typeof homework.$inferInsert & { id: string })[] = [];
    let ideaCounter = si * 3;
    for (const p of pairs) {
      const ideas = HOMEWORK_IDEAS[p.subject];
      if (!ideas) continue; // art, games etc. don't usually have homework
      const sec = school.sections.find((s) => s.id === p.sectionId);
      if (!sec?.studentIds.length) continue;
      const count = 2 + Math.floor(r() * 3); // 2–4 per subject
      const picks = new Set<number>();
      while (picks.size < count) picks.add(Math.floor(r() * hwDays.length));
      for (const dayIdx of [...picks].sort((a, b) => a - b)) {
        const assignedOn = hwDays[dayIdx];
        const idea = ideas[ideaCounter++ % ideas.length];
        hwRows.push({
          id: crypto.randomUUID(),
          sectionId: p.sectionId,
          subjectId: p.subjectId,
          title: idea.title,
          details: idea.details ?? null,
          assignedOn,
          dueOn: nextSchoolDay(assignedOn, r() < 0.7 ? 1 : 2),
          createdBy: teacherAcc(p.staffId),
          createdAt: at(assignedOn, 12, 10 + Math.floor(r() * 45)),
        });
      }
    }
    // The demo families' classes also get homework that is still to be handed in.
    const familySec = school.sections[5];
    if (familySec) {
      const upcoming = pairs.filter((p) => p.sectionId === familySec.id && HOMEWORK_IDEAS[p.subject]).slice(0, 2);
      for (const [i, p] of upcoming.entries()) {
        const idea = HOMEWORK_IDEAS[p.subject][(i + 2) % HOMEWORK_IDEAS[p.subject].length];
        hwRows.push({
          id: crypto.randomUUID(),
          sectionId: p.sectionId,
          subjectId: p.subjectId,
          title: idea.title,
          details: idea.details ?? null,
          assignedOn: DEMO_TODAY,
          dueOn: nextSchoolDay(DEMO_TODAY, 2 + i * 2),
          createdBy: teacherAcc(p.staffId),
          createdAt: at(DEMO_TODAY, 12, 40 + i),
        });
      }
    }
    const checks: (typeof homeworkChecks.$inferInsert)[] = [];
    let checkedHomework = 0;
    for (const hw of hwRows) {
      if (hw.dueOn >= DEMO_TODAY || r() < 0.1) continue; // not due yet, or not checked yet
      checkedHomework++;
      const sec = school.sections.find((s) => s.id === hw.sectionId)!;
      for (const studentId of sec.studentIds) {
        const weak = lowStudents.has(studentId);
        const x = r();
        const status: HomeworkCheck = weak
          ? x < 0.55
            ? "done"
            : x < 0.65
              ? "late"
              : "not_done"
          : x < 0.84
            ? "done"
            : x < 0.91
              ? "late"
              : x < 0.97
                ? "not_done"
                : "excused";
        checks.push({ homeworkId: hw.id, studentId, status, checkedBy: hw.createdBy, checkedAt: at(hw.dueOn, 13, 30 + Math.floor(r() * 25)) });
      }
    }
    await insertInChunks(hwRows, 500, (c) => tx.insert(homework).values(c));
    await insertInChunks(checks, 1000, (c) => tx.insert(homeworkChecks).values(c));
    log.push(`${school.schoolId}: ${hwRows.length} homework (${checkedHomework} checked, ${checks.length} checks)`);

    /* ---------------- Remarks ---------------- */
    const remarkRows: (typeof remarks.$inferInsert)[] = [];
    const remarkDays = schoolDaysUpTo("2026-09-28", 18);
    const addRemark = (studentId: string, idea: RemarkIdea, dayIdx: number) => {
      const sec = school.sections.find((s) => s.studentIds.includes(studentId))!;
      const recordedOn = remarkDays[Math.min(remarkDays.length - 1, dayIdx)];
      remarkRows.push({
        schoolId: school.schoolId,
        studentId,
        kind: idea.kind,
        category: idea.category,
        note: idea.note,
        actionTaken: idea.action ?? null,
        recordedOn,
        recordedBy: teacherAcc(sec.classTeacherId),
        visibleToGuardian: idea.family ?? true,
        createdAt: at(recordedOn, 14, 5 + Math.floor(r() * 50)),
      });
    };
    if (familyStudent) {
      addRemark(familyStudent, APPRECIATIONS[1], 9);
      addRemark(familyStudent, CONCERNS[0], 14);
    }
    for (const studentId of [...lowStudents.keys()].slice(0, 2)) addRemark(studentId, LOW_ATTENDANCE_CONCERN, 16);
    const others = school.sections.flatMap((s) => s.studentIds.slice(1, 3)).filter((id) => id !== familyStudent && !lowStudents.has(id));
    // Ten per school, half appreciation: family (1 + 1), two attendance concerns, and these six.
    const ideas = [APPRECIATIONS[0], CONCERNS[1 + si], APPRECIATIONS[2], CONCERNS[4], APPRECIATIONS[3], APPRECIATIONS[4 + si]];
    for (const [i, idea] of ideas.entries()) addRemark(others[(i * 5 + si) % others.length], idea, 2 + i * 2);
    await tx.insert(remarks).values(remarkRows);
    log.push(`${school.schoolId}: ${remarkRows.length} teacher remarks`);

    /* ---------------- Notices ---------------- */
    const aryavart = school.schoolId === "aryavart";
    const examDay = aryavart ? "12 October" : "14 October";
    const examDayHi = aryavart ? "12 अक्टूबर" : "14 अक्टूबर";
    const classSec = school.sections[5] ?? school.sections[0];
    const noticeRows: Omit<typeof notices.$inferInsert, "createdBy">[] = [
      {
        schoolId: school.schoolId,
        audience: "school",
        category: "academic",
        titleEn: `Half-yearly exams begin on ${examDay}`,
        titleHi: `अर्धवार्षिक परीक्षाएँ ${examDayHi} से`,
        bodyEn: `The half-yearly exams for all classes begin on Monday ${examDay}. The timetable will be given to each child in class next week.\n\nPlease make sure your child comes on time with a pen, pencil, eraser and clipboard. Children must reach school by 7:45 am on exam days.`,
        bodyHi: `सभी कक्षाओं की अर्धवार्षिक परीक्षाएँ सोमवार, ${examDayHi} से शुरू होंगी। समय-सारणी अगले सप्ताह कक्षा में हर बच्चे को दी जाएगी।\n\nकृपया ध्यान रखें कि बच्चा समय पर पेन, पेंसिल, रबर और क्लिपबोर्ड के साथ आए। परीक्षा के दिनों में बच्चे सुबह 7:45 बजे तक विद्यालय पहुँचें।`,
        status: "published",
        publishOn: "2026-09-21",
        expiresOn: "2026-10-24",
      },
      {
        schoolId: school.schoolId,
        audience: "school",
        category: "holiday",
        titleEn: "Dussehra holidays: 19 to 21 October",
        titleHi: "दशहरा की छुट्टियाँ: 19 से 21 अक्टूबर",
        bodyEn: "The school will be closed from Monday 19 October to Wednesday 21 October for Dussehra. Classes start again on Thursday 22 October.",
        bodyHi: "दशहरा के कारण विद्यालय सोमवार 19 अक्टूबर से बुधवार 21 अक्टूबर तक बंद रहेगा। कक्षाएँ गुरुवार 22 अक्टूबर से फिर शुरू होंगी।",
        status: "published",
        publishOn: "2026-09-25",
        expiresOn: "2026-10-22",
      },
      {
        schoolId: school.schoolId,
        audience: "staff",
        category: "general",
        titleEn: "Staff meeting on Saturday 3 October, 1:30 pm",
        titleHi: null,
        bodyEn:
          "All teachers, please stay after school on Saturday 3 October for a short meeting about the half-yearly exams: question papers, seating plan and duty chart. Please bring your class attendance summary.",
        bodyHi: null,
        status: "published",
        publishOn: "2026-09-26",
        expiresOn: "2026-10-03",
      },
      {
        schoolId: school.schoolId,
        audience: "section",
        sectionId: classSec.id,
        category: "events",
        titleEn: "Art activity on Thursday 1 October",
        titleHi: "गुरुवार 1 अक्टूबर को कला गतिविधि",
        bodyEn:
          "Please send an old newspaper, a glue stick and a pair of child-safe scissors with your child on Thursday. We are making paper lanterns for Diwali.",
        bodyHi: "कृपया गुरुवार को बच्चे के साथ एक पुराना अख़बार, गोंद की छड़ी और बच्चों वाली कैंची भेजें। हम दीवाली के लिए काग़ज़ की कंदीलें बनाएँगे।",
        status: "published",
        publishOn: "2026-09-28",
        expiresOn: "2026-10-01",
      },
    ];
    const created = at("2026-09-20", 11, 0);
    await tx.insert(notices).values(
      noticeRows.map((n) => {
        const author = n.audience === "section" ? teacherAcc(classSec.classTeacherId) : principalAcc;
        const when = at(n.publishOn, 10, 15);
        return { ...n, createdBy: author, approvedBy: author, approvedAt: when, createdAt: n.publishOn < "2026-09-21" ? created : when, updatedAt: when };
      }),
    );
    log.push(`${school.schoolId}: ${noticeRows.length} notices (2 for families, 1 for staff, 1 for class ${classSec.className}-${classSec.name})`);

    await tx.insert(auditLog).values({
      actorLogin: "demo data",
      schoolId: school.schoolId,
      action: "demo.daily_data",
      details: {
        registers: registers.length,
        marks: marks.length,
        homework: hwRows.length,
        checks: checks.length,
        remarks: remarkRows.length,
        notices: noticeRows.length,
      },
    });
  }
  return log;
}

/**
 * Three students per school with poor attendance (below 75%), each with a
 * fixed pattern over the 25 days: mostly absences, some leave and lateness.
 */
function pickLowAttendance(school: DemoSchool): Map<string, AttendanceStatus[]> {
  const out = new Map<string, AttendanceStatus[]>();
  const choices: [number, number][] = [
    [8, 2],
    [11, 1],
    [3, 3],
  ];
  const patterns: string[] = [
    // P present, A absent, L late, V leave — 25 school days each
    "PPAPPAAPPPAPPVPPAAPPPAPPA", // 16 present of 25 = 64%
    "PPPLPAPPAPPPAPPALPPAPPAPA", // 16 present + 2 late = 72%
    "PAPPPVVVPPAPPPAPPLPAPPPAP", // 16 present + 1 late = 68%
  ];
  const map: Record<string, AttendanceStatus> = { P: "present", A: "absent", L: "late", V: "leave" };
  choices.forEach(([secIdx, stuIdx], i) => {
    const id = school.sections[secIdx]?.studentIds[stuIdx];
    if (id)
      out.set(
        id,
        [...patterns[i]].map((c) => map[c]),
      );
  });
  return out;
}
