/**
 * Database connection.
 *
 * - With DATABASE_URL set, connects to PostgreSQL (production).
 * - Without it, uses PGlite: a real PostgreSQL engine that runs inside Node
 *   and stores its files in ./.data/db. Good for trying the portal on a
 *   laptop; not for production (one process only, no backups).
 *
 * The connection is created lazily on first use and reused afterwards. The
 * embedded database applies migrations itself: when it connects, and again
 * whenever drizzle/meta/_journal.json changes while the server keeps running
 * (new code with a new migration, under `npm run dev`), so a page never meets
 * a table or column it doesn't have yet. PostgreSQL is migrated on purpose
 * (`npm run db:migrate`, with the migration identity).
 */
import fs from "node:fs";
import path from "node:path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0] | DB;

const g = globalThis as unknown as {
  __aesriDb?: Promise<DB>;
  __aesriClose?: () => Promise<void>;
  /** The migrations journal as the embedded database last applied it (size and change time). */
  __aesriJournal?: string;
  __aesriMigrating?: Promise<void>;
};

export const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

export function usingEmbeddedDb(): boolean {
  return !process.env.DATABASE_URL;
}

export function getDb(): Promise<DB> {
  if (!g.__aesriDb) {
    g.__aesriDb = connect().catch((err) => {
      g.__aesriDb = undefined;
      throw err;
    });
  }
  return usingEmbeddedDb() ? g.__aesriDb.then(upToDate) : g.__aesriDb;
}

/** A stamp of the migrations journal (size and change time): it changes when a migration is added. */
function journalStamp(): string {
  try {
    const st = fs.statSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"));
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
}

/** Run the embedded database's migrations, one run at a time, and remember the journal it saw. */
function migrateEmbedded(db: DB): Promise<void> {
  g.__aesriMigrating ??= (async () => {
    const stamp = journalStamp();
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS_DIR });
    g.__aesriJournal = stamp;
  })().finally(() => {
    g.__aesriMigrating = undefined;
  });
  return g.__aesriMigrating;
}

/** The embedded database, with any migration added since it connected applied first. */
async function upToDate(db: DB): Promise<DB> {
  if (g.__aesriJournal !== journalStamp()) await migrateEmbedded(db);
  return db;
}

async function connect(): Promise<DB> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_SIZE) || 10 });
    // An idle connection that drops (database restart, network blip) is replaced by the pool;
    // without a listener its 'error' event would be an uncaught exception.
    pool.on("error", (err) => console.error(`[db] idle database connection lost: ${err.message}`));
    g.__aesriClose = () => pool.end();
    return drizzle(pool, { schema });
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dir = process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "db");
  fs.mkdirSync(dir, { recursive: true });
  const client = await PGlite.create(dir);
  const db = drizzle(client, { schema }) as unknown as DB;
  // The embedded database keeps itself up to date so `npm run dev` just works.
  await migrateEmbedded(db);
  g.__aesriClose = () => client.close();
  return db;
}

/** Close the connection (used by scripts so Node can exit). */
export async function closeDb(): Promise<void> {
  if (g.__aesriClose) await g.__aesriClose();
  g.__aesriDb = undefined;
  g.__aesriClose = undefined;
  g.__aesriJournal = undefined;
}

export { schema };
