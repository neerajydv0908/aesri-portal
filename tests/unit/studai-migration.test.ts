import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db/client";
import * as s from "../../lib/db/schema";
import { seedReferenceData } from "../../lib/services/reference";

test("security migration removes only derived probabilities and preserves source records", async () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-old-schema-"));
  const client = await PGlite.create();
  try {
    fs.mkdirSync(path.join(old, "meta"));
    const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 4);
    fs.writeFileSync(path.join(old, "meta", "_journal.json"), JSON.stringify(journal));
    for (const e of journal.entries) fs.copyFileSync(`drizzle/${e.tag}.sql`, path.join(old, `${e.tag}.sql`));
    const d = drizzle(client);
    const db = d as unknown as Tx;
    await migrate(d, { migrationsFolder: old });
    await db.transaction(tx => seedReferenceData(tx));
    const [student] = await db.insert(s.students).values({ schoolId: "aryavart", srNo: "security-fixture", name: "Synthetic upgrade student" }).returning();
    const [subject] = await db.insert(s.subjects).values({ schoolId: "aryavart", name: "Security fixture subject", sortOrder: 999 }).returning();
    const [account] = await db.insert(s.accounts).values({ loginId: "migration-fixture", role: "super_admin", status: "active" }).returning();
    const [exam] = await db.insert(s.exams).values({ schoolId: "aryavart", sessionId: "2026-27", name: "Security fixture exam", sortOrder: 999 }).returning();
    await db.insert(s.marks).values({ studentId: student.id, subjectId: subject.id, examId: exam.id, marks: "41", absent: false, enteredBy: account.id });
    await db.execute(sql`insert into risk_estimates (session_id, student_id, subject_id, percent, risk, text, reasons, assumed, known_subject, tests_used, computed_at)
      values ('2026-27', ${student.id}, ${subject.id}, 55, 0.55, 'legacy probability', '[]', '[]', true, 1, now())`);
    await db.execute(sql`insert into risk_checks (session_id, student_id, fingerprint, checked_at) values ('2026-27', ${student.id}, 'old', now())`);
    await migrate(d, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    assert.equal((await db.select().from(s.riskEstimates)).length, 0);
    assert.equal((await db.select().from(s.riskChecks)).length, 0);
    assert.equal((await db.select().from(s.students).where(eq(s.students.id, student.id))).length, 1);
    assert.equal(Number((await db.select().from(s.marks).where(eq(s.marks.studentId, student.id)))[0].marks), 41);
    await db.insert(s.riskEstimates).values({ sessionId: "2026-27", studentId: student.id, subjectId: subject.id, percent: 55, text: "Estimated risk of not passing the next mathematics examination: 55%", reasons: [], assumed: [], knownSubject: true, testsUsed: 1, computedAt: new Date() });
  } finally {
    await client.close();
    fs.rmSync(old, { recursive: true, force: true });
  }
});

test("restoring the percentages removes only the derived classifications and preserves source records", async () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-classes-schema-"));
  const client = await PGlite.create();
  try {
    fs.mkdirSync(path.join(old, "meta"));
    const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 8);
    fs.writeFileSync(path.join(old, "meta", "_journal.json"), JSON.stringify(journal));
    for (const e of journal.entries) fs.copyFileSync(`drizzle/${e.tag}.sql`, path.join(old, `${e.tag}.sql`));
    const d = drizzle(client);
    const db = d as unknown as Tx;
    await migrate(d, { migrationsFolder: old });
    await db.transaction(tx => seedReferenceData(tx));
    const [student] = await db.insert(s.students).values({ schoolId: "aryavart", srNo: "restore-fixture", name: "Synthetic restore student" }).returning();
    const [subject] = await db.insert(s.subjects).values({ schoolId: "aryavart", name: "Restore fixture subject", sortOrder: 999 }).returning();
    const [account] = await db.insert(s.accounts).values({ loginId: "restore-fixture", role: "super_admin", status: "active" }).returning();
    const [exam] = await db.insert(s.exams).values({ schoolId: "aryavart", sessionId: "2026-27", name: "Restore fixture exam", sortOrder: 999 }).returning();
    await db.insert(s.marks).values({ studentId: student.id, subjectId: subject.id, examId: exam.id, marks: "41", absent: false, enteredBy: account.id });
    await db.execute(sql`insert into risk_estimates (session_id, student_id, subject_id, decision, review_reason, tests_used, computed_at)
      values ('2026-27', ${student.id}, ${subject.id}, 'review', 'low_confidence', 1, now())`);
    await db.execute(sql`insert into risk_checks (session_id, student_id, fingerprint, checked_at) values ('2026-27', ${student.id}, 'old', now())`);
    await migrate(d, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    assert.equal((await db.select().from(s.riskEstimates)).length, 0);
    assert.equal((await db.select().from(s.riskChecks)).length, 0);
    assert.equal((await db.select().from(s.students).where(eq(s.students.id, student.id))).length, 1);
    assert.equal(Number((await db.select().from(s.marks).where(eq(s.marks.studentId, student.id)))[0].marks), 41);
    // A subject Stud-AI wasn't trained on is saved without a percentage.
    await db.insert(s.riskEstimates).values({ sessionId: "2026-27", studentId: student.id, subjectId: subject.id, percent: null, text: "Not enough data as of now for Hindi", reasons: [], assumed: [], knownSubject: false, testsUsed: 1, computedAt: new Date() });
    assert.equal((await db.select().from(s.riskEstimates))[0].percent, null);
  } finally {
    await client.close();
    fs.rmSync(old, { recursive: true, force: true });
  }
});
