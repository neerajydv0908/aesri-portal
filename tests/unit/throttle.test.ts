/**
 * lib/auth/throttle.ts against a real (in-memory) PostgreSQL: tries are
 * counted before they are checked, so parallel requests can't get past a
 * limit, and the per-address / per-login-ID limits, the daily cap, known
 * devices and the authenticator codes-in-a-row lock work as documented.
 * Also the known-device cookie's contents (lib/auth/device-cookie.ts).
 *
 *   node --import tsx --test tests/unit/throttle.test.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Tx } from "../../lib/db/client";
import * as schema from "../../lib/db/schema";
import { attemptNotCounted, attemptSucceeded, beginAttempt, clearLoginId, LIMITS, lockedLoginIds, type Attempt } from "../../lib/auth/throttle";

// The known-device cookie is keyed from APP_SECRET: a fixed test value (never the working copy's own secret file).
process.env.APP_SECRET = "unit-test-secret-unit-test-secret-unit-test-secret";

let db: Tx;

before(async () => {
  const client = await PGlite.create();
  const d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  db = d as unknown as Tx;
});

const okCount = (xs: Attempt[]) => xs.filter((a) => a.ok).length;

test("30 parallel tries for one login ID from one address: exactly 5 are let through", async () => {
  const results = await Promise.all(Array.from({ length: 30 }, () => beginAttempt(db, "signin", "arya7001", "203.0.113.1")));
  assert.equal(okCount(results), LIMITS.signinPerAddress);
  const refused = results.find((a) => !a.ok);
  assert.ok(refused && !refused.ok && refused.blocked === "account");
  assert.ok(refused && !refused.ok && refused.until && refused.until.getTime() > Date.now() + 14 * 60_000);
  // The refused tries weren't counted anywhere else: the address has used 5 of its 30.
  const others = await Promise.all(Array.from({ length: 30 }, (_, i) => beginAttempt(db, "signin", `arya71${i}`, "203.0.113.1")));
  assert.equal(okCount(others), LIMITS.perAddress - LIMITS.signinPerAddress);
});

test("one login ID from many addresses: 5 each, 20 in all — and a blocked address can't use up the ID's tries", async () => {
  const id = "aryae1";
  const perAddress = await Promise.all(
    Array.from({ length: 6 }, async (_, a) => Promise.all(Array.from({ length: 8 }, () => beginAttempt(db, "signin", id, `198.51.100.${a}`)))),
  );
  const let_ = perAddress.map(okCount);
  assert.ok(let_.every((n) => n <= LIMITS.signinPerAddress));
  assert.equal(let_.reduce((a, b) => a + b, 0), LIMITS.signinPerId);
  const last = await beginAttempt(db, "signin", id, "198.51.100.200");
  assert.ok(!last.ok && last.blocked === "account");
  // The real user, from yet another address, is locked out too — until the office unlocks it.
  const locks = await lockedLoginIds(db, [id, "aryae2"]);
  assert.ok(locks.has(id) && !locks.has("aryae2"));
  assert.ok((await clearLoginId(db, id)) >= 1);
  assert.equal((await lockedLoginIds(db, [id])).size, 0);
  assert.ok((await beginAttempt(db, "signin", id, "198.51.100.200")).ok);
});

test("an address is limited to 30 tries in all, whatever the login IDs", async () => {
  const results: Attempt[] = [];
  for (let i = 0; i < 35; i++) results.push(await beginAttempt(db, "signin", `aadhar${9000 + i}`, "192.0.2.77"));
  assert.equal(okCount(results), LIMITS.perAddress);
  const r = results[results.length - 1];
  assert.ok(!r.ok && r.blocked === "address");
  // …and those refused tries didn't count against the login IDs.
  assert.ok((await beginAttempt(db, "signin", "aadhar9034", "192.0.2.78")).ok);
});

test("IPv6 addresses in the same /64 share a counter", async () => {
  const a = await Promise.all(Array.from({ length: 4 }, (_, i) => beginAttempt(db, "signin", "arya7500", `2401:4900:1c2a:5f1e::${i + 1}`)));
  const b = await Promise.all(Array.from({ length: 4 }, (_, i) => beginAttempt(db, "signin", "arya7500", `2401:4900:1c2a:5f1e:ffff::${i + 1}`)));
  assert.equal(okCount(a) + okCount(b), LIMITS.signinPerAddress);
});

test("a right password clears the login ID's counters and doesn't count against the address", async () => {
  for (let i = 0; i < 4; i++) assert.ok((await beginAttempt(db, "signin", "arya7600", "203.0.113.50")).ok);
  const good = await beginAttempt(db, "signin", "arya7600", "203.0.113.50");
  assert.ok(good.ok);
  await attemptSucceeded(db, good);
  const [pair] = await db.execute(sql`select count from throttles where key like 'signin:pair:arya7600|%'`).then((r) => (r as unknown as { rows: { count: number }[] }).rows);
  assert.equal(pair, undefined);
  const [addr] = await db.execute(sql`select count from throttles where key = 'ip:203.0.113.50'`).then((r) => (r as unknown as { rows: { count: number }[] }).rows);
  assert.equal(addr.count, 4);
  // A try that wasn't a guess (right code, weak new password) is taken back.
  const notAGuess = await beginAttempt(db, "signin", "arya7601", "203.0.113.50");
  assert.ok(notAGuess.ok);
  await attemptNotCounted(db, notAGuess);
  const [after] = await db.execute(sql`select count from throttles where key = 'ip:203.0.113.50'`).then((r) => (r as unknown as { rows: { count: number }[] }).rows);
  assert.equal(after.count, 4);
});

test("authenticator codes: 5 per account from anywhere; a new window starts after 15 minutes", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => beginAttempt(db, "2fa", "aesri.demo", `203.0.113.${100 + i}`)));
  assert.equal(okCount(results), LIMITS.twoFactor);
  assert.ok((await lockedLoginIds(db, ["aesri.demo"])).has("aesri.demo"));
  await db.execute(sql`update throttles set window_start = window_start - interval '16 minutes' where key = '2fa:id:aesri.demo'`);
  assert.equal((await lockedLoginIds(db, ["aesri.demo"])).size, 0);
  assert.ok((await beginAttempt(db, "2fa", "aesri.demo", "203.0.113.120")).ok);
});

test("password changes: 5 per account; not shown as a sign-in lock", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => beginAttempt(db, "password", "arya7700", "203.0.113.200")));
  assert.equal(okCount(results), LIMITS.password);
  assert.equal((await lockedLoginIds(db, ["arya7700"])).size, 0);
});

test("very long or odd login IDs are counted safely", async () => {
  const long = "x".repeat(5000);
  assert.ok((await beginAttempt(db, "signin", long, "203.0.113.201")).ok);
  assert.ok((await beginAttempt(db, "signin", "a|b%_", "203.0.113.201")).ok);
  assert.equal(await clearLoginId(db, "a"), 0);
});

/** Move every 15-minute window of these keys back past its end (as if 16 minutes had passed). */
async function after15Minutes(keyLike: string[]) {
  for (const k of keyLike) await db.execute(sql`update throttles set window_start = window_start - interval '16 minutes' where key like ${k} and key not like 'signin:day:%' and key not like '2fa:row:%'`);
}

test("the daily cap: 100 wrong tries for one login ID in 24 hours, then one try every 10 minutes (known devices as usual)", async () => {
  const id = "arya7800";
  let counted = 0;
  let lockedAt: Attempt | null = null;
  for (let round = 0; counted < LIMITS.signinPerDay && round < 20; round++) {
    // 20 an hour-quarter from five addresses (four tries each): the 15-minute limits never bite.
    for (let a = 0; a < 5; a++) {
      for (let i = 0; i < 4 && counted < LIMITS.signinPerDay; i++) {
        const r = await beginAttempt(db, "signin", id, `198.18.${round}.${a}`);
        assert.ok(r.ok, `try ${counted + 1}`);
        counted++;
        if (r.ok && r.locksIfWrong.includes("day")) lockedAt = r;
      }
    }
    await after15Minutes(["signin:%", "ip:%"]);
  }
  assert.equal(counted, LIMITS.signinPerDay);
  assert.ok(lockedAt, "the 100th try says the daily lock starts if it is wrong");
  // Past the cap, a new device still gets one try every 10 minutes (for this login ID, from all addresses together).
  const late = await beginAttempt(db, "signin", id, "198.18.99.1");
  assert.ok(late.ok, "one try after the cap");
  assert.ok(late.taken.some((t) => t.key.startsWith("signin:aftercap:")) && !late.taken.some((t) => t.key.startsWith("signin:day:")));
  assert.deepEqual(late.locksIfWrong, [], "the daily lock was logged once, by the 100th try");
  const refused = await beginAttempt(db, "signin", id, "198.18.99.4");
  assert.ok(!refused.ok && refused.blocked === "day");
  assert.ok(!refused.ok && refused.until && refused.until.getTime() > Date.now() + 9 * 60_000 && refused.until.getTime() <= Date.now() + 10 * 60_000, "next free try within 10 minutes");
  // The refused try wasn't counted against the 15-minute counters either.
  const [perId] = await db.execute(sql`select count from throttles where key = 'signin:id:arya7800'`).then((r) => (r as unknown as { rows: { count: number }[] }).rows);
  assert.equal(perId.count, 1);
  // Ten minutes later: one more, then wait again.
  await db.execute(sql`update throttles set window_start = window_start - interval '11 minutes' where key = 'signin:aftercap:arya7800'`);
  const again = await beginAttempt(db, "signin", id, "198.18.99.5");
  assert.ok(again.ok);
  assert.ok(!(await beginAttempt(db, "signin", id, "198.18.99.6")).ok);
  // A right password on such a try frees the next one at once; the daily count stays.
  await attemptSucceeded(db, again);
  assert.ok((await beginAttempt(db, "signin", id, "198.18.99.7")).ok);
  assert.ok(!(await beginAttempt(db, "signin", id, "198.18.99.8")).ok);
  // The office sees the daily lock until the day is over.
  const lock = (await lockedLoginIds(db, [id])).get(id);
  assert.equal(lock?.reason, "day");
  assert.ok(lock?.until && lock.until.getTime() > Date.now() + 23 * 60 * 60_000);
  // A device that signed in to this account before still gets its own tries: 10 per 15 minutes.
  const device = "known-device-0001-abcdefg";
  const own = await Promise.all(Array.from({ length: 14 }, () => beginAttempt(db, "signin", id, "198.18.99.2", { knownDevice: device })));
  assert.equal(okCount(own), LIMITS.signinPerDevice);
  assert.ok(own.some((r) => !r.ok && r.blocked === "account"));
  // …another known device is not affected by the first one's tries.
  assert.ok((await beginAttempt(db, "signin", id, "198.18.99.3", { knownDevice: "known-device-0002-abcdefg" })).ok);
  // Activating with a slip doesn't use the daily cap (only the 15-minute counters).
  const activation = await beginAttempt(db, "activate", id, "198.18.99.9");
  assert.ok(activation.ok && !activation.taken.some((t) => /^signin:(day|aftercap):/.test(t.key)));
  // A right password on a known device clears its counters, but not the daily cap.
  const good = await beginAttempt(db, "signin", id, "198.18.99.3", { knownDevice: "known-device-0002-abcdefg" });
  assert.ok(good.ok);
  await attemptSucceeded(db, good);
  assert.equal((await lockedLoginIds(db, [id])).get(id)?.reason, "day");
  // "Unlock" clears everything, the 10-minute counter too.
  assert.ok((await clearLoginId(db, id)) >= 1);
  assert.equal((await lockedLoginIds(db, [id])).size, 0);
  const [left] = await db.execute(sql`select count(*)::int as n from throttles where key like 'signin:%arya7800%'`).then((r) => (r as unknown as { rows: { n: number }[] }).rows);
  assert.equal(left.n, 0);
  assert.ok((await beginAttempt(db, "signin", id, "198.18.99.1")).ok);
  assert.ok((await beginAttempt(db, "signin", id, "198.18.99.1")).ok);
});

test("known-device tries don't use up the address or the login ID's counters", async () => {
  const id = "arya7801";
  const device = "known-device-0003-abcdefg";
  for (let i = 0; i < LIMITS.signinPerDevice; i++) assert.ok((await beginAttempt(db, "signin", id, "198.18.200.1", { knownDevice: device })).ok);
  const [addr] = await db.execute(sql`select count from throttles where key = 'ip:198.18.200.1'`).then((r) => (r as unknown as { rows: { count: number }[] }).rows);
  assert.equal(addr, undefined);
  const [perId] = await db.execute(sql`select count from throttles where key = 'signin:id:arya7801'`).then((r) => (r as unknown as { rows: { count: number }[] }).rows);
  assert.equal(perId, undefined);
  // A malformed device id is treated as an unknown device.
  const odd = await beginAttempt(db, "signin", id, "198.18.200.2", { knownDevice: "short" });
  assert.ok(odd.ok && odd.taken.some((t) => t.key.startsWith("signin:pair:")));
  // Only sign-in uses known devices.
  const code = await beginAttempt(db, "2fa", id, "198.18.200.3", { knownDevice: device });
  assert.ok(code.ok && code.taken.some((t) => t.key.startsWith("2fa:id:")));
});

test("authenticator codes: 20 wrong in a row lock two-step sign-in until it is unlocked", async () => {
  const id = "aesri.locked";
  let wrong = 0;
  let starts = 0;
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < LIMITS.twoFactor; i++) {
      const r = await beginAttempt(db, "2fa", id, `203.0.113.${round}`);
      assert.ok(r.ok, `code ${wrong + 1}`);
      wrong++;
      if (r.ok && r.locksIfWrong.includes("codes")) starts++;
    }
    await after15Minutes(["2fa:%", "ip:%"]);
  }
  assert.equal(wrong, LIMITS.twoFactorInARow);
  assert.equal(starts, 1, "said once, by the 20th wrong code");
  const refused = await beginAttempt(db, "2fa", id, "203.0.113.50");
  assert.ok(!refused.ok && refused.blocked === "codes" && refused.until === null);
  // Time doesn't help.
  await after15Minutes(["2fa:%", "ip:%"]);
  await db.execute(sql`update throttles set window_start = window_start - interval '30 days' where key like '2fa:row:%'`);
  assert.ok(!(await beginAttempt(db, "2fa", id, "203.0.113.51")).ok);
  assert.deepEqual((await lockedLoginIds(db, [id])).get(id), { reason: "codes", until: null });
  // Unlocking does.
  assert.ok((await clearLoginId(db, id)) >= 1);
  assert.equal((await lockedLoginIds(db, [id])).size, 0);
  assert.ok((await beginAttempt(db, "2fa", id, "203.0.113.52")).ok);
});

test("a right authenticator code starts the count of wrong codes in a row again", async () => {
  const id = "aesri.typo";
  for (let i = 0; i < 4; i++) assert.ok((await beginAttempt(db, "2fa", id, "203.0.113.60")).ok);
  const right = await beginAttempt(db, "2fa", id, "203.0.113.60");
  assert.ok(right.ok);
  await attemptSucceeded(db, right);
  const [row] = await db.execute(sql`select count from throttles where key = '2fa:row:aesri.typo'`).then((r) => (r as unknown as { rows: { count: number }[] }).rows);
  assert.equal(row, undefined);
});

test("a right password doesn't add to the daily count, and doesn't clear it", async () => {
  const id = "arya7802";
  for (let i = 0; i < 3; i++) assert.ok((await beginAttempt(db, "signin", id, "203.0.113.70")).ok);
  const good = await beginAttempt(db, "signin", id, "203.0.113.70");
  assert.ok(good.ok);
  await attemptSucceeded(db, good);
  const [day] = await db.execute(sql`select count from throttles where key = 'signin:day:arya7802'`).then((r) => (r as unknown as { rows: { count: number }[] }).rows);
  assert.equal(day.count, 3);
});

test("the known-device cookie: only for the same account and password, at most five accounts", async () => {
  const { deviceCookieValue, knownDeviceIn, parseDeviceCookie } = await import("../../lib/auth/device-cookie");
  const changed = new Date("2026-09-01T10:00:00Z");
  const a = { id: "11111111-1111-4111-8111-111111111111", passwordChangedAt: changed };
  const b = { id: "22222222-2222-4222-8222-222222222222", passwordChangedAt: null };
  const v1 = deviceCookieValue(null, a);
  const p1 = parseDeviceCookie(v1);
  assert.ok(p1 && /^[A-Za-z0-9_-]{22}$/.test(p1.deviceId));
  assert.equal(knownDeviceIn(p1, a), p1!.deviceId);
  assert.equal(knownDeviceIn(p1, b), null, "another account");
  assert.equal(knownDeviceIn(p1, { ...a, passwordChangedAt: new Date(changed.getTime() + 1) }), null, "a new password");
  // The same browser keeps its id; the newest account comes first.
  const v2 = deviceCookieValue(p1, b);
  const p2 = parseDeviceCookie(v2)!;
  assert.equal(p2.deviceId, p1!.deviceId);
  assert.ok(knownDeviceIn(p2, a) && knownDeviceIn(p2, b));
  assert.ok(!v2.includes(a.id) && !v2.includes(b.id), "no account ids in the cookie");
  // A copied entry doesn't work in another browser.
  const other = parseDeviceCookie(deviceCookieValue(null, b))!;
  assert.equal(knownDeviceIn({ deviceId: other.deviceId, entries: p1!.entries }, a), null);
  // At most five accounts: the oldest drops out.
  let p = p2;
  const more = Array.from({ length: 5 }, (_, i) => ({ id: `3333333${i}-3333-4333-8333-333333333333`, passwordChangedAt: null }));
  for (const acc of more) p = parseDeviceCookie(deviceCookieValue(p, acc))!;
  assert.equal(p.entries.length, 5);
  assert.equal(knownDeviceIn(p, a), null);
  // Malformed or tampered cookies count as none.
  for (const bad of [undefined, "", "v2.abc", `v1.${"x".repeat(22)}.zz`, "v1." + "a".repeat(700)]) {
    const parsed = parseDeviceCookie(bad);
    assert.equal(parsed === null ? null : knownDeviceIn(parsed, a), null, String(bad).slice(0, 20));
  }
  const tampered = v1.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  assert.equal(knownDeviceIn(parseDeviceCookie(tampered), a), null);
});

test("a known device also has a daily limit of its own: 30 wrong tries in 24 hours", async () => {
  const id = "arya7803";
  const device = "known-device-0009-abcdefg";
  let counted = 0;
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < LIMITS.signinPerDevice && counted < LIMITS.signinPerDeviceDay; i++) {
      assert.ok((await beginAttempt(db, "signin", id, `198.18.150.${round}`, { knownDevice: device })).ok, `try ${counted + 1}`);
      counted++;
    }
    await after15Minutes(["signin:device:%"]);
  }
  assert.equal(counted, LIMITS.signinPerDeviceDay);
  const refused = await beginAttempt(db, "signin", id, "198.18.150.9", { knownDevice: device });
  assert.ok(!refused.ok && refused.blocked === "account" && refused.until && refused.until.getTime() > Date.now() + 23 * 60 * 60_000);
  // It doesn't lock the login ID for anyone else, and "Unlock" clears it.
  assert.equal((await lockedLoginIds(db, [id])).size, 0);
  assert.ok((await beginAttempt(db, "signin", id, "198.18.150.10")).ok);
  await clearLoginId(db, id);
  assert.ok((await beginAttempt(db, "signin", id, "198.18.150.9", { knownDevice: device })).ok);
});

test("activation shares the 15-minute counters with sign-in", async () => {
  const id = "arya7804";
  for (let i = 0; i < LIMITS.signinPerAddress; i++) assert.ok((await beginAttempt(db, "signin", id, "198.18.160.1")).ok);
  const refused = await beginAttempt(db, "activate", id, "198.18.160.1");
  assert.ok(!refused.ok && refused.blocked === "account");
  // A right activation clears the login ID's counters, like a right password.
  const ok = await beginAttempt(db, "activate", id, "198.18.160.2");
  assert.ok(ok.ok);
  await attemptSucceeded(db, ok);
  const [perId] = await db.execute(sql`select count from throttles where key = 'signin:id:arya7804'`).then((r) => (r as unknown as { rows: { count: number }[] }).rows);
  assert.equal(perId, undefined);
});
