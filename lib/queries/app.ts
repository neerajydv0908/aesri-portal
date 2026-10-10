import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { counters } from "@/lib/db/schema";

/** True when the fictional demo data (npm run demo) is in this database. */
export const demoDataPresent = cache(async (): Promise<boolean> => {
  const db = await getDb();
  const [row] = await db.select({ key: counters.key }).from(counters).where(eq(counters.key, "demo_data"));
  return !!row;
});
