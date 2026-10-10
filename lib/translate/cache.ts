/**
 * The translations already made, kept in text_translations under a
 * fingerprint of the original (lib/translate/text.ts). No "server-only"
 * import: the text message outbox, and so the scripts, read it too.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { textTranslations } from "@/lib/db/schema";
import { needsHindi, prepareSource, sourceHash } from "./text";

/** Translations unused for this many days are deleted. */
export const KEEP_UNUSED_DAYS = 180;

/** The stored Hindi for these (prepared) texts, by text. */
export async function storedHindi(tx: Tx, prepared: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byHash = new Map(prepared.map((p) => [sourceHash(p), p]));
  if (!byHash.size) return out;
  const rows = await tx
    .select({ hash: textTranslations.sourceHash, text: textTranslations.text })
    .from(textTranslations)
    .where(and(eq(textTranslations.lang, "hi"), inArray(textTranslations.sourceHash, [...byHash.keys()])));
  for (const r of rows) {
    const p = byHash.get(r.hash);
    if (p) out.set(p, r.text);
  }
  return out;
}

/** Keep new translations (a text translated twice at the same moment is kept once). */
export async function storeHindi(tx: Tx, rows: { prepared: string; text: string }[], provider: string): Promise<void> {
  if (!rows.length) return;
  await tx
    .insert(textTranslations)
    .values(rows.map((r) => ({ sourceHash: sourceHash(r.prepared), lang: "hi", text: r.text, provider })))
    .onConflictDoNothing();
}

/** Note that these translations were read (at most once a week, so reading pages doesn't mean writing every time). */
export async function touchHindi(tx: Tx, prepared: string[]): Promise<void> {
  if (!prepared.length) return;
  await tx
    .update(textTranslations)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(textTranslations.lang, "hi"),
        inArray(
          textTranslations.sourceHash,
          prepared.map((p) => sourceHash(p)),
        ),
        lt(textTranslations.usedAt, sql`now() - interval '7 days'`),
      ),
    );
}

/** The Hindi translation of one text if one was already made (null otherwise). Never asks the translation service. */
export async function cachedHindi(tx: Tx, text: string | null | undefined): Promise<string | null> {
  const p = prepareSource(text ?? "");
  if (!needsHindi(p)) return null;
  return (await storedHindi(tx, [p])).get(p) ?? null;
}

/**
 * Let the translations of these texts go (what they translate was deleted
 * or rewritten — a remark taken back shouldn't linger in Hindi): marked as
 * unread for longer than KEEP_UNUSED_DAYS, so the next daily clean-up deletes
 * them — unless a family reads the same words elsewhere before then (a
 * translation is shared by every text that says the same), which keeps it.
 */
export async function expireHindi(tx: Tx, texts: (string | null | undefined)[]): Promise<void> {
  const hashes = [...new Set(texts.map((t) => prepareSource(t ?? "")).filter(needsHindi).map(sourceHash))];
  if (!hashes.length) return;
  await tx
    .update(textTranslations)
    .set({ usedAt: sql`now() - make_interval(days => ${KEEP_UNUSED_DAYS + 1}::int)` })
    .where(inArray(textTranslations.sourceHash, hashes));
}

/** Delete translations nobody has read for KEEP_UNUSED_DAYS days; returns how many. */
export async function purgeUnusedTranslations(tx: Tx, days = KEEP_UNUSED_DAYS): Promise<number> {
  const rows = await tx
    .delete(textTranslations)
    .where(lt(textTranslations.usedAt, sql`now() - make_interval(days => ${Math.max(1, Math.floor(days))}::int)`))
    .returning({ hash: textTranslations.sourceHash });
  return rows.length;
}
