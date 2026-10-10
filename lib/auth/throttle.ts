/**
 * Limits on wrong tries: sign-in, activation with a slip, two-step sign-in
 * and changing one's password. Each try is counted BEFORE it is checked, by
 * one atomic statement per counter that refuses once the limit is reached,
 * so parallel requests can't slip past a limit. Each counter has a fixed
 * window from its first counted try (15 minutes unless said otherwise).
 *
 *   Sign-in and activation with a slip (they share counters):
 *     one login ID from one address ..................   5
 *     one login ID from all addresses ................  20
 *     one login ID from all addresses, in 24 hours ... 100  (the daily cap,
 *       sign-in only). After it, one try every 10 minutes for this login ID
 *       from all addresses together, until the day is over: someone guessing
 *       gets few more tries, and the real person on a new phone isn't shut
 *       out for the whole day. Activation doesn't count towards the cap (it
 *       needs a slip code nobody can guess), but the 15-minute limits above
 *       apply to it too.
 *   Sign-in on a known device (one that has signed in to this account before,
 *     see lib/auth/device.ts), per device and login ID   10, and 30 in 24 hours
 *     — instead of all of the above, so someone guessing elsewhere can't lock
 *     the family out of their own phone
 *   Two-step sign-in (authenticator codes), per account .   5
 *     wrong codes in a row, per account ................  20  until an
 *     administrator unlocks it (it never runs out by itself)
 *   Changing one's password (current password), per account 5
 *   Any of these from one address (not known devices) ..  30
 *
 * "Address" is the visitor's IP (IPv6: its /64 network, see ipBucket). A
 * login ID counts the same whether or not it exists, so the answers don't
 * reveal which IDs are real. A try that succeeds clears the login ID's
 * counters (except the daily caps, so the real person signing in never gives
 * someone guessing a fresh day) and doesn't count against the address or the
 * daily caps. A right authenticator code clears the codes-in-a-row count. Printing a new
 * slip, or "Unlock" (Slips & sign-in; School administrators for AESRI
 * administrators), clears all of a login ID's counters.
 *
 * No "server-only" here: lib/services/accounts.ts (also used by scripts)
 * clears counters when it issues a slip.
 */
import crypto from "node:crypto";
import { and, eq, gt, gte, inArray, like, lt, notLike, or, sql, type SQL } from "drizzle-orm";
import { throttles } from "@/lib/db/schema";
import type { Tx } from "@/lib/db/client";
import { ipBucket } from "./client-ip";

export const WINDOW_MINUTES = 15;
export const DAY_MINUTES = 24 * 60;
/** After the daily cap: one try per this many minutes (LIMITS.signinAfterCap). */
export const AFTER_CAP_MINUTES = 10;

export const LIMITS = {
  signinPerAddress: 5,
  signinPerId: 20,
  signinPerDay: 100,
  signinAfterCap: 1,
  signinPerDevice: 10,
  signinPerDeviceDay: 30,
  twoFactor: 5,
  twoFactorInARow: 20,
  password: 5,
  perAddress: 30,
} as const;

export type Purpose = "signin" | "activate" | "2fa" | "password";

/** A login ID as it goes into a key: URL-encoded (so "|" can separate parts), long input hashed. */
function idPart(loginId: string): string {
  return loginId.length <= 80 ? encodeURIComponent(loginId) : `sha256-${crypto.createHash("sha256").update(loginId).digest("hex").slice(0, 32)}`;
}

const K = {
  signinId: (id: string) => `signin:id:${idPart(id)}`,
  signinDay: (id: string) => `signin:day:${idPart(id)}`,
  signinAfterCap: (id: string) => `signin:aftercap:${idPart(id)}`,
  signinPairPrefix: (id: string) => `signin:pair:${idPart(id)}|`,
  signinPair: (id: string, bucket: string) => `signin:pair:${idPart(id)}|${bucket}`,
  signinDevicePrefix: (id: string) => `signin:device:${idPart(id)}|`,
  signinDevice: (id: string, device: string) => `signin:device:${idPart(id)}|${device}`,
  signinDeviceDayPrefix: (id: string) => `signin:devday:${idPart(id)}|`,
  signinDeviceDay: (id: string, device: string) => `signin:devday:${idPart(id)}|${device}`,
  twoFactor: (id: string) => `2fa:id:${idPart(id)}`,
  twoFactorInARow: (id: string) => `2fa:row:${idPart(id)}`,
  password: (id: string) => `password:id:${idPart(id)}`,
  address: (bucket: string) => `ip:${bucket}`,
};

/** A counter's window in minutes; null: it never runs out (only a right code, a new slip or "Unlock" clears it). */
function windowOf(key: string): number | null {
  if (key.startsWith("signin:day:") || key.startsWith("signin:devday:")) return DAY_MINUTES;
  if (key.startsWith("signin:aftercap:")) return AFTER_CAP_MINUTES;
  if (key.startsWith("2fa:row:")) return null;
  return WINDOW_MINUTES;
}

/** Daily counters: a right try is given back, but never clears them. */
const isDaily = (key: string) => key.startsWith("signin:day:") || key.startsWith("signin:devday:");

function limitOf(key: string): number {
  if (key.startsWith("signin:id:")) return LIMITS.signinPerId;
  if (key.startsWith("signin:day:")) return LIMITS.signinPerDay;
  if (key.startsWith("signin:aftercap:")) return LIMITS.signinAfterCap;
  if (key.startsWith("signin:pair:")) return LIMITS.signinPerAddress;
  if (key.startsWith("signin:device:")) return LIMITS.signinPerDevice;
  if (key.startsWith("signin:devday:")) return LIMITS.signinPerDeviceDay;
  if (key.startsWith("2fa:id:")) return LIMITS.twoFactor;
  if (key.startsWith("2fa:row:")) return LIMITS.twoFactorInARow;
  if (key.startsWith("password:id:")) return LIMITS.password;
  return LIMITS.perAddress;
}

const interval = (minutes: number) => sql.raw(`interval '${minutes} minutes'`);
/** Window starts are kept to the millisecond, so a JavaScript Date can name the window exactly. */
const NOW_MS = sql`date_trunc('milliseconds', now())`;

type Taken = { key: string; windowStart: Date; count: number };

/** Why tries are refused: */
export type Blocked =
  /** this login ID, from this address or from everywhere, for up to 15 minutes */
  | "account"
  /** everything from this address, for up to 15 minutes */
  | "address"
  /**
   * the daily cap: this login ID from devices that haven't signed in to it
   * before gets one try every 10 minutes until the day is over (or an
   * unlock); `until` is when the next of those tries is free
   */
  | "day"
  /** two-step sign-in: too many wrong codes in a row, until an administrator unlocks it */
  | "codes";

export type Attempt =
  | {
      ok: true;
      purpose: Purpose;
      loginId: string;
      taken: Taken[];
      /** Locks that start if this try turns out wrong (the try filled the counter): "id" 20 from everywhere, "day", "codes". */
      locksIfWrong: ("id" | "day" | "codes")[];
    }
  | {
      ok: false;
      blocked: Blocked;
      /** When the window that reached its limit ends; null: not until it is unlocked. */
      until: Date | null;
    };

/**
 * Count one more try on a counter, unless it has reached `limit` in the
 * current window. One statement: the row is locked while it is checked and
 * changed, so two requests can never both take the last try. Returns the
 * window's start and the count after this try, or null when the limit is
 * reached (nothing counted).
 */
async function take(tx: Tx, key: string, limit: number): Promise<{ windowStart: Date; count: number } | null> {
  const minutes = windowOf(key);
  const expired = minutes === null ? sql`false` : sql`${throttles.windowStart} <= now() - ${interval(minutes)}`;
  const rows = await tx
    .insert(throttles)
    .values({ key, count: 1, windowStart: NOW_MS })
    .onConflictDoUpdate({
      target: throttles.key,
      set: {
        count: sql`case when ${expired} then 1 else ${throttles.count} + 1 end`,
        windowStart: sql`case when ${expired} then ${NOW_MS} else ${throttles.windowStart} end`,
      },
      setWhere: sql`${expired} or ${throttles.count} < ${limit}`,
    })
    .returning({ windowStart: throttles.windowStart, count: throttles.count });
  return rows[0] ?? null;
}

/** Un-count tries taken earlier (only in the same window). */
async function giveBack(tx: Tx, taken: Taken[]): Promise<void> {
  for (const t of taken) {
    await tx
      .update(throttles)
      .set({ count: sql`${throttles.count} - 1` })
      .where(and(eq(throttles.key, t.key), eq(throttles.windowStart, t.windowStart), gt(throttles.count, 0)));
  }
}

async function windowEnd(tx: Tx, key: string): Promise<Date | null> {
  const minutes = windowOf(key);
  if (minutes === null) return null;
  const [row] = await tx.select({ windowStart: throttles.windowStart }).from(throttles).where(eq(throttles.key, key));
  return new Date((row?.windowStart.getTime() ?? Date.now()) + minutes * 60_000);
}

/** Counters whose window has ended (they no longer count). Codes-in-a-row counters never end by themselves. */
function expiredRows(): SQL {
  const daily = or(like(throttles.key, "signin:day:%"), like(throttles.key, "signin:devday:%"))!;
  return or(
    and(daily, lt(throttles.windowStart, sql`now() - ${interval(DAY_MINUTES)}`)),
    and(notLike(throttles.key, "signin:day:%"), notLike(throttles.key, "signin:devday:%"), notLike(throttles.key, "2fa:row:%"), lt(throttles.windowStart, sql`now() - ${interval(WINDOW_MINUTES)}`)),
  )!;
}

/** Now and then, forget counters whose window has ended. */
async function sweep(tx: Tx): Promise<void> {
  if (Math.random() >= 0.02) return;
  await tx.delete(throttles).where(expiredRows());
}

/** One counter a try must get past; `orElse`: the counter tried instead once this one is full (after the daily cap). */
type Step = { key: string; limit: number; scope: Blocked; lock?: "id" | "day" | "codes"; orElse?: Step };

/**
 * Count a try before checking it. `loginId` is the normalised login ID
 * (typed at sign-in and activation; the signed-in account's otherwise),
 * `ip` the visitor's address. `knownDevice` (sign-in only) is the id of a
 * device that has signed in to this account before (lib/auth/device.ts):
 * its tries count on their own counters instead of the login ID's and the
 * address's. When a limit has been reached nothing is counted and the
 * answer says which limit and until when.
 */
export async function beginAttempt(tx: Tx, purpose: Purpose, loginId: string, ip: string, opts: { knownDevice?: string | null } = {}): Promise<Attempt> {
  const bucket = ipBucket(ip);
  const device = purpose === "signin" && opts.knownDevice && /^[A-Za-z0-9_-]{16,64}$/.test(opts.knownDevice) ? opts.knownDevice : null;
  const shared: Step[] = [
    { key: K.signinPair(loginId, bucket), limit: LIMITS.signinPerAddress, scope: "account" },
    { key: K.address(bucket), limit: LIMITS.perAddress, scope: "address" },
    { key: K.signinId(loginId), limit: LIMITS.signinPerId, scope: "account", lock: "id" },
  ];
  const plan: Step[] =
    purpose === "signin"
      ? device
        ? [
            { key: K.signinDevice(loginId, device), limit: LIMITS.signinPerDevice, scope: "account" },
            { key: K.signinDeviceDay(loginId, device), limit: LIMITS.signinPerDeviceDay, scope: "account" },
          ]
        : [
            ...shared,
            {
              key: K.signinDay(loginId),
              limit: LIMITS.signinPerDay,
              scope: "day",
              lock: "day",
              // Past the cap: one try every 10 minutes (no lock of its own to log each time).
              orElse: { key: K.signinAfterCap(loginId), limit: LIMITS.signinAfterCap, scope: "day" },
            },
          ]
      : purpose === "activate"
        ? shared
        : purpose === "2fa"
        ? [
            { key: K.twoFactorInARow(loginId), limit: LIMITS.twoFactorInARow, scope: "codes", lock: "codes" },
            { key: K.twoFactor(loginId), limit: LIMITS.twoFactor, scope: "account" },
            { key: K.address(bucket), limit: LIMITS.perAddress, scope: "address" },
          ]
        : [
            { key: K.password(loginId), limit: LIMITS.password, scope: "account" },
            { key: K.address(bucket), limit: LIMITS.perAddress, scope: "address" },
          ];
  const taken: Taken[] = [];
  const locksIfWrong: ("id" | "day" | "codes")[] = [];
  for (const first of plan) {
    let step = first;
    let got = await take(tx, step.key, step.limit);
    if (!got && step.orElse) {
      step = step.orElse;
      got = await take(tx, step.key, step.limit);
    }
    if (!got) {
      // A wider limit refused: the narrower counters shouldn't keep a try that was never checked.
      await giveBack(tx, taken);
      return { ok: false, blocked: step.scope, until: await windowEnd(tx, step.key) };
    }
    taken.push({ key: step.key, ...got });
    if (step.lock && got.count >= step.limit) locksIfWrong.push(step.lock);
  }
  await sweep(tx);
  return { ok: true, purpose, loginId, taken, locksIfWrong };
}

/**
 * The try was right: clear the login ID's counters for this purpose (not the
 * daily caps); the address and the daily caps keep only the wrong tries.
 */
export async function attemptSucceeded(tx: Tx, a: Extract<Attempt, { ok: true }>): Promise<void> {
  const own = a.taken.filter((t) => !t.key.startsWith("ip:") && !isDaily(t.key));
  const extra = a.purpose === "signin" || a.purpose === "activate" ? [K.signinId(a.loginId)] : a.purpose === "2fa" ? [K.twoFactorInARow(a.loginId)] : [];
  await tx.delete(throttles).where(inArray(throttles.key, [...new Set([...own.map((t) => t.key), ...extra])]));
  await giveBack(
    tx,
    a.taken.filter((t) => t.key.startsWith("ip:") || isDaily(t.key)),
  );
}

/** The try wasn't a guess after all (the code was right, but the new password was refused): un-count it. */
export async function attemptNotCounted(tx: Tx, a: Extract<Attempt, { ok: true }>): Promise<void> {
  await giveBack(tx, a.taken);
}

/** When a lock ends, as people read it: "10:45 pm", or "रात 10:45" in Hindi (India time). */
export function clockTime(d: Date, lang: "en" | "hi" = "en"): string {
  return lang === "hi"
    ? new Intl.DateTimeFormat("hi-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", dayPeriod: "short" }).format(d)
    : new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
}

/** A lock's end more than a few hours away, with its day: "2 Oct, 10:45 pm" ("2 अक्टू॰, रात 10:45"). */
export function dayAndTime(d: Date, lang: "en" | "hi" = "en"): string {
  const day = new Intl.DateTimeFormat(lang === "hi" ? "hi-IN" : "en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }).format(d);
  return `${day}, ${clockTime(d, lang)}`;
}

/**
 * Clear every counter of a login ID (normalised form): sign-in and
 * activation from every address and known device, the daily cap, two-step
 * sign-in (codes in a row too) and password changes. Used when a new slip is
 * printed and by "Unlock". Returns how many counters were at their limit
 * (0 = it wasn't locked).
 */
export async function clearLoginId(tx: Tx, loginId: string): Promise<number> {
  const removed = await tx
    .delete(throttles)
    .where(
      or(
        inArray(throttles.key, [K.signinId(loginId), K.signinDay(loginId), K.signinAfterCap(loginId), K.twoFactor(loginId), K.twoFactorInARow(loginId), K.password(loginId)]),
        sql`starts_with(${throttles.key}, ${K.signinPairPrefix(loginId)})`,
        sql`starts_with(${throttles.key}, ${K.signinDevicePrefix(loginId)})`,
        sql`starts_with(${throttles.key}, ${K.signinDeviceDayPrefix(loginId)})`,
      ),
    )
    .returning({ key: throttles.key, count: throttles.count, windowStart: throttles.windowStart });
  return removed.filter((r) => stillCounts(r) && r.count >= limitOf(r.key)).length;
}

/** Is this counter's window still running? */
function stillCounts(r: { key: string; windowStart: Date }, now = Date.now()): boolean {
  const minutes = windowOf(r.key);
  return minutes === null || r.windowStart.getTime() > now - minutes * 60_000;
}

/**
 * Why a login ID can't sign in right now: "tries" (15 minutes: too many wrong
 * tries for this ID from everywhere or from one address, or wrong codes),
 * "day" (the daily cap: devices that have signed in before still can; others
 * get one try every 10 minutes; `until` is when the day is over), "codes"
 * (too many wrong codes in a row: until unlocked).
 */
export type SignInLock = { reason: "tries" | "day" | "codes"; until: Date | null };

const STRENGTH: Record<SignInLock["reason"], number> = { tries: 1, day: 2, codes: 3 };

/**
 * Which of these login IDs (normalised) can't sign in right now because a
 * limit was reached, why and until when (the strongest lock of each).
 * Password-change limits don't stop anyone signing in, and a known device's
 * own counter only stops that device, so neither is shown.
 */
export async function lockedLoginIds(tx: Tx, loginIds: string[]): Promise<Map<string, SignInLock>> {
  const out = new Map<string, SignInLock>();
  if (!loginIds.length) return out;
  const wanted = new Map(loginIds.map((id) => [idPart(id), id]));
  const rows = await tx
    .select({ key: throttles.key, count: throttles.count, windowStart: throttles.windowStart })
    .from(throttles)
    .where(
      or(
        and(
          or(like(throttles.key, "signin:id:%"), like(throttles.key, "signin:pair:%"), like(throttles.key, "2fa:id:%")),
          gt(throttles.windowStart, sql`now() - ${interval(WINDOW_MINUTES)}`),
          gte(throttles.count, Math.min(LIMITS.signinPerAddress, LIMITS.twoFactor)),
        ),
        and(like(throttles.key, "signin:day:%"), gt(throttles.windowStart, sql`now() - ${interval(DAY_MINUTES)}`), gte(throttles.count, LIMITS.signinPerDay)),
        and(like(throttles.key, "2fa:row:%"), gte(throttles.count, LIMITS.twoFactorInARow)),
      ),
    );
  for (const r of rows) {
    const m = /^(?:signin:id:|signin:day:|2fa:id:|2fa:row:)(.+)$/.exec(r.key) ?? /^signin:pair:([^|]+)\|/.exec(r.key);
    if (!m || r.count < limitOf(r.key)) continue;
    const loginId = wanted.get(m[1]);
    if (!loginId) continue;
    const minutes = windowOf(r.key);
    const lock: SignInLock = {
      reason: r.key.startsWith("2fa:row:") ? "codes" : r.key.startsWith("signin:day:") ? "day" : "tries",
      until: minutes === null ? null : new Date(r.windowStart.getTime() + minutes * 60_000),
    };
    const prev = out.get(loginId);
    if (!prev || STRENGTH[lock.reason] > STRENGTH[prev.reason] || (lock.reason === prev.reason && (lock.until?.getTime() ?? Infinity) > (prev.until?.getTime() ?? Infinity))) {
      out.set(loginId, lock);
    }
  }
  return out;
}
