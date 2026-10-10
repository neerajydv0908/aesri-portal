/**
 * Fictional demo data for trying the portal on a laptop. NEVER real people.
 *
 * Creates, in both schools: staff with every kind of access, subjects,
 * a second section for one class, class teachers and subject teachers,
 * and a few students in every class. Demo accounts get a shared password
 * and administrators a known authenticator secret, both printed by
 * `npm run demo`. The presence of demo data is recorded so every page can
 * show a "Demo data" banner.
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { accounts, classSubjects, classes, counters, sections, staff, staffSubjects, students, subjects, teachingAssignments } from "@/lib/db/schema";
import { encryptSecret, hashPassword } from "@/lib/auth/crypto";
import { normalizeLoginId } from "@/lib/ids";
import type { StaffAccess } from "@/lib/roles";
import { createStaff, setClassTeacher, setTeacherFor } from "@/lib/services/staff";
import { createStudent } from "@/lib/services/students";
import { CURRENT_SESSION } from "@/lib/services/reference";

export const DEMO_PASSWORD = "demo-pass-2026";
/** Base32 authenticator secret shared by the demo administrators (add it to any authenticator app). */
export const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
export const DEMO_ADMIN_LOGIN = "aesri.demo";

const SYSTEM = { accountId: null, loginId: "demo data" };

export type DemoSection = { id: string; className: string; name: string; classId: string; studentIds: string[]; classTeacherId: string | null };
export type DemoSchool = {
  schoolId: string;
  teacherIds: string[];
  principalId: string;
  accountantId: string;
  sections: DemoSection[];
  subjectIds: Record<string, string>;
};
export type DemoContext = { sessionId: string; schools: DemoSchool[]; adminAccountId: string };

const FIRST_M = ["Aarav", "Vivaan", "Kabir", "Rohan", "Arjun", "Ishaan", "Yash", "Dev", "Harsh", "Kunal", "Manish", "Nikhil", "Pranav", "Rahul", "Sahil", "Tarun"];
const FIRST_F = ["Ananya", "Diya", "Kavya", "Meera", "Nisha", "Pooja", "Riya", "Saanvi", "Tanvi", "Aisha", "Bhavna", "Chanchal", "Gauri", "Jyoti", "Komal", "Lata"];
const LAST = ["Meena", "Sharma", "Choudhary", "Yadav", "Saini", "Bishnoi", "Godara", "Jakhar", "Swami", "Purohit", "Kumawat", "Soni"];
const FATHER = ["Ramesh", "Suresh", "Mahesh", "Dinesh", "Rajesh", "Mukesh", "Naresh", "Prakash", "Om Prakash", "Bhagirath", "Hanuman", "Shankar"];
const MOTHER = ["Sunita", "Kamla", "Geeta", "Santosh", "Manju", "Suman", "Rekha", "Sarita", "Kiran", "Laxmi", "Poonam", "Mamta"];
const VILLAGES: Record<string, string[]> = { aryavart: ["Palana", "Gadhwala", "Kolayat Road", "Bikampur"], aadharshila: ["Udairamsar", "Ambasar", "Raisar", "Kesardesar"] };

/** Subjects used by the demo (the real lists are set by each school office). */
const DEMO_SUBJECTS: { name: string; nameHi: string; classes: string[] }[] = [
  { name: "Hindi", nameHi: "हिंदी", classes: ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"] },
  { name: "English", nameHi: "अंग्रेज़ी", classes: ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"] },
  { name: "Mathematics", nameHi: "गणित", classes: ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"] },
  { name: "Environmental Education", nameHi: "पर्यावरण शिक्षा", classes: ["I", "II", "III", "IV", "V"] },
  { name: "Science", nameHi: "विज्ञान", classes: ["VI", "VII", "VIII", "IX", "X"] },
  { name: "Social Science", nameHi: "सामाजिक विज्ञान", classes: ["VI", "VII", "VIII", "IX", "X"] },
  { name: "Sanskrit", nameHi: "संस्कृत", classes: ["VI", "VII", "VIII"] },
  { name: "History", nameHi: "इतिहास", classes: ["XI", "XII"] },
  { name: "Geography", nameHi: "भूगोल", classes: ["XI", "XII"] },
  { name: "Political Science", nameHi: "राजनीति विज्ञान", classes: ["XI", "XII"] },
];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

/** Small deterministic "random" so the demo is the same every time. */
function seeded(n: number) {
  let x = n * 2654435761 % 2 ** 32;
  return () => {
    x = (x * 1664525 + 1013904223) % 2 ** 32;
    return x / 2 ** 32;
  };
}

function birthDateFor(className: string, r: () => number): string {
  const order = ["Nursery", "LKG", "UKG", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
  const age = 3 + order.indexOf(className); // Nursery ≈ 3+
  const year = 2026 - age - (r() < 0.5 ? 1 : 0);
  const month = 1 + Math.floor(r() * 12);
  const day = 1 + Math.floor(r() * 28);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function activate(tx: Tx, accountId: string, passwordHash: string, totp: boolean) {
  await tx
    .update(accounts)
    .set({
      status: "active",
      passwordHash,
      passwordChangedAt: new Date(),
      privacyAcceptedAt: new Date(),
      ...(totp ? { totpEnabled: true, totpSecretEnc: encryptSecret(DEMO_TOTP_SECRET) } : {}),
    })
    .where(eq(accounts.id, accountId));
}

export async function demoPresent(tx: Tx): Promise<boolean> {
  const [row] = await tx.select().from(counters).where(eq(counters.key, "demo_data"));
  return !!row;
}

/**
 * Refuse unless the database is empty of people: the demo adds accounts
 * with a published password and authenticator secret, so it must never
 * land beside real staff, students or sign-in accounts (an AESRI
 * administrator made with admin:create counts too).
 */
async function assertNoRealPeople(tx: Tx): Promise<void> {
  const [[anyStaff], [anyStudent], [anyAccount]] = await Promise.all([
    tx.select({ id: staff.id }).from(staff).limit(1),
    tx.select({ id: students.id }).from(students).limit(1),
    tx.select({ id: accounts.id }).from(accounts).limit(1),
  ]);
  if (anyStaff || anyStudent || anyAccount) {
    throw new Error("This database already has staff, students or sign-in accounts. The demo only runs on an empty database, so nothing was added.");
  }
}

export async function seedDemoCore(tx: Tx): Promise<DemoContext> {
  if (await demoPresent(tx)) throw new Error("Demo data is already in this database. Delete the database folder (.data/db) to start again.");
  await assertNoRealPeople(tx);

  const sessionId = CURRENT_SESSION.id;
  const pw = await hashPassword(DEMO_PASSWORD);
  const ctx: DemoContext = { sessionId, schools: [], adminAccountId: "" };

  // AESRI administrator
  const [admin] = await tx
    .insert(accounts)
    .values({ loginId: normalizeLoginId(DEMO_ADMIN_LOGIN), role: "super_admin", displayName: "Demo AESRI Admin", status: "pending" })
    .returning({ id: accounts.id });
  await activate(tx, admin.id, pw, true);
  ctx.adminAccountId = admin.id;

  for (const [si, schoolId] of ["aryavart", "aadharshila"].entries()) {
    const r = seeded(si + 7);

    // Subjects (demo lists)
    const subjectIds: Record<string, string> = {};
    const clsRows = await tx.select().from(classes).where(eq(classes.schoolId, schoolId));
    const clsByName = new Map(clsRows.map((c) => [c.name, c]));
    for (const [i, sub] of DEMO_SUBJECTS.entries()) {
      const wanted = sub.classes.filter((c) => clsByName.has(c));
      if (!wanted.length) continue;
      let [row] = await tx.select().from(subjects).where(and(eq(subjects.schoolId, schoolId), eq(subjects.name, sub.name)));
      if (!row) [row] = await tx.insert(subjects).values({ schoolId, name: sub.name, nameHi: sub.nameHi, sortOrder: 20 + i }).returning();
      subjectIds[sub.name] = row.id;
      for (const c of wanted) await tx.insert(classSubjects).values({ classId: clsByName.get(c)!.id, subjectId: row.id }).onConflictDoNothing();
    }
    for (const row of await tx.select().from(subjects).where(eq(subjects.schoolId, schoolId))) subjectIds[row.name] = row.id;

    // A second section for Class V, to try classes with more than one section
    const clsV = clsByName.get("V")!;
    await tx.insert(sections).values({ classId: clsV.id, sessionId, name: "B" }).onConflictDoNothing();

    // Staff
    const staffDefs: { name: string; designation: string; access: StaffAccess }[] = [
      { name: si === 0 ? "Demo Principal Rathore" : "Demo Principal Chauhan", designation: "Principal", access: "principal" },
      { name: si === 0 ? "Demo Accountant Joshi" : "Demo Accountant Vyas", designation: "Accountant", access: "accounts" },
      ...["Sunita", "Mahendra", "Pooja", "Ravi", "Kiran", "Deepika", "Ashok"].map((n, i) => ({
        name: `${n} ${pick(LAST, i + si * 3)} (demo)`,
        designation: i % 3 === 2 ? "Mother teacher" : "Teacher",
        access: "teacher" as StaffAccess,
      })),
      { name: `Bhanwar Lal (demo)`, designation: "Driver", access: "none" },
    ];
    const staffIds: { id: string; access: StaffAccess }[] = [];
    for (const [i, d] of staffDefs.entries()) {
      const s = await createStaff(
        tx,
        schoolId,
        { empNo: String(i + 1), name: d.name, designation: d.designation, access: d.access, mobile: `98${si}${String(1000000 + i * 7919).slice(-7)}`, joinedOn: `20${18 + (i % 7)}-07-01` },
        SYSTEM,
      );
      staffIds.push({ id: s.id, access: d.access });
    }
    const principalId = staffIds.find((s) => s.access === "principal")!.id;
    const accountantId = staffIds.find((s) => s.access === "accounts")!.id;
    const teacherIds = staffIds.filter((s) => s.access === "teacher").map((s) => s.id);
    for (const s of staffIds) {
      if (s.access === "none") continue;
      const [acc] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.staffId, s.id));
      await activate(tx, acc.id, pw, s.access !== "teacher");
    }

    // Sections, class teachers, subject teachers, students
    const secRows = await tx
      .select({ id: sections.id, name: sections.name, classId: classes.id, className: classes.name, sortOrder: classes.sortOrder })
      .from(sections)
      .innerJoin(classes, eq(classes.id, sections.classId))
      .where(and(eq(classes.schoolId, schoolId), eq(sections.sessionId, sessionId)));
    secRows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const demoSections: DemoSection[] = [];
    let sr = si === 0 ? 7601 : 1201;
    let nameIdx = si * 5;
    for (const [idx, sec] of secRows.entries()) {
      const classTeacherId = teacherIds[idx % teacherIds.length];
      await setClassTeacher(tx, schoolId, sec.id, classTeacherId, SYSTEM);
      const subs = await tx.select({ subjectId: classSubjects.subjectId }).from(classSubjects).where(eq(classSubjects.classId, sec.classId));
      for (const [j, sub] of subs.entries()) await setTeacherFor(tx, schoolId, sec.id, sub.subjectId, teacherIds[(idx + j) % teacherIds.length], SYSTEM);

      const count = sec.className === "V" || sec.className === "X" ? 8 : 4;
      const studentIds: string[] = [];
      for (let k = 0; k < count; k++) {
        const girl = r() < 0.5;
        const first = girl ? pick(FIRST_F, nameIdx) : pick(FIRST_M, nameIdx);
        const last = pick(LAST, nameIdx * 7 + k);
        nameIdx++;
        const created = await createStudent(
          tx,
          schoolId,
          sessionId,
          {
            srNo: String(sr++),
            name: `${first} ${last}`,
            dob: birthDateFor(sec.className, r),
            gender: girl ? "F" : "M",
            fatherName: `${pick(FATHER, nameIdx)} ${last}`,
            motherName: `${pick(MOTHER, nameIdx + 3)} ${last}`,
            guardianMobile: `9${String(Math.floor(100000000 + r() * 899999999))}`,
            address: pick(VILLAGES[schoolId], nameIdx),
            admittedOn: `20${Math.max(18, 26 - Math.floor(r() * 6))}-04-0${1 + Math.floor(r() * 8)}`,
            rte: k === 1 && ["LKG", "Nursery", "I"].includes(sec.className),
          },
          { sectionId: sec.id, rollNo: k + 1 },
          SYSTEM,
          { chargeAdmissionFee: false },
        );
        studentIds.push(created.id);
        // Most families have already activated; a few are still waiting for their slip.
        if (k !== count - 1) {
          const [acc] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.studentId, created.id));
          await activate(tx, acc.id, pw, false);
        }
      }
      demoSections.push({ id: sec.id, className: sec.className, name: sec.name, classId: sec.classId, studentIds, classTeacherId });
    }
    // Each teacher's subjects = what they were given to teach above (shown on the Staff and Classes pages).
    const taught = await tx
      .selectDistinct({ staffId: teachingAssignments.staffId, subjectId: teachingAssignments.subjectId })
      .from(teachingAssignments)
      .innerJoin(staff, eq(staff.id, teachingAssignments.staffId))
      .where(eq(staff.schoolId, schoolId));
    if (taught.length) await tx.insert(staffSubjects).values(taught);
    ctx.schools.push({ schoolId, teacherIds, principalId, accountantId, sections: demoSections, subjectIds });
  }

  await tx.insert(counters).values({ key: "demo_data", value: 1 });
  return ctx;
}
