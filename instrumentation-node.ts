/**
 * Start-up for the Node.js server (loaded by instrumentation.ts).
 *
 * On a production server it first checks the settings every sign-in, slip,
 * payment and text message depends on, so a missing or wrong setting stops
 * the server at start-up with a clear message — instead of the server
 * running and then failing for one family at a time. `npm run dev` skips
 * the checks.
 *
 * It warns (without stopping) when the Stud-AI settings look wrong, since
 * Stud-AI's estimates are optional.
 *
 * Then it starts the text message sender (lib/sms/worker.ts), in
 * development and production alike, unless SMS_WORKER=off (for example
 * when another server or a scheduled `npm run sms:send` does the sending),
 * the Razorpay check for online payments that never got a receipt
 * (lib/services/payment-check.ts; it does nothing without Razorpay keys),
 * unless PAYMENTS_CHECK=off, and the daily clean-up of old Hindi
 * translations (lib/translate).
 */
import { appSecret, appUrl, databaseSetting, paymentProvider, razorpayTestKeysRefused, trustedProxyHops } from "./lib/env";
import { smsConfigProblem } from "./lib/sms/config";
import { translateConfigProblem } from "./lib/translate/config";
import { studAiConfigProblem, studAiDir } from "./lib/studai/config";
import { assertNoProductionEnvFiles, PRODUCTION_SECRET_PROVIDERS } from "./scripts/production-secrets.mjs";

function checkSettings() {
  if (!PRODUCTION_SECRET_PROVIDERS.includes(process.env.AESRI_SECRETS_PROVIDER ?? "")) throw new Error("Use the production launcher (npm start), which reads the production secret.");
  assertNoProductionEnvFiles(process.cwd());
  databaseSetting(); // throws when DATABASE_URL is missing (and PGLITE_DIR doesn't ask for the embedded database)
  appSecret(); // throws when APP_SECRET is missing or too short
  trustedProxyHops(); // throws when TRUSTED_PROXY_HOPS isn't a whole number from 0 to 10
  if (!process.env.APP_URL?.trim()) {
    throw new Error("APP_URL is not set. Set it to the portal's public address, e.g. https://portal.example.org (slips, QR codes and payments use it).");
  }
  if (!/^https?:\/\//.test(appUrl())) throw new Error("APP_URL must start with https:// (or http:// on a test computer).");
  if (!appUrl().startsWith("https://") && process.env.ALLOW_HTTP_APP_URL?.trim() !== "1") {
    throw new Error("APP_URL must start with https:// on a production server: over http, sign-in cookies aren't marked Secure and HSTS is off. (On a test server without HTTPS, set ALLOW_HTTP_APP_URL=1.)");
  }
  const sms = smsConfigProblem();
  if (sms) throw new Error(sms);
  const translate = translateConfigProblem();
  if (translate) throw new Error(translate);
  if (paymentProvider() === "razorpay") {
    const missing = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"].filter((k) => !process.env[k]?.trim());
    if (missing.length) throw new Error(`PAYMENT_PROVIDER is razorpay, but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set.`);
    if (razorpayTestKeysRefused()) {
      throw new Error("RAZORPAY_KEY_ID is a test key (rzp_test_…). Test payments move no money, so the school's server refuses them: use the live keys, or test on a separate staging server with ALLOW_TEST_PAYMENTS=1.");
    }
    if (!process.env.RAZORPAY_WEBHOOK_SECRET?.trim()) {
      throw new Error("RAZORPAY_WEBHOOK_SECRET is not set. Without the webhook, a payment whose browser closes before returning to the portal is never receipted: add the webhook in the Razorpay Dashboard (docs/DEPLOYMENT.md, section 6) and set its secret.");
    }
  }
}

if (process.env.NODE_ENV === "production") {
  try {
    checkSettings();
  } catch (err) {
    // Stop here, so the process manager shows the problem instead of a server that can't sign anyone in.
    console.error(`\n  The portal can't start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// Stud-AI's estimates are optional: a wrong setting only hides them, so say so in the log instead of stopping.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  const problem = studAiConfigProblem();
  if (problem) console.warn(`[stud-ai] ${problem} Teachers see no estimates until it is fixed.`);
  else if (studAiDir()) console.info(`[stud-ai] Estimates from ${studAiDir()}.`);
}

// The text message sender. Never during `next build`, and never allowed to stop the server.
if (process.env.SMS_WORKER?.trim().toLowerCase() !== "off" && process.env.NEXT_PHASE !== "phase-production-build") {
  import("./lib/sms/worker")
    .then((w) => w.startSmsWorker())
    .catch((err) => console.error(`[sms] The text message sender could not start: ${err instanceof Error ? err.message : String(err)}`));
}

// The Razorpay check. Never during `next build`, and never allowed to stop the server.
if (process.env.PAYMENTS_CHECK?.trim().toLowerCase() !== "off" && process.env.NEXT_PHASE !== "phase-production-build") {
  import("./lib/services/payment-check")
    .then((c) => c.startPaymentsCheck())
    .catch((err) => console.error(`[payments] The Razorpay check could not start: ${err instanceof Error ? err.message : String(err)}`));
}

// Hindi translations nobody has read for 180 days are deleted once a day. Never during `next build`.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  const problem = translateConfigProblem();
  if (problem && process.env.NODE_ENV !== "production") console.warn(`[translate] ${problem} Families who read Hindi see English text as written until it is fixed.`);
  import("./lib/translate/housekeeping")
    .then((h) => h.startTranslationHousekeeping())
    .catch((err) => console.error(`[translate] The clean-up of old translations could not start: ${err instanceof Error ? err.message : String(err)}`));
}
