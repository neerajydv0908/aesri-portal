/**
 * Once a day, delete translations nobody has read for 180 days (started by
 * instrumentation-node.ts, like the text message sender). Never stops the
 * server. No "server-only" import: it runs outside any page.
 */
import { getDb } from "@/lib/db/client";
import { KEEP_UNUSED_DAYS, purgeUnusedTranslations } from "./cache";

export function startTranslationHousekeeping(): void {
  const run = async () => {
    try {
      const n = await purgeUnusedTranslations(await getDb());
      if (n) console.info(`[translate] Deleted ${n} translation${n === 1 ? "" : "s"} unused for ${KEEP_UNUSED_DAYS} days.`);
    } catch (err) {
      console.error(`[translate] Housekeeping failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  setTimeout(run, 5 * 60_000).unref?.();
  setInterval(run, 24 * 60 * 60_000).unref?.();
}
