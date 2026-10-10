/**
 * Load .env for command-line scripts (Next.js loads it itself for the app).
 *
 * Scripts that work on a PostgreSQL database (DATABASE_URL) — setup,
 * migrate, admin:create, demo --test-database — must use the same
 * APP_SECRET as the portal server: the one-time codes and authenticator
 * secrets they create are keyed with it. They stop here without one,
 * instead of quietly using the local fallback file (./.data/app-secret).
 */
import { assertNoProductionEnvFiles, PRODUCTION_SECRET_PROVIDERS } from "./production-secrets.mjs";

if (process.env.NODE_ENV === "production") {
  if (!PRODUCTION_SECRET_PROVIDERS.includes(process.env.AESRI_SECRETS_PROVIDER ?? "")) throw new Error("Use the production launcher (node scripts/with-production-secrets.mjs …), which reads the production secret.");
  assertNoProductionEnvFiles(process.cwd());
} else {
  if (typeof process.loadEnvFile !== "function") {
    // Node 20.9–20.11 can't read .env: the script would quietly use the built-in database instead of DATABASE_URL.
    throw new Error(`Node.js ${process.versions.node} can't read .env files: use Node.js 20.12 or newer (22 LTS recommended).`);
  }
  try {
    process.loadEnvFile(".env");
  } catch (err) {
    // Local development defaults apply when there is no .env; any other problem (unreadable, a folder…) must not be ignored.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

if (process.env.DATABASE_URL?.trim() && !process.env.APP_SECRET?.trim()) {
  console.error(`
  APP_SECRET is not set.
  This script uses the database in DATABASE_URL, so it needs the same APP_SECRET
  as the portal server (it protects one-time codes and authenticator secrets).
  Set APP_SECRET in .env or in the environment, then run the script again.
`);
  process.exit(1);
}
