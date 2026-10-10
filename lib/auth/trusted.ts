/**
 * Trusted browsers. After a right authenticator code, an administrator can
 * tick "Trust this browser for 30 days": signing in on that browser then
 * asks for the password only. The browser keeps a random token in a cookie
 * (./trusted-cookie.ts, ./trusted-browser.ts); the database keeps only its
 * SHA-256, with the account, when the trust ends, a keyed fingerprint of
 * the authenticator key it was trusted with, and a short name for the list
 * ("Chrome on Windows"). Rows whose 30 days are over are cleared away at the
 * next administrator's sign-in.
 *
 * A trusted browser never stands in for the password, only for the code.
 * It stops working when its 30 days are up or the authenticator app is set
 * up again (a new key), and it is forgotten:
 *   - whenever the account is signed out everywhere for a reason: a new
 *     slip, activating with a slip, sign-in turned off (or on again), a
 *     change of access (lib/services/accounts.ts, staff.ts, students.ts);
 *   - when the person signs out on all other devices or changes their
 *     password (every other browser; this one stays trusted);
 *   - when the person forgets it on their account page.
 *
 * No "server-only" here: services (also used by scripts) forget trusted
 * browsers inside their own transactions, and unit tests use it directly.
 */
import { and, desc, eq, gt, lte, ne, notInArray } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { accounts, trustedBrowsers } from "@/lib/db/schema";
import { browserLabel } from "./browser-label";
import { newSessionToken, safeEqualHex, sessionIdFromToken, trustMac } from "./crypto";

/** How long a browser stays trusted after the code was entered there. */
export const TRUST_DAYS = 30;
/** Trusted browsers kept per account: beyond this, the oldest go. */
export const MAX_TRUSTED_PER_ACCOUNT = 10;

export type TrustedBrowser = typeof trustedBrowsers.$inferSelect;

/** What decides whether an account's trusted browsers work. */
export type TrustAccount = { id: string; status: string; totpEnabled: boolean; totpSecretEnc: string | null };

/** Keyed fingerprint of the account's (encrypted) authenticator key: a new key leaves every trusted browser stale. */
export const totpTagOf = (totpSecretEnc: string) => trustMac(`totp|${totpSecretEnc}`).slice(0, 32);

/** The row id for a cookie's token (its SHA-256, as for session tokens). */
export const trustIdOf = (token: string) => sessionIdFromToken(token);

const usable = (acc: TrustAccount): acc is TrustAccount & { totpSecretEnc: string } => acc.status === "active" && acc.totpEnabled && !!acc.totpSecretEnc;

/**
 * Trust a browser for this account: call only right after a right
 * authenticator code, inside a transaction. Returns the token for the
 * browser's cookie, or null when the account can't have trusted browsers
 * (not active, or two-step sign-in not set up).
 */
export async function trustBrowser(tx: Tx, accountId: string, userAgent: string | null, now = new Date()): Promise<{ token: string; row: TrustedBrowser } | null> {
  // Locked, so turning sign-in off (or a change of access) at the same moment waits for this and then forgets it.
  const [acc] = await tx
    .select({ id: accounts.id, status: accounts.status, totpEnabled: accounts.totpEnabled, totpSecretEnc: accounts.totpSecretEnc })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for("update");
  if (!acc || !usable(acc)) return null;
  const token = newSessionToken();
  const [row] = await tx
    .insert(trustedBrowsers)
    .values({
      id: trustIdOf(token),
      accountId,
      totpTag: totpTagOf(acc.totpSecretEnc),
      createdAt: now,
      expiresAt: new Date(now.getTime() + TRUST_DAYS * 24 * 60 * 60_000),
      browser: browserLabel(userAgent?.slice(0, 500)),
    })
    .returning();
  // Expired ones go, and this account's oldest beyond the limit.
  await clearExpiredTrustedBrowsers(tx, now);
  const keep = await tx
    .select({ id: trustedBrowsers.id })
    .from(trustedBrowsers)
    .where(eq(trustedBrowsers.accountId, accountId))
    .orderBy(desc(trustedBrowsers.createdAt), desc(trustedBrowsers.id))
    .limit(MAX_TRUSTED_PER_ACCOUNT);
  if (keep.length === MAX_TRUSTED_PER_ACCOUNT) {
    await tx.delete(trustedBrowsers).where(
      and(
        eq(trustedBrowsers.accountId, accountId),
        notInArray(
          trustedBrowsers.id,
          keep.map((k) => k.id),
        ),
      ),
    );
  }
  return { token, row };
}

/**
 * The trusted browser this token stands for, if it lets this account skip
 * the authenticator code now: the account's own row, unexpired, made with
 * the account's current authenticator key, and the account active with
 * two-step sign-in set up. Marks it as used.
 */
export async function checkTrustedToken(tx: Tx, acc: TrustAccount, token: string | null, now = new Date()): Promise<TrustedBrowser | null> {
  if (!token || token.length > 128 || !usable(acc)) return null;
  const [row] = await tx
    .select()
    .from(trustedBrowsers)
    .where(and(eq(trustedBrowsers.id, trustIdOf(token)), eq(trustedBrowsers.accountId, acc.id)));
  if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
  if (!safeEqualHex(row.totpTag, totpTagOf(acc.totpSecretEnc))) return null;
  await tx.update(trustedBrowsers).set({ lastUsedAt: now }).where(eq(trustedBrowsers.id, row.id));
  return { ...row, lastUsedAt: now };
}

/** Clear away every trusted browser whose 30 days are over (at each administrator's sign-in), so none is kept longer than needed. */
export async function clearExpiredTrustedBrowsers(tx: Tx, now = new Date()): Promise<void> {
  await tx.delete(trustedBrowsers).where(lte(trustedBrowsers.expiresAt, now));
}

/** The account's trusted browsers that still work, newest first (for the account page). */
export async function listTrustedBrowsers(tx: Tx, acc: TrustAccount, now = new Date()): Promise<TrustedBrowser[]> {
  if (!usable(acc)) return [];
  return tx
    .select()
    .from(trustedBrowsers)
    .where(and(eq(trustedBrowsers.accountId, acc.id), gt(trustedBrowsers.expiresAt, now), eq(trustedBrowsers.totpTag, totpTagOf(acc.totpSecretEnc))))
    .orderBy(desc(trustedBrowsers.createdAt));
}

/**
 * Forget the account's trusted browsers: all of them, or all but one (this
 * browser's, `except`). Returns how many of them were still in date.
 */
export async function forgetTrustedBrowsers(tx: Tx, accountId: string, opts: { except?: string | null; now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const gone = await tx
    .delete(trustedBrowsers)
    .where(opts.except ? and(eq(trustedBrowsers.accountId, accountId), ne(trustedBrowsers.id, opts.except)) : eq(trustedBrowsers.accountId, accountId))
    .returning({ expiresAt: trustedBrowsers.expiresAt });
  return gone.filter((g) => g.expiresAt.getTime() > now.getTime()).length;
}

/** Forget one of the account's own trusted browsers (never another account's). Returns it, or null if it wasn't theirs or is gone. */
export async function forgetTrustedBrowser(tx: Tx, accountId: string, id: string): Promise<TrustedBrowser | null> {
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const [gone] = await tx
    .delete(trustedBrowsers)
    .where(and(eq(trustedBrowsers.id, id), eq(trustedBrowsers.accountId, accountId)))
    .returning();
  return gone ?? null;
}
