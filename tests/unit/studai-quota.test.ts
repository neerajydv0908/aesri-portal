import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db/client";
import { accounts, inferenceQuotas } from "../../lib/db/schema";
import { consumeInferenceQuota, inferenceLimits } from "../../lib/studai/quota";

let client: PGlite;
let db: Tx;
let user: string;
let other: string;
before(async () => {
  client = await PGlite.create();
  const d = drizzle(client);
  await migrate(d, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  db = d as unknown as Tx;
  const rows = await db.insert(accounts).values([
    { loginId: "quota-audit-a", role: "super_admin", status: "active" },
    { loginId: "quota-audit-b", role: "super_admin", status: "active" },
  ]).returning({ id: accounts.id });
  [user, other] = rows.map(r => r.id);
});
after(async () => client?.close());

test("atomic per-account minute and day quotas survive concurrent admission", async () => {
  const limits = { minute: 5, day: 7 };
  const first = await Promise.all(Array.from({ length: 30 }, () => consumeInferenceQuota(db, user, limits)));
  assert.equal(first.filter(Boolean).length, 5);
  assert.equal(await consumeInferenceQuota(db, other, limits), true);
  await db.update(inferenceQuotas).set({ minuteStart: sql`now() - interval '2 minutes'` }).where(eq(inferenceQuotas.accountId, user));
  const second = await Promise.all(Array.from({ length: 30 }, () => consumeInferenceQuota(db, user, limits)));
  assert.equal(second.filter(Boolean).length, 2);
  // A new minute cannot bypass the day quota, even after a new database handle.
  await db.update(inferenceQuotas).set({ minuteStart: sql`now() - interval '2 minutes'` }).where(eq(inferenceQuotas.accountId, user));
  assert.equal(await consumeInferenceQuota(drizzle(client) as unknown as Tx, user, limits), false);
  const [row] = await db.select().from(inferenceQuotas).where(eq(inferenceQuotas.accountId, user));
  assert.equal(row.dayCount, 7);
  await db.update(inferenceQuotas).set({ minuteStart: sql`now() - interval '2 minutes'`, dayStart: sql`now() - interval '2 days'` }).where(eq(inferenceQuotas.accountId, user));
  assert.equal(await consumeInferenceQuota(db, user, limits), true);
});

test("quota config cannot silently disable admission", () => {
  assert.deepEqual(inferenceLimits({}), { minute: 20, day: 200 });
  for (const value of ["0", "-1", "Infinity", "bad", "1.5", "10001"]) {
    assert.throws(() => inferenceLimits({ STUD_AI_PER_DAY: value }));
  }
});
