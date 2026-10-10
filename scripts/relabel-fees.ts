/**
 * Rewrite this session's instalment fee lines so they name the student's own
 * class, as new lines do: "Term II — LKG – Class V" becomes "Term II —
 * Class II", and "दूसरी किस्त — एलकेजी – कक्षा 5" becomes "दूसरी किस्त —
 * कक्षा 2". The old wording read like one fee shared by the whole group of
 * classes; the fee is per student, per year.
 *
 * Only the labels change: amounts, due dates, waivers, payments and receipt
 * numbers stay as they are (receipts show the new wording). Everything is
 * changed in one transaction, with one activity-log entry per school. Safe to
 * run again: lines already in the new form are left alone.
 *
 *   npm run fees:relabel -- --dry-run   # list what would change, change nothing
 *   npm run fees:relabel                # change it
 *   npm run fees:relabel -- --session 2026-27
 *
 * With the built-in database (no DATABASE_URL), stop the portal first: only
 * one program can have that database open at a time.
 */
import "./_env";
import { parseArgs } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "../lib/db/client";
import { academicSessions, classes, enrolments, feeInstalments, feePlans, schools, sections, studentCharges } from "../lib/db/schema";
import { audit, type AuditActor } from "../lib/audit";
import { instalmentLineLabels, isLineOf } from "../lib/services/fees";

const CLI: AuditActor = { accountId: null, loginId: "command line" };

type SchoolReport = {
  name: string;
  changed: number;
  already: number;
  /** Students not placed in a class this session: their lines can't name a class. */
  unplaced: number;
  /** Lines whose label doesn't start with one of the plan's instalments ("Term I — "). */
  unknown: string[];
  changes: Map<string, { from: string; to: string; fromHi: string; toHi: string; lines: number }>;
};

async function main() {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false }, session: { type: "string" } } });
  const dryRun = values["dry-run"] ?? false;
  const db = await getDb();

  const { sessionId, reports } = await db.transaction(async (tx) => {
    const [session] = values.session
      ? await tx.select({ id: academicSessions.id }).from(academicSessions).where(eq(academicSessions.id, values.session))
      : await tx.select({ id: academicSessions.id }).from(academicSessions).where(eq(academicSessions.isCurrent, true));
    if (!session) throw new Error(values.session ? `There is no session ${values.session}.` : "There is no current session. Run npm run setup first.");

    // Every instalment line of the session, with the student's class this session (locked until the end).
    const lines = await tx
      .select({
        id: studentCharges.id,
        schoolId: studentCharges.schoolId,
        planId: studentCharges.planId,
        label: studentCharges.label,
        labelHi: studentCharges.labelHi,
        className: classes.name,
        stream: classes.stream,
      })
      .from(studentCharges)
      .leftJoin(enrolments, and(eq(enrolments.studentId, studentCharges.studentId), eq(enrolments.sessionId, studentCharges.sessionId)))
      .leftJoin(sections, eq(sections.id, enrolments.sectionId))
      .leftJoin(classes, eq(classes.id, sections.classId))
      .where(and(eq(studentCharges.sessionId, session.id), eq(studentCharges.kind, "instalment")))
      .orderBy(studentCharges.schoolId, studentCharges.label)
      .for("update", { of: studentCharges });

    // The instalments of each line's plan (lines without a plan: the school's current plan).
    const schoolRows = await tx.select({ id: schools.id, name: schools.name }).from(schools).orderBy(schools.id);
    const currentPlans = await tx.select({ id: feePlans.id, schoolId: feePlans.schoolId }).from(feePlans).where(eq(feePlans.isCurrent, true));
    const planIds = [...new Set([...lines.map((l) => l.planId), ...currentPlans.map((p) => p.id)].filter((x): x is string => !!x))];
    const instalments = planIds.length ? await tx.select().from(feeInstalments).where(inArray(feeInstalments.planId, planIds)) : [];
    const instalmentsOf = (planId: string | null, schoolId: string) => {
      const id = planId ?? currentPlans.find((p) => p.schoolId === schoolId)?.id;
      return instalments.filter((i) => i.planId === id);
    };

    const reports = new Map<string, SchoolReport>(
      schoolRows.map((s) => [s.id, { name: s.name, changed: 0, already: 0, unplaced: 0, unknown: [], changes: new Map() }]),
    );
    const changedIds = new Map<string, { label: string; labelHi: string; ids: string[] }>();
    for (const l of lines) {
      const r = reports.get(l.schoolId)!;
      if (!l.className) {
        r.unplaced++;
        continue;
      }
      const ins = instalmentsOf(l.planId, l.schoolId).find((i) => isLineOf(i, l.label));
      if (!ins) {
        if (!r.unknown.includes(l.label)) r.unknown.push(l.label);
        continue;
      }
      const next = instalmentLineLabels(ins, l.className, l.stream);
      if (next.label === l.label && next.labelHi === l.labelHi) {
        r.already++;
        continue;
      }
      r.changed++;
      const key = `${l.label}\u0000${l.labelHi}\u0000${next.label}\u0000${next.labelHi}`;
      const c = r.changes.get(key) ?? { from: l.label, to: next.label, fromHi: l.labelHi, toHi: next.labelHi, lines: 0 };
      c.lines++;
      r.changes.set(key, c);
      const group = changedIds.get(`${next.label}\u0000${next.labelHi}`) ?? { ...next, ids: [] };
      group.ids.push(l.id);
      changedIds.set(`${next.label}\u0000${next.labelHi}`, group);
    }

    if (!dryRun) {
      for (const g of changedIds.values()) {
        for (let i = 0; i < g.ids.length; i += 500) {
          await tx
            .update(studentCharges)
            .set({ label: g.label, labelHi: g.labelHi })
            .where(inArray(studentCharges.id, g.ids.slice(i, i + 500)));
        }
      }
      for (const [schoolId, r] of reports) {
        if (!r.changed) continue;
        await audit(tx, CLI, "fees.lines_relabelled", {
          schoolId,
          targetType: "session",
          targetId: session.id,
          details: {
            lines: r.changed,
            changes: [...r.changes.values()].map((c) => ({ from: c.from, to: c.to, lines: c.lines })),
            ...(r.unplaced ? { notPlaced: r.unplaced } : {}),
            ...(r.unknown.length ? { unknownLabels: r.unknown } : {}),
          },
        });
      }
    }
    return { sessionId: session.id, reports };
  });

  const out: string[] = [`\n  Instalment fee lines, session ${sessionId}${dryRun ? " (dry run: nothing is changed)" : ""}`, "  " + "─".repeat(60)];
  for (const r of reports.values()) {
    const verb = dryRun ? "would be relabelled" : "relabelled";
    out.push(`  ${r.name}: ${r.changed} ${r.changed === 1 ? "line" : "lines"} ${verb}, ${r.already} already in the new form`);
    for (const c of [...r.changes.values()].sort((a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from))) {
      out.push(`      ${c.from}  →  ${c.to}   (${c.lines})`, `      ${c.fromHi}  →  ${c.toHi}`);
    }
    if (r.unplaced) out.push(`      Left as they are: ${r.unplaced} ${r.unplaced === 1 ? "line" : "lines"} of students not placed in a class this session.`);
    if (r.unknown.length) out.push(`      Left as they are: lines that don't start with an instalment of the fee plan: ${r.unknown.join("; ")}`);
  }
  const total = [...reports.values()].reduce((a, r) => a + r.changed, 0);
  out.push(
    "",
    dryRun
      ? total
        ? "  Run it again without --dry-run to make these changes."
        : "  Nothing to change."
      : total
        ? "  Done. Each school's change is in its activity log (fees.lines_relabelled)."
        : "  Nothing to change: every line already names the student's class.",
    "",
  );
  console.log(out.join("\n"));
  await closeDb();
}

main().catch(async (err) => {
  console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
  await closeDb();
  process.exit(1);
});
