/**
 * Database-backed sessions. The browser holds a random token in an
 * httpOnly cookie; the database holds only its SHA-256. Sessions expire
 * after a period of inactivity and have a hard maximum length, shorter for
 * accounts with more power.
 */
import "server-only";
import { cookies, headers } from "next/headers";
import { and, eq, ne } from "drizzle-orm";
import { getDb, type Tx } from "@/lib/db/client";
import { accounts, authSessions } from "@/lib/db/schema";
import { appUrl } from "@/lib/env";
import { clientIpFrom } from "./client-ip";
import { newSessionToken, sessionIdFromToken } from "./crypto";

import type { Role } from "@/lib/roles";

export type { Role };

const LIFETIME: Record<Role, { idleMin: number; maxMin: number }> = {
  student: { idleMin: 14 * 24 * 60, maxMin: 60 * 24 * 60 }, // parents mostly use their own phone
  teacher: { idleMin: 12 * 60, maxMin: 7 * 24 * 60 },
  school_admin: { idleMin: 2 * 60, maxMin: 12 * 60 },
  accounts: { idleMin: 2 * 60, maxMin: 12 * 60 },
  super_admin: { idleMin: 2 * 60, maxMin: 12 * 60 },
};

const secureCookies = () => appUrl().startsWith("https://");
export const sessionCookieName = () => (secureCookies() ? "__Host-aesri_session" : "aesri_session");

/** The visitor's address (see TRUSTED_PROXY_HOPS in lib/env.ts). */
export async function clientIp(): Promise<string> {
  return clientIpFrom(await headers());
}

/** Store a new session for this browser and return its token (the cookie is set separately). */
async function insertSession(tx: Tx, accountId: string, role: Role, mfaPassed: boolean): Promise<string> {
  const token = newSessionToken();
  const life = LIFETIME[role];
  const h = await headers();
  await tx.insert(authSessions).values({
    id: sessionIdFromToken(token),
    accountId,
    mfaPassed,
    expiresAt: new Date(Date.now() + Math.min(life.idleMin, life.maxMin) * 60_000),
    ip: clientIpFrom(h),
    userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
  });
  return token;
}

/** Give the browser its session token. Call once the session row is saved (after the transaction commits). */
export async function setSessionCookie(token: string, role: Role): Promise<void> {
  const jar = await cookies();
  jar.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: LIFETIME[role].maxMin * 60,
  });
}

export async function startSession(accountId: string, role: Role, mfaPassed: boolean): Promise<void> {
  const db = await getDb();
  // A browser signs in as one person at a time: end the session it already had
  // (on a family's shared phone, the previous person's stays valid otherwise).
  const previous = (await cookies()).get(sessionCookieName())?.value;
  if (previous) await db.delete(authSessions).where(eq(authSessions.id, sessionIdFromToken(previous)));
  const token = await insertSession(db, accountId, role, mfaPassed);
  await setSessionCookie(token, role);
}

/**
 * After a password change: end every session of the account — this one
 * too — and start a new one for this browser with the same two-factor
 * state, so a token copied before the change stops working. Call inside the
 * transaction that changes the password, then setSessionCookie(token)
 * after it commits.
 */
export async function replaceAllSessions(tx: Tx, accountId: string, role: Role, mfaPassed: boolean): Promise<string> {
  await tx.delete(authSessions).where(eq(authSessions.accountId, accountId));
  return insertSession(tx, accountId, role, mfaPassed);
}

export type SessionRecord = {
  session: typeof authSessions.$inferSelect;
  account: typeof accounts.$inferSelect;
};

/**
 * This browser's session, if it is still valid. Reading it counts as
 * activity (the idle timeout slides forward) unless `touch` is false — for
 * requests the page makes by itself, such as the menu's counts, which must
 * never keep an unattended session signed in.
 */
export async function readSession({ touch = true }: { touch?: boolean } = {}): Promise<SessionRecord | null> {
  const jar = await cookies();
  const token = jar.get(sessionCookieName())?.value;
  if (!token || token.length > 128) return null;
  const id = sessionIdFromToken(token);
  const db = await getDb();
  const [row] = await db
    .select({ session: authSessions, account: accounts })
    .from(authSessions)
    .innerJoin(accounts, eq(accounts.id, authSessions.accountId))
    .where(eq(authSessions.id, id));
  if (!row) return null;
  const now = Date.now();
  if (row.session.expiresAt.getTime() <= now || row.account.status !== "active") return null;

  // Slide the idle timeout forward (at most every 5 minutes), never past the hard maximum.
  if (touch && now - row.session.lastSeenAt.getTime() > 5 * 60_000) {
    const life = LIFETIME[row.account.role];
    const hardEnd = row.session.createdAt.getTime() + life.maxMin * 60_000;
    await db
      .update(authSessions)
      .set({ lastSeenAt: new Date(now), expiresAt: new Date(Math.min(hardEnd, now + life.idleMin * 60_000)) })
      .where(eq(authSessions.id, id));
  }
  return row;
}

/**
 * Two-step sign-in is done: this browser's session is swapped for a new one
 * (new token) that has passed it. Other devices are left alone. Returns
 * false when the session had already ended (signed out meanwhile).
 */
export async function markMfaPassed(sessionId: string, accountId: string, role: Role): Promise<boolean> {
  const db = await getDb();
  const token = await db.transaction(async (tx) => {
    const ended = await tx
      .delete(authSessions)
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.accountId, accountId)))
      .returning({ id: authSessions.id });
    if (!ended.length) return null;
    return insertSession(tx, accountId, role, true);
  });
  if (!token) return false;
  await setSessionCookie(token, role);
  return true;
}

/** Sign out this browser. */
export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(sessionCookieName())?.value;
  if (token) {
    const db = await getDb();
    await db.delete(authSessions).where(eq(authSessions.id, sessionIdFromToken(token)));
  }
  jar.set(sessionCookieName(), "", { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", maxAge: 0 });
}

/** Sign an account out everywhere (after a password reset or when access is withdrawn). */
export async function endAllSessions(tx: Tx, accountId: string, exceptSessionId?: string): Promise<void> {
  await tx
    .delete(authSessions)
    .where(exceptSessionId ? and(eq(authSessions.accountId, accountId), ne(authSessions.id, exceptSessionId)) : eq(authSessions.accountId, accountId));
}
