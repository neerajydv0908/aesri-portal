/**
 * Create (or reset) the AESRI administrator account and print a one-time
 * code. The administrator opens the portal's "First time? Activate" page,
 * enters the login ID and code, chooses a password, then sets up an
 * authenticator app.
 *
 *   npm run admin:create -- --id aesri.admin --name "Deepak Yadav"
 *   npm run admin:create -- --id aesri.admin --reset
 */
import "./_env";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../lib/db/client";
import { accounts } from "../lib/db/schema";
import { appUrl } from "../lib/env";
import { normalizeLoginId } from "../lib/ids";
import { aesriLoginIdProblem, createAesriAdmin, issueCode } from "../lib/services/accounts";

async function main() {
  const { values } = parseArgs({
    options: { id: { type: "string" }, name: { type: "string" }, reset: { type: "boolean", default: false } },
  });
  if (!values.id) throw new Error('Give a login ID, e.g. --id aesri.admin');
  const loginId = normalizeLoginId(values.id);
  const problem = aesriLoginIdProblem(loginId);
  if (problem) throw new Error(problem);
  const cli = { accountId: null, loginId: "command line" };

  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(accounts).where(eq(accounts.loginId, loginId));
    let accountId = existing?.id;
    if (existing) {
      if (existing.role !== "super_admin") throw new Error("That login ID belongs to another account.");
      if (!values.reset) throw new Error("This administrator already exists. Add --reset to issue a new code (the old password stops working).");
    } else {
      if (!values.name) throw new Error('Give the administrator\'s name, e.g. --name "Deepak Yadav"');
      accountId = (await createAesriAdmin(tx, { loginId, name: values.name }, cli)).accountId;
    }
    return issueCode(tx, accountId!, cli, { validHours: 48 });
  });

  console.log(`
  AESRI administrator ${values.reset ? "reset" : "created"}
  ─────────────────────────────────────────────
  Login ID:          ${result.loginId}
  One-time code:     ${result.code}
  Valid until:       ${result.expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} (IST)

  Open ${appUrl()}/activate, enter the login ID and code,
  choose a password, then set up the authenticator app.
  This code is shown only once and works only once.
`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
  await closeDb();
  process.exit(1);
});
