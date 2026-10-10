/**
 * Run the text message sender once, from the command line:
 *
 *   npm run sms:send
 *
 * It does what each portal server does every ~30 seconds (lib/sms/worker.ts):
 * queue today's notices and homework summaries, send the messages that are
 * due, and clear the text of messages older than 180 days. Useful when the
 * servers run with SMS_WORKER=off and a scheduler (cron, systemd timer) sends
 * instead, or to check the set-up. Safe to run while servers are sending too:
 * locked rows are skipped, so no message goes twice.
 *
 * The built-in local database (no DATABASE_URL) can only be opened by one
 * program at a time, so there this refuses to run unless you add --local
 * after stopping the portal server.
 */
import "./_env";
import { closeDb, usingEmbeddedDb } from "../lib/db/client";
import { smsConfigProblem, smsMode } from "../lib/sms/config";
import { runSmsPass } from "../lib/sms/worker";

async function main() {
  if (usingEmbeddedDb() && !process.argv.includes("--local")) {
    throw new Error(
      "This uses the built-in local database, which only one program may open at a time. Stop the portal server first, then run: npm run sms:send -- --local",
    );
  }
  const problem = smsConfigProblem();
  if (problem) throw new Error(problem);
  const t = await runSmsPass(new Date(), { purge: true });
  const mode = smsMode();
  console.log(
    `\n  Text messages (${mode === "live" ? "sent through the SMS company" : mode === "test" ? "test mode: written to this log, not sent" : "no SMS company set up: recorded as not sent"}):\n` +
      `    queued now:  ${t.scheduled} for notices, ${t.digests} homework summaries\n` +
      `    sent:        ${t.sent}\n` +
      `    to retry:    ${t.retrying}\n` +
      `    failed:      ${t.failed}\n` +
      `    not sent:    ${t.skipped} skipped, ${t.cancelled} cancelled\n` +
      `    old cleared: ${t.purged}\n`,
  );
  await closeDb();
}

main().catch(async (err) => {
  console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
  await closeDb();
  process.exit(1);
});
