/**
 * Reference data the portal needs before anyone signs in: the two schools,
 * the academic session, classes and sections, known subjects and the
 * approved fee plans (the same figures as the public website, version 2).
 *
 * Safe to run more than once: existing rows are left alone.
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import {
  academicSessions,
  classSubjects,
  classes,
  feeBands,
  feeInstalments,
  feeOneTime,
  feePlans,
  schools,
  sections,
  subjects,
} from "@/lib/db/schema";

const OFFICE_PHONE = "+91 75973 82016";
const OFFICE_EMAIL = "deepakudairamsar@gmail.com";
const settings = { passPercent: 33, attendanceWarnPercent: 75 };

export const SCHOOLS = [
  {
    id: "aryavart",
    code: "ARY",
    loginPrefix: "Arya",
    name: "Aryavart Public School",
    nameHi: "आर्यवर्त पब्लिक स्कूल",
    place: "Palana, Bikaner",
    phone: OFFICE_PHONE,
    email: OFFICE_EMAIL,
    settings,
  },
  {
    id: "aadharshila",
    code: "AAD",
    loginPrefix: "Aadhar",
    name: "Aadharshila Public School",
    nameHi: "आधारशिला पब्लिक स्कूल",
    place: "Udairamsar, Bikaner",
    phone: OFFICE_PHONE,
    email: OFFICE_EMAIL,
    settings,
  },
] as const;

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const CLASS_LISTS: Record<string, { name: string; stream?: string }[]> = {
  aryavart: [{ name: "LKG" }, { name: "UKG" }, ...ROMAN.slice(0, 10).map((name) => ({ name })), { name: "XI", stream: "Arts" }, { name: "XII", stream: "Arts" }],
  aadharshila: [{ name: "Nursery" }, { name: "LKG" }, { name: "UKG" }, ...ROMAN.slice(0, 10).map((name) => ({ name }))],
};

/** Subjects from the Aadharshila prospectus. Other classes are set up by the office. */
const KNOWN_SUBJECTS: Record<string, { name: string; nameHi: string; classes: string[] }[]> = {
  aadharshila: [
    { name: "Hindi", nameHi: "हिंदी", classes: ROMAN.slice(0, 8) },
    { name: "English", nameHi: "अंग्रेज़ी", classes: ROMAN.slice(0, 8) },
    { name: "Mathematics", nameHi: "गणित", classes: ROMAN.slice(0, 8) },
    { name: "Environmental Education", nameHi: "पर्यावरण शिक्षा", classes: ROMAN.slice(0, 5) },
    { name: "Sanskrit", nameHi: "संस्कृत", classes: ROMAN.slice(5, 8) },
    { name: "Computer Science", nameHi: "कंप्यूटर विज्ञान", classes: ROMAN.slice(0, 8) },
    { name: "General Knowledge", nameHi: "सामान्य ज्ञान", classes: ROMAN.slice(0, 8) },
    { name: "Art & Drawing", nameHi: "कला एवं चित्रकला", classes: ROMAN.slice(0, 5) },
    { name: "Physical Health & Education", nameHi: "शारीरिक स्वास्थ्य एवं शिक्षा", classes: ROMAN.slice(0, 5) },
    { name: "Socially Useful & Productive Work", nameHi: "समाजोपयोगी उत्पादक कार्य", classes: ROMAN.slice(5, 8) },
  ],
  aryavart: [],
};

const L = (from: number, to: number) => ROMAN.slice(from - 1, to);

/** Approved fee structure, version 2 (same as the website's content/fees.ts). Amounts in paise. */
const FEE_PLANS: Record<string, { bands: { label: string; labelHi: string; classNames: string[]; annual: number }[] }> = {
  aryavart: {
    bands: [
      { label: "LKG – Class V", labelHi: "एलकेजी – कक्षा 5", classNames: ["LKG", "UKG", ...L(1, 5)], annual: 10_000_00 },
      { label: "Classes VI – VIII", labelHi: "कक्षा 6 – 8", classNames: L(6, 8), annual: 13_000_00 },
      { label: "Class IX", labelHi: "कक्षा 9", classNames: ["IX"], annual: 16_000_00 },
      { label: "Class X", labelHi: "कक्षा 10", classNames: ["X"], annual: 18_000_00 },
      { label: "Classes XI – XII (Arts)", labelHi: "कक्षा 11 – 12 (कला संकाय)", classNames: ["XI", "XII"], annual: 25_000_00 },
    ],
  },
  aadharshila: {
    bands: [
      { label: "Nursery – Class V", labelHi: "नर्सरी – कक्षा 5", classNames: ["Nursery", "LKG", "UKG", ...L(1, 5)], annual: 10_000_00 },
      { label: "Classes VI – VIII", labelHi: "कक्षा 6 – 8", classNames: L(6, 8), annual: 14_000_00 },
      { label: "Class IX", labelHi: "कक्षा 9", classNames: ["IX"], annual: 16_000_00 },
      { label: "Class X", labelHi: "कक्षा 10", classNames: ["X"], annual: 18_000_00 },
    ],
  },
};

/**
 * Instalment split. The dates come from Aadharshila's prospectus (Term I by
 * 10 April, Term II by 15 September); the 50/50 split is a default the
 * office should confirm in Settings → Fees. Aryavart uses the same default.
 * In Hindi an instalment is a किस्त ("सत्र" is the school year, as in सत्र 2026-27).
 * Fee lines copy these labels when they are created.
 */
const INSTALMENTS = [
  { label: "Term I", labelHi: "पहली किस्त", dueMonthDay: "04-10", percent: 50 },
  { label: "Term II", labelHi: "दूसरी किस्त", dueMonthDay: "09-15", percent: 50 },
];

export const CURRENT_SESSION = { id: "2026-27", startsOn: "2026-04-01", endsOn: "2027-03-31" };

export async function seedReferenceData(tx: Tx): Promise<string[]> {
  const log: string[] = [];

  for (const s of SCHOOLS) {
    const inserted = await tx.insert(schools).values({ ...s, settings: { ...s.settings } }).onConflictDoNothing().returning({ id: schools.id });
    if (inserted.length) log.push(`School: ${s.name}`);
  }

  const sess = await tx.insert(academicSessions).values({ ...CURRENT_SESSION, isCurrent: true }).onConflictDoNothing().returning({ id: academicSessions.id });
  if (sess.length) log.push(`Academic session ${CURRENT_SESSION.id}`);

  for (const school of SCHOOLS) {
    // Classes and one section "A" each
    const list = CLASS_LISTS[school.id];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      let [cls] = await tx.select().from(classes).where(and(eq(classes.schoolId, school.id), eq(classes.name, c.name)));
      if (!cls) {
        [cls] = await tx.insert(classes).values({ schoolId: school.id, name: c.name, stream: c.stream ?? null, sortOrder: i }).returning();
        log.push(`${school.name}: class ${c.name}${c.stream ? ` (${c.stream})` : ""}`);
      }
      await tx.insert(sections).values({ classId: cls.id, sessionId: CURRENT_SESSION.id, name: "A" }).onConflictDoNothing();
    }

    // Subjects known from school documents
    const known = KNOWN_SUBJECTS[school.id];
    for (let i = 0; i < known.length; i++) {
      const sub = known[i];
      let [row] = await tx.select().from(subjects).where(and(eq(subjects.schoolId, school.id), eq(subjects.name, sub.name)));
      if (!row) {
        [row] = await tx.insert(subjects).values({ schoolId: school.id, name: sub.name, nameHi: sub.nameHi, sortOrder: i }).returning();
      }
      for (const className of sub.classes) {
        const [cls] = await tx.select({ id: classes.id }).from(classes).where(and(eq(classes.schoolId, school.id), eq(classes.name, className)));
        if (cls) await tx.insert(classSubjects).values({ classId: cls.id, subjectId: row.id }).onConflictDoNothing();
      }
    }

    // Fee plan version 2
    const [plan] = await tx.select().from(feePlans).where(and(eq(feePlans.schoolId, school.id), eq(feePlans.version, 2)));
    if (!plan) {
      const [p] = await tx
        .insert(feePlans)
        .values({ schoolId: school.id, version: 2, appliesFrom: CURRENT_SESSION.id, isCurrent: true, approvalRef: null })
        .returning();
      const def = FEE_PLANS[school.id];
      await tx.insert(feeBands).values(
        def.bands.map((b, i) => ({ planId: p.id, label: b.label, labelHi: b.labelHi, classNames: b.classNames, annualAmount: b.annual, sortOrder: i })),
      );
      await tx.insert(feeInstalments).values(INSTALMENTS.map((ins, i) => ({ planId: p.id, ...ins, sortOrder: i })));
      await tx.insert(feeOneTime).values({ planId: p.id, key: "admission", label: "Admission fee", labelHi: "प्रवेश शुल्क", amount: 2_000_00, refundable: false });
      log.push(`${school.name}: fee plan version 2`);
    }
  }
  return log;
}
