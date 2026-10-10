/**
 * This browser's trusted-browser cookie (what a trusted browser is: ./trusted.ts;
 * what the cookie holds: ./trusted-cookie.ts). httpOnly, sent only with the
 * portal's own requests (SameSite=Strict), and kept no longer than the trust.
 */
import "server-only";
import { cookies, headers } from "next/headers";
import { getDb } from "@/lib/db/client";
import { appUrl } from "@/lib/env";
import { checkTrustedToken, clearExpiredTrustedBrowsers, TRUST_DAYS, trustBrowser, trustIdOf, type TrustAccount, type TrustedBrowser } from "./trusted";
import { parseTrustedCookie, trustedTokenFor, withTrustedToken, withoutTrustedToken, type TrustedEntry } from "./trusted-cookie";

const secureCookies = () => appUrl().startsWith("https://");
export const trustedCookieName = () => (secureCookies() ? "__Host-aesri_trusted" : "aesri_trusted");

async function readEntries(): Promise<TrustedEntry[]> {
  return parseTrustedCookie((await cookies()).get(trustedCookieName())?.value);
}

async function writeCookie(value: string | null): Promise<void> {
  const jar = await cookies();
  const options = { httpOnly: true, secure: secureCookies(), sameSite: "strict" as const, path: "/" };
  if (value) jar.set(trustedCookieName(), value, { ...options, maxAge: TRUST_DAYS * 24 * 60 * 60 });
  else jar.set(trustedCookieName(), "", { ...options, maxAge: 0 });
}

/**
 * Signing in with the right password: is this browser trusted for the
 * account, so the authenticator code can be skipped? Returns the trusted
 * browser (marked as used now), or null. An entry that no longer works is
 * taken out of the cookie.
 */
export async function trustedBrowserHere(acc: TrustAccount): Promise<TrustedBrowser | null> {
  const db = await getDb();
  await clearExpiredTrustedBrowsers(db);
  const entries = await readEntries();
  const token = trustedTokenFor(entries, acc.id);
  if (!token) return null;
  const row = await checkTrustedToken(db, acc, token);
  if (!row) await writeCookie(withoutTrustedToken(entries, acc.id));
  return row;
}

/** Right after a right authenticator code with "Trust this browser" ticked: trust it for the account. */
export async function trustThisBrowser(accountId: string): Promise<TrustedBrowser | null> {
  const userAgent = (await headers()).get("user-agent");
  const db = await getDb();
  const made = await db.transaction((tx) => trustBrowser(tx, accountId, userAgent));
  if (!made) return null;
  await writeCookie(withTrustedToken(await readEntries(), accountId, made.token));
  return made.row;
}

/** The id of this browser's trusted-browser row for the account, if its cookie has one (to keep it, or to mark "This browser"). */
export async function thisBrowserTrustId(accountId: string): Promise<string | null> {
  const token = trustedTokenFor(await readEntries(), accountId);
  return token ? trustIdOf(token) : null;
}

/** Take the account's entry out of this browser's cookie (after it was forgotten). */
export async function dropThisBrowserTrust(accountId: string): Promise<void> {
  const entries = await readEntries();
  if (trustedTokenFor(entries, accountId)) await writeCookie(withoutTrustedToken(entries, accountId));
}
