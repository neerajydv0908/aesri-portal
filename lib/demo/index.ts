/**
 * Runs every demo-data module in order, in one transaction (see scripts/demo.ts).
 * The demo is made-up history, so it queues no text messages.
 */
import type { Tx } from "@/lib/db/client";
import { withoutSms } from "@/lib/sms/outbox";
import { seedDemoCore, type DemoContext } from "./core";
import { seedDemoDaily } from "./daily";
import { seedDemoExams } from "./exams";
import { seedDemoFees } from "./fees";

export async function seedDemo(tx: Tx): Promise<{ ctx: DemoContext; log: string[] }> {
  return withoutSms(async () => {
    const ctx = await seedDemoCore(tx);
    const log: string[] = [];
    log.push(...(await seedDemoDaily(tx, ctx)));
    log.push(...(await seedDemoExams(tx, ctx)));
    log.push(...(await seedDemoFees(tx, ctx)));
    return { ctx, log };
  });
}
