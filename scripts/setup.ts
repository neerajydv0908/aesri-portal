/**
 * First-time setup: bring the database up to date and add the reference
 * data (schools, session 2026-27, classes, sections, known subjects and the
 * approved fee plans). Safe to run again.
 *
 *   npm run setup
 */
import "./_env";
import { closeDb, getDb, MIGRATIONS_DIR, usingEmbeddedDb } from "../lib/db/client";
import { seedReferenceData } from "../lib/services/reference";

async function main() {
  const db = await getDb();
  if (!usingEmbeddedDb()) {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }
  const log = await db.transaction((tx) => seedReferenceData(tx));
  console.log(log.length ? `Added:\n  - ${log.join("\n  - ")}` : "Reference data already present — nothing to add.");
  const command = process.env.NODE_ENV === "production" ? "node scripts/with-production-secrets.mjs admin:create" : "npm run admin:create --";
  console.log(`\nNext: create the AESRI administrator account with\n  ${command} --id <login-id> --name "<Full name>"`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
