/**
 * The embedded database (`npm run dev`, demos) applies migrations by itself:
 * when it connects, and again when a migration is added while the server
 * keeps running — so new code never meets a table or column the database
 * doesn't have yet (lib/db/client.ts).
 *
 *   node --import tsx --test tests/unit/db-dev-migrations.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { sql } from "drizzle-orm";

// A folder of its own: its drizzle/ migrations and its embedded database. The client reads
// both from the working directory and PGLITE_DIR when it loads, so set them first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-dev-migrations-"));
const migrations = path.join(dir, "drizzle");
fs.mkdirSync(path.join(migrations, "meta"), { recursive: true });
process.chdir(dir);
process.env.PGLITE_DIR = path.join(dir, "db");
delete process.env.DATABASE_URL;

type Entry = { tag: string; when: number; sql: string };
function writeMigrations(entries: Entry[]) {
  for (const e of entries) fs.writeFileSync(path.join(migrations, `${e.tag}.sql`), e.sql);
  const journal = { version: "7", dialect: "postgresql", entries: entries.map((e, idx) => ({ idx, version: "7", when: e.when, tag: e.tag, breakpoints: true })) };
  fs.writeFileSync(path.join(migrations, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
}

const first: Entry = { tag: "0000_first", when: 1_000, sql: 'CREATE TABLE "first_table" ("id" integer);' };
const second: Entry = { tag: "0001_second", when: 2_000, sql: 'CREATE TABLE "second_table" ("id" integer);' };

// Loaded on first use, after the working directory and PGLITE_DIR are set.
let loaded: typeof import("../../lib/db/client") | undefined;
const client = async () => (loaded ??= await import("../../lib/db/client"));

async function exists(table: string): Promise<boolean> {
  const db = await (await client()).getDb();
  const r = (await db.execute(sql`select to_regclass(${`public.${table}`}) as t`)) as unknown as { rows: { t: string | null }[] };
  return r.rows[0].t !== null;
}

after(async () => {
  await (await client()).closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the embedded database applies its migrations when it connects", async () => {
  writeMigrations([first]);
  assert.equal((await client()).MIGRATIONS_DIR, migrations);
  assert.equal(await exists("first_table"), true);
  assert.equal(await exists("second_table"), false);
});

test("a migration added while the server keeps running is applied before the next query", async () => {
  writeMigrations([first, second]);
  assert.equal(await exists("second_table"), true);
  // Nothing new: nothing runs again (the migrations table still has exactly two rows).
  const db = await (await client()).getDb();
  const r = (await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as { rows: { n: number }[] };
  assert.equal(r.rows[0].n, 2);
});
