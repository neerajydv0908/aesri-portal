/**
 * Trusted browsers (lib/auth/trusted.ts) against a real (in-memory)
 * PostgreSQL: a browser trusted after a right authenticator code lets only
 * its own account skip the code, only until it expires and only with the
 * authenticator key it was trusted with; it is forgotten by a new slip,
 * activating with a slip, turning sign-in off and a change of access; and
 * one person can never forget another's. Also the cookie's contents
 * (lib/auth/trusted-cookie.ts) and the browser names shown in the list.
 *
 *   node --import tsx --test tests/unit/trusted-browsers.test.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

// Keyed from APP_SECRET: a fixed test value (never the working copy's own secret file).
process.env.APP_SECRET = "unit-test-secret-unit-test-secret-unit-test-secret";

import type { Tx } from "../../lib/db/client";
import * as schema from "../../lib/db/schema";
import { newSessionToken } from "../../lib/auth/crypto";
import { browserLabel } from "../../lib/auth/browser-label";
import {
  checkTrustedToken,
  forgetTrustedBrowser,
  forgetTrustedBrowsers,
  listTrustedBrowsers,
  MAX_TRUSTED_PER_ACCOUNT,
  TRUST_DAYS,
  trustBrowser,
  trustIdOf,
  type TrustAccount,
} from "../../lib/auth/trusted";
import { MAX_TRUSTED_ACCOUNTS, parseTrustedCookie, trustedTokenFor, trustTagOf, withoutTrustedToken, withTrustedToken } from "../../lib/auth/trusted-cookie";
import { issueCode, redeemCode, setSignInEnabled } from "../../lib/services/accounts";
import { seedReferenceData } from "../../lib/services/reference";
import { createStaff, updateStaff } from "../../lib/services/staff";

const { accounts, trustedBrowsers } = schema;
const DAY = 24 * 60 * 60_000;
const info = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" };

let db: Tx;
const actor = { accountId: null, loginId: "test", ip: null };

before(async () => {
  const client = await PGlite.create();
  const d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  db = d as unknown as Tx;
  await seedReferenceData(db);
});

let n = 0;
/** An active administrator with two-step sign-in set up. */
async function admin(over: Partial<typeof accounts.$inferInsert> = {}) {
  n += 1;
  const [a] = await db
    .insert(accounts)
    .values({ loginId: `aesri.t${n}`, role: "super_admin", displayName: `Test ${n}`, status: "active", passwordHash: "scrypt$x", totpEnabled: true, totpSecretEnc: `v1.key${n}.enc.tag`, ...over })
    .returning();
  return a;
}
const fresh = async (id: string): Promise<TrustAccount> => (await db.select().from(accounts).where(eq(accounts.id, id)))[0];
const trust = async (id: string, now?: Date) => {
  const made = await trustBrowser(db, id, info.userAgent, now);
  assert.ok(made, "the browser should be trusted");
  return made;
};
const rows = async (id: string) => db.select().from(trustedBrowsers).where(eq(trustedBrowsers.accountId, id));

/* ------------------------------------------------------------------ */
/* Cookie                                                              */
/* ------------------------------------------------------------------ */

test("cookie: each account finds only its own token; a new token replaces the account's old one", () => {
  const [a, b] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const ta = newSessionToken();
  const tb = newSessionToken();
  let v = withTrustedToken([], a, ta);
  v = withTrustedToken(parseTrustedCookie(v), b, tb);
  const entries = parseTrustedCookie(v);
  assert.equal(trustedTokenFor(entries, a), ta);
  assert.equal(trustedTokenFor(entries, b), tb);
  assert.equal(trustedTokenFor(entries, "33333333-3333-4333-8333-333333333333"), null);
  // Says nothing readable about the accounts.
  assert.ok(!v.includes(a) && !v.includes(b));
  const ta2 = newSessionToken();
  const again = parseTrustedCookie(withTrustedToken(entries, a, ta2));
  assert.equal(again.length, 2);
  assert.equal(trustedTokenFor(again, a), ta2);
  assert.equal(again[0].tag, trustTagOf(a), "the newest entry comes first");
  // Taking one account out leaves the other; the last one out means no cookie.
  const onlyB = withoutTrustedToken(again, a);
  assert.ok(onlyB);
  assert.equal(trustedTokenFor(parseTrustedCookie(onlyB), b), tb);
  assert.equal(withoutTrustedToken(parseTrustedCookie(onlyB), b), null);
});

test("cookie: at most five accounts (the oldest goes); anything malformed counts as nothing", () => {
  let v: string | undefined;
  const ids = Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
  for (const id of ids) v = withTrustedToken(parseTrustedCookie(v), id, newSessionToken());
  const entries = parseTrustedCookie(v);
  assert.equal(entries.length, MAX_TRUSTED_ACCOUNTS);
  assert.equal(trustedTokenFor(entries, ids[6]), entries[0].token);
  assert.equal(trustedTokenFor(entries, ids[0]), null);
  assert.equal(trustedTokenFor(entries, ids[1]), null);
  for (const bad of [undefined, "", "v2.abc", "v1", `v1.${"0".repeat(16)}-short`, `v1.${"g".repeat(16)}-${"A".repeat(43)}`, "x".repeat(700)]) {
    assert.deepEqual(parseTrustedCookie(bad), [], String(bad).slice(0, 30));
  }
  assert.throws(() => withTrustedToken([], ids[0], "not-a-token"));
});

test("browser names for the list", () => {
  assert.equal(browserLabel(info.userAgent), "Chrome on Windows");
  assert.equal(browserLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"), "Safari on Mac");
  assert.equal(browserLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0"), "Edge on Windows");
  assert.equal(browserLabel("Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0 Mobile Safari/537.36"), "Samsung Internet on Android");
  assert.equal(browserLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1"), "Chrome on iPhone");
  assert.equal(browserLabel("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox on Linux");
  assert.equal(browserLabel("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0 Safari/537.36"), "Chrome on Linux");
  assert.equal(browserLabel(null), "Unknown browser");
  assert.equal(browserLabel("curl/8.0"), "A browser");
});

/* ------------------------------------------------------------------ */
/* Trusting and checking                                               */
/* ------------------------------------------------------------------ */

test("only an active account with two-step sign-in set up can trust a browser", async () => {
  const pending = await admin({ status: "pending" });
  const noTotp = await admin({ totpEnabled: false });
  const off = await admin({ status: "disabled" });
  for (const a of [pending, noTotp, off]) assert.equal(await trustBrowser(db, a.id, info.userAgent), null);
  assert.equal((await db.select().from(trustedBrowsers)).filter((r) => [pending.id, noTotp.id, off.id].includes(r.accountId)).length, 0);
});

test("a trusted browser works for its own account only, and only as the token's SHA-256 is stored", async () => {
  const a = await admin();
  const b = await admin();
  const { token, row } = await trust(a.id);
  assert.equal(row.id, trustIdOf(token));
  assert.ok(!JSON.stringify(await rows(a.id)).includes(token), "the token itself is never stored");
  assert.equal(Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / DAY), TRUST_DAYS);
  assert.equal(row.browser, "Chrome on Windows", "only a short name is kept, not the full user-agent text");
  const used = await checkTrustedToken(db, await fresh(a.id), token);
  assert.equal(used?.id, row.id);
  assert.ok(used?.lastUsedAt, "marked as used");
  assert.equal(await checkTrustedToken(db, await fresh(b.id), token), null, "another account's token");
  assert.equal(await checkTrustedToken(db, await fresh(a.id), newSessionToken()), null, "a token that was never trusted");
  assert.equal(await checkTrustedToken(db, await fresh(a.id), null), null);
  assert.equal(await checkTrustedToken(db, await fresh(a.id), "x".repeat(500)), null);
});

test("it stops working after 30 days, when sign-in is off, without two-step sign-in, or with a new authenticator key", async () => {
  const a = await admin();
  const { token } = await trust(a.id);
  const acc = await fresh(a.id);
  assert.ok(await checkTrustedToken(db, acc, token, new Date(Date.now() + (TRUST_DAYS - 1) * DAY)));
  assert.equal(await checkTrustedToken(db, acc, token, new Date(Date.now() + TRUST_DAYS * DAY + 60_000)), null, "expired");
  assert.equal(await checkTrustedToken(db, { ...acc, status: "disabled" }, token), null, "sign-in turned off");
  assert.equal(await checkTrustedToken(db, { ...acc, status: "pending" }, token), null, "waiting for a slip");
  assert.equal(await checkTrustedToken(db, { ...acc, totpEnabled: false }, token), null, "two-step sign-in not set up");
  assert.equal(await checkTrustedToken(db, { ...acc, totpSecretEnc: null }, token), null, "no authenticator key");
  await db.update(accounts).set({ totpSecretEnc: "v1.another.key.tag" }).where(eq(accounts.id, a.id));
  assert.equal(await checkTrustedToken(db, await fresh(a.id), token), null, "a new authenticator key");
  assert.deepEqual(await listTrustedBrowsers(db, await fresh(a.id)), [], "and it isn't listed any more");
});

test("each account keeps its 10 newest trusted browsers; expired ones are cleared away", async () => {
  const a = await admin();
  const long = Date.now() - 40 * DAY;
  await trust(a.id, new Date(long)); // long expired by now
  const made = [];
  for (let i = 0; i < MAX_TRUSTED_PER_ACCOUNT + 2; i++) made.push(await trust(a.id, new Date(Date.now() - (20 - i) * 60_000)));
  const left = await rows(a.id);
  assert.equal(left.length, MAX_TRUSTED_PER_ACCOUNT);
  const ids = new Set(left.map((r) => r.id));
  assert.ok(!ids.has(made[0].row.id) && !ids.has(made[1].row.id), "the two oldest went");
  assert.ok(ids.has(made.at(-1)!.row.id));
  const listed = await listTrustedBrowsers(db, await fresh(a.id));
  assert.equal(listed[0].id, made.at(-1)!.row.id, "newest first");
});

/* ------------------------------------------------------------------ */
/* Forgetting                                                          */
/* ------------------------------------------------------------------ */

test("forget one (own only), all, or all but this browser", async () => {
  const a = await admin();
  const b = await admin();
  const [a1, a2, a3] = [await trust(a.id), await trust(a.id), await trust(a.id)];
  const b1 = await trust(b.id);
  // Someone else's (or a made-up) id forgets nothing.
  assert.equal(await forgetTrustedBrowser(db, a.id, b1.row.id), null);
  assert.equal(await forgetTrustedBrowser(db, a.id, "not-an-id"), null);
  assert.equal((await rows(b.id)).length, 1);
  assert.equal((await forgetTrustedBrowser(db, a.id, a1.row.id))?.id, a1.row.id);
  assert.equal(await checkTrustedToken(db, await fresh(a.id), a1.token), null);
  // All but this browser.
  assert.equal(await forgetTrustedBrowsers(db, a.id, { except: a3.row.id }), 1);
  assert.equal(await checkTrustedToken(db, await fresh(a.id), a2.token), null);
  assert.ok(await checkTrustedToken(db, await fresh(a.id), a3.token));
  assert.equal(await forgetTrustedBrowsers(db, a.id), 1);
  assert.equal((await rows(a.id)).length, 0);
  assert.equal((await rows(b.id)).length, 1, "the other account's are untouched");
});

test("a new slip, activating with a slip and turning sign-in off forget every trusted browser", async () => {
  const a = await admin();
  await trust(a.id);
  await trust(a.id);
  const issued = await db.transaction((tx) => issueCode(tx, a.id, actor));
  assert.equal(issued.purpose, "reset");
  assert.equal((await rows(a.id)).length, 0, "a new slip");

  // Activated again and two-step sign-in set up again, then trusted again: activating once more forgets it.
  const redeemed = await db.transaction((tx) => redeemCode(tx, a.loginId, issued.code, "three random words here", "203.0.113.9"));
  assert.ok(redeemed.ok);
  await db.update(accounts).set({ totpEnabled: true, totpSecretEnc: "v1.new.key.tag" }).where(eq(accounts.id, a.id));
  await trust(a.id);
  const again = await db.transaction((tx) => issueCode(tx, a.id, actor));
  await db.insert(trustedBrowsers).values({ id: "f".repeat(64), accountId: a.id, totpTag: "x", expiresAt: new Date(Date.now() + DAY), browser: "Chrome on Windows" });
  assert.ok((await db.transaction((tx) => redeemCode(tx, a.loginId, again.code, "three random words here", "203.0.113.9"))).ok);
  assert.equal((await rows(a.id)).length, 0, "activating with a slip");

  const c = await admin();
  await admin(); // another active AESRI administrator, so this one's sign-in may be turned off
  await trust(c.id);
  await db.transaction((tx) => setSignInEnabled(tx, c.id, false, actor));
  assert.equal((await rows(c.id)).length, 0, "sign-in turned off");
  // A row left behind while sign-in was off (say, by a code entered at that very moment) never comes back to life:
  // turning sign-in on again forgets it too.
  await db.insert(trustedBrowsers).values({ id: "e".repeat(64), accountId: c.id, totpTag: "x", expiresAt: new Date(Date.now() + DAY), browser: "Chrome on Windows" });
  await db.transaction((tx) => setSignInEnabled(tx, c.id, true, actor));
  assert.equal((await rows(c.id)).length, 0, "turned on again");
});

test("trusted browsers whose 30 days are over are cleared away, whichever account they belong to", async () => {
  const a = await admin();
  const b = await admin();
  const old = await trust(a.id, new Date(Date.now() - (TRUST_DAYS + 1) * DAY));
  const current = await trust(a.id);
  await trust(b.id); // anyone trusting a browser (or signing in) clears expired rows
  const left = new Set((await rows(a.id)).map((r) => r.id));
  assert.ok(!left.has(old.row.id) && left.has(current.row.id));
});

test("a change of access or leaving forgets the browsers a staff member trusted", async () => {
  const s = await db.transaction((tx) => createStaff(tx, "aryavart", { empNo: "901", name: "Test Accountant", access: "accounts" }, actor));
  const [acc] = await db.select().from(accounts).where(eq(accounts.staffId, s.id));
  await db.update(accounts).set({ status: "active", passwordHash: "scrypt$x", totpEnabled: true, totpSecretEnc: "v1.staff.key.tag" }).where(eq(accounts.id, acc.id));
  await trust(acc.id);
  await db.transaction((tx) => updateStaff(tx, "aryavart", s.id, { access: "teacher" }, actor));
  assert.equal((await rows(acc.id)).length, 0, "change of access");

  await db.update(accounts).set({ role: "accounts" }).where(eq(accounts.id, acc.id));
  await db.transaction((tx) => updateStaff(tx, "aryavart", s.id, { access: "accounts" }, actor));
  await db.update(accounts).set({ status: "active", passwordHash: "scrypt$x", totpEnabled: true, totpSecretEnc: "v1.staff.key2.tag" }).where(eq(accounts.id, acc.id));
  await trust(acc.id);
  await db.transaction((tx) => updateStaff(tx, "aryavart", s.id, { status: "left" }, actor));
  assert.equal((await rows(acc.id)).length, 0, "left the school");
});
