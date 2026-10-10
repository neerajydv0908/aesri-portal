/**
 * Unlock a login ID from the command line, for when nobody who could unlock
 * it in the portal can sign in — for example the only AESRI administrator,
 * locked after 20 wrong authenticator codes in a row (that lock never ends
 * by itself). It clears every wrong-try counter of the login ID, like
 * "Unlock" in the portal, and says so in the activity log.
 *
 *   npm run signin:unlock -- aesri.meena
 *   node scripts/with-production-secrets.mjs signin:unlock aesri.meena    (on the server)
 *
 * The built-in local database (no DATABASE_URL) can only be opened by one
 * program at a time: stop the portal server first, then add --local.
 */
import "./_env";
import { eq } from "drizzle-orm";
import { audit } from "../lib/audit";
import { clearLoginId } from "../lib/auth/throttle";
import { closeDb, getDb, usingEmbeddedDb } from "../lib/db/client";
import { accounts } from "../lib/db/schema";
import { displayLoginId, normalizeLoginId } from "../lib/ids";

async function main() {
  const args = process.argv.slice(2);
  if (usingEmbeddedDb() && !args.includes("--local")) {
    throw new Error("This uses the built-in local database, which only one program may open at a time. Stop the portal server first, then add --local.");
  }
  const raw = args.find((a) => !a.startsWith("--")) ?? "";
  const loginId = normalizeLoginId(raw);
  if (!loginId) throw new Error("Give the login ID to unlock, for example: npm run signin:unlock -- aesri.meena");
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const [acc] = await tx.select({ id: accounts.id, schoolId: accounts.schoolId, loginId: accounts.loginId }).from(accounts).where(eq(accounts.loginId, loginId));
    const locks = await clearLoginId(tx, loginId);
    if (acc && locks) {
      await audit(tx, { accountId: null, loginId: "command line" }, "account.unlocked", {
        schoolId: acc.schoolId,
        targetType: "account",
        targetId: acc.id,
        details: { loginId: displayLoginId(acc.loginId), via: "command line" },
      });
    }
    return { found: !!acc, locks };
  });
  console.log(
    `\n  ${result.locks ? `Unlocked ${displayLoginId(loginId)}: they can sign in again now.` : `${displayLoginId(loginId)} wasn’t locked${result.found ? "" : " (and there is no account with that login ID)"}.`}\n`,
  );
  await closeDb();
}

main().catch(async (err) => {
  console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
  await closeDb();
  process.exit(1);
});
