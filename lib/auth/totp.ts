/**
 * Authenticator-app codes (TOTP, RFC 6238) for administrator accounts.
 */
import "server-only";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import { getDb } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { displayLoginId } from "@/lib/ids";
import { needsTwoFactor, type Role } from "@/lib/roles";
import { decryptSecret, encryptSecret } from "./crypto";
import { readSession } from "./session";

const isAdmin = (role: Role) => needsTwoFactor(role);

function totpFor(secretB32: string, label: string) {
  return new TOTP({ issuer: "AESRI Portal", label, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secretB32) });
}

/**
 * Checks a 6-digit code and refuses one that was already used: the code's
 * time-step is recorded only if it is newer than the last one accepted, in
 * one conditional update, so the same code sent twice at once works once.
 */
export async function checkTotp(accountId: string, code: string): Promise<boolean> {
  const db = await getDb();
  const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!acc?.totpSecretEnc) return false;
  const token = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(token)) return false;
  const delta = totpFor(decryptSecret(acc.totpSecretEnc), acc.loginId).validate({ token, window: 1 });
  if (delta === null) return false;
  const step = Math.floor(Date.now() / 1000 / 30) + delta;
  const accepted = await db
    .update(accounts)
    .set({ totpLastStep: step })
    .where(and(eq(accounts.id, accountId), or(isNull(accounts.totpLastStep), lt(accounts.totpLastStep, step))))
    .returning({ id: accounts.id });
  return accepted.length === 1;
}

/** Create (or reuse) the pending authenticator secret shown on the setup page. */
export async function pendingTotpSetup(): Promise<{ uri: string; secret: string } | null> {
  const rec = await readSession();
  if (!rec || !isAdmin(rec.account.role) || rec.account.totpEnabled) return null;
  const db = await getDb();
  let secretB32: string;
  if (rec.account.totpSecretEnc) {
    secretB32 = decryptSecret(rec.account.totpSecretEnc);
  } else {
    secretB32 = new Secret({ size: 20 }).base32;
    await db.update(accounts).set({ totpSecretEnc: encryptSecret(secretB32) }).where(eq(accounts.id, rec.account.id));
  }
  const totp = totpFor(secretB32, displayLoginId(rec.account.loginId));
  return { uri: totp.toString(), secret: secretB32.replace(/(.{4})/g, "$1 ").trim() };
}
