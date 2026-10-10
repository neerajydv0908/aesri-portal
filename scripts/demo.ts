/**
 * Fill an EMPTY local database with fictional demo data, to try the portal.
 *
 *   npm run setup && npm run demo
 *
 * Refuses:
 *   - a PostgreSQL database (DATABASE_URL) unless you add --test-database
 *     (a throwaway test database; APP_SECRET must then be set, see _env.ts);
 *   - NODE_ENV=production;
 *   - a database that already has staff, students or sign-in accounts
 *     (checked inside the same transaction, see lib/demo/core.ts).
 * The demo accounts share a published password and authenticator secret.
 */
import "./_env";
import { eq } from "drizzle-orm";
import { closeDb, getDb, usingEmbeddedDb } from "../lib/db/client";
import { accounts } from "../lib/db/schema";
import { displayLoginId } from "../lib/ids";
import { DEMO_ADMIN_LOGIN, DEMO_PASSWORD, DEMO_TOTP_SECRET } from "../lib/demo/core";
import { seedDemo } from "../lib/demo";
import { seedReferenceData } from "../lib/services/reference";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to add demo data in production (NODE_ENV=production).");
  if (!usingEmbeddedDb() && !process.argv.includes("--test-database")) {
    throw new Error("DATABASE_URL is set. The demo only runs on the built-in local database, or on a throwaway test database with --test-database.");
  }
  const db = await getDb();
  const { ctx, log } = await db.transaction(async (tx) => {
    await seedReferenceData(tx);
    return seedDemo(tx);
  });

  const sample = async (staffId: string) => {
    const [a] = await db.select({ loginId: accounts.loginId }).from(accounts).where(eq(accounts.staffId, staffId));
    return a ? displayLoginId(a.loginId) : "—";
  };
  const firstStudent = async (studentId: string) => {
    const [a] = await db.select({ loginId: accounts.loginId }).from(accounts).where(eq(accounts.studentId, studentId));
    return a ? displayLoginId(a.loginId) : "—";
  };
  const rows: string[] = [];
  for (const s of ctx.schools) {
    rows.push(`  ${s.schoolId.padEnd(12)} principal ${await sample(s.principalId)} · accounts ${await sample(s.accountantId)} · teacher ${await sample(s.teacherIds[0])} · family ${await firstStudent(s.sections[5].studentIds[0])}`);
  }
  console.log(`
  Demo data added (fictional people only).${log.length ? `\n  ${log.join("\n  ")}` : ""}

  Password for every demo account:  ${DEMO_PASSWORD}
  AESRI administrator login:        ${DEMO_ADMIN_LOGIN}
  Authenticator secret (admins, principals, accountants):
      ${DEMO_TOTP_SECRET}
      (add it to Google/Microsoft Authenticator as a "key", or run: npm run demo:code)

${rows.join("\n")}
`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
  await closeDb();
  process.exit(1);
});
