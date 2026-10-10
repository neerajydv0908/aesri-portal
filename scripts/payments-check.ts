/**
 * Run the Razorpay check once, from the command line:
 *
 *   npm run payments:check
 *
 * It does what each portal server does every 10 minutes
 * (lib/services/payment-check.ts): ask Razorpay about recent unfinished
 * online payments and record any that were paid but never got a receipt.
 * Useful when the servers run with PAYMENTS_CHECK=off and a scheduler
 * (cron, systemd timer) checks instead. Safe to run while servers check too:
 * each order is claimed before Razorpay is asked, and a payment is recorded
 * only once.
 *
 * The built-in local database (no DATABASE_URL) can only be opened by one
 * program at a time, so there this refuses to run unless you add --local
 * after stopping the portal server.
 */
import "./_env";
import { closeDb, usingEmbeddedDb } from "../lib/db/client";
import { razorpayGateway } from "../lib/payments";
import { checkSummaryText, checkUnfinishedOrders } from "../lib/services/payment-check";

async function main() {
  if (usingEmbeddedDb() && !process.argv.includes("--local")) {
    throw new Error(
      "This uses the built-in local database, which only one program may open at a time. Stop the portal server first, then run: npm run payments:check -- --local",
    );
  }
  if (!razorpayGateway.isConfigured()) throw new Error("Razorpay keys are not set (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET), so there is nothing to check.");
  const s = await checkUnfinishedOrders();
  console.log(`\n  Razorpay check: ${s.orders} unfinished online payment${s.orders === 1 ? "" : "s"} asked about.`);
  console.log(`  ${checkSummaryText(s) ?? "Nothing found that needs a receipt."}\n`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
  await closeDb();
  process.exit(1);
});
