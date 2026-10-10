/**
 * The trusted-browser cookie's contents (lib/auth/trusted-browser.ts reads
 * and writes the cookie itself). Pure functions, so they can be tested on
 * their own.
 *
 * The value holds, for up to five accounts that trusted this browser, a
 * short tag of the account (keyed from APP_SECRET, so the cookie says
 * nothing readable about who) and the random token whose SHA-256 is that
 * account's trusted_browsers row: "v1.<tag>-<token>.<tag>-<token>…". A token
 * proves nothing on its own: the row must exist, belong to that account, be
 * unexpired and match the account's current authenticator key (./trusted.ts).
 */
import { trustMac } from "./crypto";

export const MAX_TRUSTED_ACCOUNTS = 5;

export type TrustedEntry = { tag: string; token: string };

/** 32 random bytes as base64url (newSessionToken in ./crypto.ts). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ENTRY = /^([0-9a-f]{16})-([A-Za-z0-9_-]{43})$/;

export const trustTagOf = (accountId: string) => trustMac(`tag|${accountId}`).slice(0, 16);

const serialize = (entries: TrustedEntry[]) => ["v1", ...entries.map((e) => `${e.tag}-${e.token}`)].join(".");

/** Read the cookie; anything malformed is left out (a malformed value counts as no cookie). */
export function parseTrustedCookie(value: string | undefined): TrustedEntry[] {
  if (!value || value.length > 600) return [];
  const [version, ...rest] = value.split(".");
  if (version !== "v1") return [];
  const entries: TrustedEntry[] = [];
  for (const part of rest.slice(0, MAX_TRUSTED_ACCOUNTS)) {
    const m = ENTRY.exec(part);
    if (m && !entries.some((e) => e.tag === m[1])) entries.push({ tag: m[1], token: m[2] });
  }
  return entries;
}

/** This account's token in the cookie, if it has one. */
export function trustedTokenFor(entries: TrustedEntry[], accountId: string): string | null {
  const tag = trustTagOf(accountId);
  return entries.find((e) => e.tag === tag)?.token ?? null;
}

/** The cookie's value with this account's new token first (in place of its old one); beyond five accounts the oldest entry goes. */
export function withTrustedToken(entries: TrustedEntry[], accountId: string, token: string): string {
  if (!TOKEN.test(token)) throw new Error("Not a trusted-browser token");
  const tag = trustTagOf(accountId);
  const others = entries.filter((e) => e.tag !== tag).slice(0, MAX_TRUSTED_ACCOUNTS - 1);
  return serialize([{ tag, token }, ...others]);
}

/** The cookie's value without this account's entry; null when nothing is left (delete the cookie). */
export function withoutTrustedToken(entries: TrustedEntry[], accountId: string): string | null {
  const tag = trustTagOf(accountId);
  const rest = entries.filter((e) => e.tag !== tag);
  return rest.length ? serialize(rest) : null;
}
