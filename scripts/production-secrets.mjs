import fs from "node:fs";
import path from "node:path";

const ALLOWED = new Set([
  "APP_SECRET", "DATABASE_URL", "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
  "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
  "MSG91_AUTH_KEY", "FAST2SMS_API_KEY", "SMS_API_KEY",
  "AZURE_TRANSLATOR_KEY",
  "STUD_AI_MODEL_SHA256", "STUD_AI_CARD_SHA256",
]);

/** Where the production secret can come from (the launcher records which in AESRI_SECRETS_PROVIDER). */
export const PRODUCTION_SECRET_PROVIDERS = ["secret-file", "aws-secrets-manager"];
const MAX_SECRET_BYTES = 128 * 1024;

export function assertNoProductionEnvFiles(directory) {
  if (fs.readdirSync(directory).some(name => name === ".env" || (name.startsWith(".env.") && name !== ".env.example"))) {
    throw new Error("Production refuses .env files. Keep secrets in the production secret (a locked file outside the app folder, or AWS Secrets Manager) and other settings in the service.");
  }
}

export function parseProductionSecret(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The production secret must be a JSON object."); }
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("The production secret must be a JSON object.");
  const result = {};
  for (const [key, secret] of Object.entries(value)) {
    if (!ALLOWED.has(key) || typeof secret !== "string" || !secret || secret.includes("\0")) {
      throw new Error("The production secret contains an unsupported key or invalid value.");
    }
    result[key] = secret;
  }
  if (!result.APP_SECRET || result.APP_SECRET.length < 32 || !/^postgres(?:ql)?:\/\//.test(result.DATABASE_URL ?? "")) {
    throw new Error("The production secret requires APP_SECRET and a PostgreSQL DATABASE_URL.");
  }
  for (const key of ["STUD_AI_MODEL_SHA256", "STUD_AI_CARD_SHA256"]) {
    if (result[key] !== undefined && !/^[a-f0-9]{64}$/.test(result[key])) throw new Error("The production secret has an invalid model integrity pin.");
  }
  return result;
}

/**
 * Read the production secret from a locked file instead of AWS Secrets Manager.
 * `source` is an absolute path (systemd's LoadCredential puts the file in
 * $CREDENTIALS_DIRECTORY, which a unit file writes as %d/<name>) or "-" for
 * standard input, which root opens for us: `sudo aesri-portal …` hands the file
 * over that way, so the apps' account never needs read access to it.
 * Refuses a file other accounts can read, one inside the app folder, and a terminal.
 */
export function readSecretFile(source, appDirectory) {
  const fromStdin = source === "-";
  if (!fromStdin && !path.isAbsolute(source)) throw new Error("AESRI_SECRET_FILE must be an absolute path, or - for standard input.");
  let fd;
  try { fd = fromStdin ? 0 : fs.openSync(source, "r"); } catch { throw new Error("The production secret file can't be opened. Check AESRI_SECRET_FILE."); }
  try {
    const info = fs.fstatSync(fd);
    if (info.isFile()) {
      if (info.mode & 0o007) throw new Error("The production secret file must not be readable by other accounts (chmod 600).");
      if (info.size > MAX_SECRET_BYTES) throw new Error("The production secret is too large.");
      if (!fromStdin) {
        const real = fs.realpathSync(source), app = fs.realpathSync(appDirectory);
        if (real === app || real.startsWith(app + path.sep)) throw new Error("The production secret file must be outside the app folder.");
      }
    } else if (!info.isFIFO() && !info.isSocket()) {
      throw new Error("The production secret must come from a file or a pipe.");
    }
    const raw = fs.readFileSync(fd, "utf8");
    if (Buffer.byteLength(raw) > MAX_SECRET_BYTES) throw new Error("The production secret is too large.");
    return raw;
  } finally {
    if (!fromStdin) fs.closeSync(fd);
  }
}

export function productionEnvironment(directory, base, raw, provider = "aws-secrets-manager") {
  if (!PRODUCTION_SECRET_PROVIDERS.includes(provider)) throw new Error("Unknown production secret source.");
  assertNoProductionEnvFiles(directory);
  const secret = parseProductionSecret(raw);
  // Required secrets must come from the store, not an inherited shell environment.
  const env = { ...base };
  for (const key of ALLOWED) delete env[key];
  delete env.AESRI_SECRET_FILE;
  if (env.STUD_AI_DIR && (!secret.STUD_AI_MODEL_SHA256 || !secret.STUD_AI_CARD_SHA256)) {
    throw new Error("Stud-AI requires both integrity pins in the production secret.");
  }
  return { ...env, ...secret, NODE_ENV: "production", AESRI_SECRETS_PROVIDER: provider };
}

export function productionCommand(mode, extra = []) {
  const modes = {
    start: ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3001"],
    build: ["node_modules/next/dist/bin/next", "build"],
    migrate: ["--import", "tsx", "scripts/migrate.ts"],
    setup: ["--import", "tsx", "scripts/setup.ts"],
    "admin:create": ["--import", "tsx", "scripts/create-admin.ts"],
    "sms:send": ["--import", "tsx", "scripts/sms-send.ts"],
    "payments:check": ["--import", "tsx", "scripts/payments-check.ts"],
    "signin:unlock": ["--import", "tsx", "scripts/unlock-signin.ts"],
    "fees:relabel": ["--import", "tsx", "scripts/relabel-fees.ts"],
  };
  const takesArguments = mode === "admin:create" || mode === "signin:unlock" || mode === "fees:relabel";
  if (!Object.hasOwn(modes, mode) || (extra.length && !takesArguments)) throw new Error("Unsupported production command.");
  return [process.execPath, ...modes[mode], ...extra];
}
