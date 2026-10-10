/**
 * lib/env.ts: when the test checkout may run, when APP_SECRET is required,
 * and how TRUSTED_PROXY_HOPS is read. Each case runs in a fresh Node
 * process with its own environment.
 *
 *   node --import tsx --test tests/unit/env.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const ENV_MODULE = path.join(process.cwd(), "lib", "env.ts");
/** tsx by absolute path, so a case can run in another folder. */
const TSX = pathToFileURL(path.join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs")).href;

/** Run `expr` (using `env`, the lib/env module) with exactly these variables; returns what it printed or threw. */
function run(expr: string, vars: Record<string, string>, cwd = process.cwd()): string {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  // lib/env.ts is compiled as CommonJS, so its exports arrive as the module's default.
  const script = `import(${JSON.stringify(ENV_MODULE)}).then((m) => { const env = m.default ?? m; try { console.log(String(${expr})); } catch (e) { console.log("ERROR: " + e.message); } })`;
  const r = spawnSync(process.execPath, ["--import", TSX, "-e", script], { env: { ...base, ...vars } as unknown as NodeJS.ProcessEnv, cwd, encoding: "utf8" });
  return (r.stdout || r.stderr).trim();
}

test("the test checkout: development yes; production only with ALLOW_TEST_PAYMENTS=1; never with Razorpay", () => {
  assert.equal(run("env.testPaymentsAllowed()", { NODE_ENV: "development" }), "true");
  assert.equal(run("env.testPaymentsAllowed()", {}), "true");
  assert.equal(run("env.testPaymentsAllowed()", { NODE_ENV: "production" }), "false");
  assert.equal(run("env.testPaymentsAllowed()", { NODE_ENV: "production", ALLOW_TEST_PAYMENTS: "yes" }), "false");
  assert.equal(run("env.testPaymentsAllowed()", { NODE_ENV: "production", ALLOW_TEST_PAYMENTS: "1" }), "true");
  assert.equal(run("env.testPaymentsAllowed()", { NODE_ENV: "development", PAYMENT_PROVIDER: "razorpay" }), "false");
  assert.equal(run("env.testPaymentsAllowed()", { NODE_ENV: "production", ALLOW_TEST_PAYMENTS: "1", PAYMENT_PROVIDER: " Razorpay " }), "false");
  assert.equal(run("env.paymentProvider()", { PAYMENT_PROVIDER: "RAZORPAY" }), "razorpay");
});

test("Razorpay test keys: refused on a production server unless ALLOW_TEST_PAYMENTS=1 (they move no money)", () => {
  const rzp = { PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_SECRET: "s" };
  assert.equal(run("env.razorpayTestKeysRefused()", { ...rzp, NODE_ENV: "production", RAZORPAY_KEY_ID: "rzp_test_abc" }), "true");
  assert.equal(run("env.razorpayTestKeysRefused()", { ...rzp, NODE_ENV: "production", RAZORPAY_KEY_ID: "rzp_test_abc", ALLOW_TEST_PAYMENTS: "1" }), "false");
  assert.equal(run("env.razorpayTestKeysRefused()", { ...rzp, NODE_ENV: "production", RAZORPAY_KEY_ID: "rzp_live_abc" }), "false");
  assert.equal(run("env.razorpayTestKeysRefused()", { ...rzp, NODE_ENV: "development", RAZORPAY_KEY_ID: "rzp_test_abc" }), "false");
  assert.equal(run("env.razorpayTestKeys()", { RAZORPAY_KEY_ID: " rzp_test_abc " }), "true");
});

test("APP_SECRET is required on a production server, with a clear message", () => {
  assert.match(run("env.appSecret()", { NODE_ENV: "production" }), /^ERROR: APP_SECRET is not set\. A production server needs/);
  assert.match(run("env.appSecret()", { NODE_ENV: "production", APP_SECRET: "too-short" }), /at least 32 characters/);
  const secret = "s".repeat(40);
  assert.equal(run("env.appSecret()", { NODE_ENV: "production", APP_SECRET: secret }), secret);
});

test("without APP_SECRET, development keeps a random secret in ./.data/app-secret", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-env-"));
  try {
    const first = run("env.appSecret()", { NODE_ENV: "development" }, dir);
    assert.ok(first.length >= 32 && !first.startsWith("ERROR"), first);
    assert.equal(fs.readFileSync(path.join(dir, ".data", "app-secret"), "utf8").trim(), first);
    assert.equal(run("env.appSecret()", { NODE_ENV: "development" }, dir), first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TRUSTED_PROXY_HOPS: default 1, whole numbers 0 to 10, anything else is refused", () => {
  assert.equal(run("env.trustedProxyHops()", {}), "1");
  assert.equal(run("env.trustedProxyHops()", { TRUSTED_PROXY_HOPS: " 2 " }), "2");
  assert.equal(run("env.trustedProxyHops()", { TRUSTED_PROXY_HOPS: "0" }), "0");
  for (const bad of ["one", "-1", "1.5", "11", "2,3"]) assert.match(run("env.trustedProxyHops()", { TRUSTED_PROXY_HOPS: bad }), /^ERROR: TRUSTED_PROXY_HOPS must be a whole number/, bad);
});

test("a production server needs DATABASE_URL, or PGLITE_DIR to use the embedded database on purpose", () => {
  assert.match(run("env.databaseSetting()", { NODE_ENV: "production" }), /^ERROR: DATABASE_URL is not set\. A production server keeps its records in PostgreSQL/);
  assert.match(run("env.databaseSetting()", { NODE_ENV: "production", DATABASE_URL: "  " }), /^ERROR: DATABASE_URL is not set/);
  assert.equal(run("env.databaseSetting()", { NODE_ENV: "production", DATABASE_URL: "postgres://u:p@127.0.0.1:5432/aesri" }), "postgres");
  assert.equal(run("env.databaseSetting()", { NODE_ENV: "production", PGLITE_DIR: "/srv/aesri/db" }), "embedded");
  assert.equal(run("env.databaseSetting()", { NODE_ENV: "development" }), "embedded");
  assert.equal(run("env.databaseSetting()", {}), "embedded");
});
