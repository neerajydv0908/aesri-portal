import { sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { inferenceQuotas as q } from "@/lib/db/schema";

export function inferenceLimits(env: Record<string, string | undefined> = process.env) {
  const read = (key: string, fallback: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${key} must be an integer from 1 to ${max}.`);
    return value;
  };
  return { minute: read("STUD_AI_PER_MINUTE", 20, 1000), day: read("STUD_AI_PER_DAY", 200, 10000) };
}

/** Atomic admission across every Node worker, using the database clock.
 * Windows are fixed UTC minute/day windows; rejected calls do not consume quota.
 */
export async function consumeInferenceQuota(db: Tx, accountId: string, limits = inferenceLimits()): Promise<boolean> {
  if (!/^[a-f0-9-]{36}$/i.test(accountId)) throw new Error("Inference requires an authenticated account.");
  if (![limits.minute, limits.day].every(n => Number.isInteger(n) && n > 0)) throw new Error("Invalid inference limits.");
  const minute = sql`date_trunc('minute', now())`;
  const day = sql`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`;
  const newMinute = sql`${q.minuteStart} < ${minute}`;
  const newDay = sql`${q.dayStart} < ${day}`;
  const admitted = await db.insert(q).values({ accountId, minuteStart: minute, minuteCount: 1, dayStart: day, dayCount: 1 })
    .onConflictDoUpdate({
      target: q.accountId,
      set: {
        minuteStart: minute,
        minuteCount: sql`case when ${newMinute} then 1 else ${q.minuteCount} + 1 end`,
        dayStart: day,
        dayCount: sql`case when ${newDay} then 1 else ${q.dayCount} + 1 end`,
      },
      setWhere: sql`(${newMinute} or ${q.minuteCount} < ${limits.minute}) and (${newDay} or ${q.dayCount} < ${limits.day})`,
    }).returning({ accountId: q.accountId });
  return admitted.length === 1;
}
