/**
 * Apply database migrations to the PostgreSQL database in DATABASE_URL.
 * (The built-in local database migrates itself automatically.)
 */
import "./_env";
import { closeDb, getDb, MIGRATIONS_DIR, usingEmbeddedDb } from "../lib/db/client";

async function main() {
  const db = await getDb(); // the embedded database migrates on connect
  if (!usingEmbeddedDb()) {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }
  console.log(`Database is up to date (${usingEmbeddedDb() ? `built-in local database in ${process.env.PGLITE_DIR ?? ".data/db"}` : "PostgreSQL"}).`);
  if (usingEmbeddedDb() && !process.env.PGLITE_DIR) {
    console.log("No DATABASE_URL was set, so PostgreSQL was not touched. On the server use: npm run production -- migrate");
  }
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
