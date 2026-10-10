"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { schools } from "@/lib/db/schema";
import { auditActor, requireActor } from "@/lib/auth/dal";
import { done, fail, type FormState } from "@/lib/forms";
import { smsProviderName } from "@/lib/sms/config";
import { isTemplateId, saveTemplateIds, templateIdKey } from "@/lib/sms/settings";
import { SMS_LANGS, TEMPLATE_KEYS } from "@/lib/sms/templates";
import { str } from "@/lib/validation";

/**
 * Save one school's template IDs at the SMS company, for each template and
 * language (empty = not set up yet). AESRI administrators only.
 */
export async function saveTemplateIdsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await requireActor(["super_admin"]);
  const provider = smsProviderName();
  if (provider === "log") return fail("No SMS company is set up on the server yet (SMS_PROVIDER), so there are no template IDs to enter.");
  const db = await getDb();
  const [school] = await db.select({ id: schools.id, name: schools.name }).from(schools).where(eq(schools.id, str(formData, "school")));
  if (!school) return fail("Something went wrong with that request. Reload the page and try again.");
  const next: Record<string, string> = {};
  const fields: Record<string, string> = {};
  for (const key of TEMPLATE_KEYS) {
    for (const lang of SMS_LANGS) {
      const k = templateIdKey(key, lang);
      const v = str(formData, `id:${k}`).replace(/\s+/g, "");
      if (!v) continue;
      if (!isTemplateId(v)) fields[`id:${k}`] = "Use the ID exactly as the SMS company shows it: letters, digits, - and _ only (up to 64).";
      else next[k] = v;
    }
  }
  if (Object.keys(fields).length) return fail("Please check the highlighted boxes.", fields);
  const who = await auditActor(actor);
  const changed = await db.transaction((tx) => saveTemplateIds(tx, provider, school, next, who));
  if (!changed.length) return done("Nothing had changed.");
  refresh();
  return done(
    `Saved ${changed.length} ${changed.length === 1 ? "template ID" : "template IDs"} for ${school.name}. Messages that use them are sent from now on; send a test message to check.`,
  );
}
