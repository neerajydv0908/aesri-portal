/**
 * Environment settings with safe defaults for local use.
 *
 *   APP_SECRET           Master secret (at least 32 characters). Required on a production
 *                        server (NODE_ENV=production) and for command-line scripts that use
 *                        DATABASE_URL. Without it, `npm run dev` keeps a random secret in
 *                        ./.data/app-secret.
 *   APP_URL              The portal's public address (QR codes on slips, payment callbacks).
 *   PAYMENT_PROVIDER     "razorpay" once AESRI has an account; anything else means the
 *                        built-in test checkout ("mock").
 *   ALLOW_TEST_PAYMENTS  "1" lets the test checkout, and Razorpay test keys, run on a
 *                        production server (a demo or staging server only). See
 *                        testPaymentsAllowed() and razorpayTestKeysRefused().
 *   ALLOW_HTTP_APP_URL   "1" lets a production server run with an http:// APP_URL (a test
 *                        server without HTTPS only; checked in instrumentation-node.ts).
 *   TRUSTED_PROXY_HOPS   How many reverse proxies stand in front of the portal (default 1).
 *                        See trustedProxyHops().
 *   WEBSITE_URL          The public website, linked from the sign-in pages (default
 *                        https://aesrischools.org; http://localhost:3000 with `npm run dev`).
 *   DATABASE_URL         The PostgreSQL database. Required on a production server, unless
 *                        PGLITE_DIR says on purpose where the embedded database lives. See
 *                        databaseSetting().
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const isProduction = () => process.env.NODE_ENV === "production";

/**
 * Where the records are kept: "postgres" (DATABASE_URL) or "embedded"
 * (PGlite, in PGLITE_DIR or ./.data/db). On a production server the
 * embedded database must be asked for by setting PGLITE_DIR: a missing
 * DATABASE_URL would otherwise quietly put the school's records in a folder
 * next to the code, where an update or a new server could lose them.
 */
export function databaseSetting(): "postgres" | "embedded" {
  if (process.env.DATABASE_URL?.trim()) return "postgres";
  if (isProduction() && !process.env.PGLITE_DIR?.trim()) {
    throw new Error(
      "DATABASE_URL is not set. A production server keeps its records in PostgreSQL: set DATABASE_URL, e.g. postgres://aesri:…@127.0.0.1:5432/aesri (docs/DEPLOYMENT.md). " +
        "To use the embedded database on one computer on purpose, set PGLITE_DIR to the folder for the records instead.",
    );
  }
  return "embedded";
}

let cachedSecret: string | undefined;

/**
 * The master secret. On a production server it must come from APP_SECRET.
 * On a laptop without one, a random secret is created once and kept in
 * ./.data/app-secret so that slips stay valid across restarts.
 */
export function appSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.APP_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error("APP_SECRET must be at least 32 characters long.");
    cachedSecret = fromEnv;
    return fromEnv;
  }
  if (isProduction()) {
    throw new Error(
      "APP_SECRET is not set. A production server needs a long random secret (at least 32 characters) in APP_SECRET, kept the same across restarts. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
    );
  }
  const file = path.join(process.cwd(), ".data", "app-secret");
  try {
    cachedSecret = fs.readFileSync(file, "utf8").trim();
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    cachedSecret = crypto.randomBytes(48).toString("base64url");
    fs.writeFileSync(file, cachedSecret, { mode: 0o600 });
  }
  return cachedSecret;
}

export function appUrl(): string {
  return (process.env.APP_URL || "http://localhost:3001").replace(/\/+$/, "");
}

export function paymentProvider(): "mock" | "razorpay" {
  return process.env.PAYMENT_PROVIDER?.trim().toLowerCase() === "razorpay" ? "razorpay" : "mock";
}

/**
 * May the built-in test checkout ("mock") be used — to pay, to take its
 * webhooks, or to show its page? Never when PAYMENT_PROVIDER=razorpay.
 * Otherwise only when the server isn't a production build (`npm run dev`),
 * or when ALLOW_TEST_PAYMENTS=1 is set on purpose for a demo server. So a
 * real school's server can never mark fees as paid without money moving.
 */
export function testPaymentsAllowed(): boolean {
  if (paymentProvider() === "razorpay") return false;
  return !isProduction() || process.env.ALLOW_TEST_PAYMENTS?.trim() === "1";
}

/** Razorpay test keys (rzp_test_…): their payments move no money. */
export function razorpayTestKeys(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID?.trim().startsWith("rzp_test_"));
}

/**
 * Razorpay test keys on a production server: refused unless
 * ALLOW_TEST_PAYMENTS=1 says on purpose that this is a demo or staging
 * server. Otherwise a family could "pay" in Razorpay's test checkout and get
 * a real receipt in the school's numbering with no money received.
 */
export function razorpayTestKeysRefused(): boolean {
  return paymentProvider() === "razorpay" && razorpayTestKeys() && isProduction() && process.env.ALLOW_TEST_PAYMENTS?.trim() !== "1";
}

/**
 * TRUSTED_PROXY_HOPS: the number of reverse proxies (nginx, Caddy, a load
 * balancer, Cloudflare…) between visitors and this Node server. Default 1.
 *
 * Next.js puts the connection's address into X-Forwarded-For only when a
 * request arrives without that header, and never adds to a header that is
 * already there. Each proxy should append the address it received the
 * request from (nginx: `proxy_set_header X-Forwarded-For
 * $proxy_add_x_forwarded_for;`). Caddy instead replaces the header with the
 * address it received the request from, unless its `trusted_proxies` lists
 * the proxies in front of it (Cloudflare's proxied mode, a load balancer):
 * only then does it append, and only then is 2 right. The visitor's
 * address is then the entry this many places from the right end — the
 * address the outermost proxy saw. Entries further left were written by
 * the visitor and are ignored. When the header has fewer entries than
 * that, the address is recorded as "unknown" (a request that bypassed a
 * proxy, or a proxy that replaces the header: then use a smaller number).
 *
 * 0 means no proxy (a laptop): the portal then uses the header's last
 * entry, which Next.js fills in from the connection — but a visitor who
 * sends the header themselves chooses it. A production server must sit
 * behind a proxy (it also provides HTTPS), and its Node port must not be
 * reachable from outside (`next start -H 127.0.0.1`, or a firewall).
 *
 * Why 1 is the default: every HTTPS deployment has at least one proxy in
 * front of Node. Counting too many proxies lets visitors choose their
 * address. Counting too few never does, but every visitor then shares the
 * outer proxy's address, so the limits on wrong passwords per address
 * apply to everyone together: get the number right.
 */
export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 1;
  if (!/^\d{1,2}$/.test(raw) || Number(raw) > 10) {
    throw new Error("TRUSTED_PROXY_HOPS must be a whole number from 0 to 10: the number of reverse proxies in front of the portal.");
  }
  return Number(raw);
}

/**
 * WEBSITE_URL: AESRI's public website, for the "← aesrischools.org" link on the
 * sign-in pages. Default https://aesrischools.org; with `npm run dev`,
 * http://localhost:3000 (where the website's own `npm run dev` runs). Only
 * an http(s) address is used; anything else falls back to the default.
 */
export function websiteUrl(): string {
  const fallback = process.env.NODE_ENV === "development" ? "http://localhost:3000" : "https://aesrischools.org";
  const raw = process.env.WEBSITE_URL?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href.replace(/\/+$/, "") : fallback;
  } catch {
    return fallback;
  }
}
