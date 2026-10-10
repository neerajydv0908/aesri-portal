/**
 * Start a production command with the portal's secrets, read once at start-up and
 * never printed or written anywhere:
 *   AESRI_SECRET_FILE  a locked JSON file outside the app folder: a path such as
 *                      %d/aesri-portal (systemd LoadCredential), or - for standard
 *                      input (`sudo aesri-portal …` on the server);
 *   otherwise          AWS Secrets Manager: AESRI_SECRET_ID and AWS_REGION, with the
 *                      host's IAM role and the `aws` command line.
 */
import { execFileSync, spawn } from "node:child_process";
import { productionCommand, productionEnvironment, assertNoProductionEnvFiles, readSecretFile } from "./production-secrets.mjs";

function fromAwsSecretsManager() {
  const id = process.env.AESRI_SECRET_ID;
  const region = process.env.AWS_REGION;
  if (!id || !region) throw new Error("Set AESRI_SECRET_FILE (a locked secret file), or AESRI_SECRET_ID and AWS_REGION (AWS Secrets Manager).");
  try {
    return execFileSync("aws", ["secretsmanager", "get-secret-value", "--secret-id", id,
      "--region", region, "--version-stage", "AWSCURRENT", "--query", "SecretString", "--output", "text",
      "--no-cli-pager", "--cli-connect-timeout", "5", "--cli-read-timeout", "15"],
      { encoding: "utf8", timeout: 25000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch { throw new Error("AWS Secrets Manager retrieval failed. Check the host IAM role, secret ID and region."); }
}

try {
  const [mode = "start", ...extra] = process.argv.slice(2);
  const [executable, ...args] = productionCommand(mode, extra);
  assertNoProductionEnvFiles(process.cwd());
  const file = process.env.AESRI_SECRET_FILE?.trim();
  let raw = file ? readSecretFile(file, process.cwd()) : fromAwsSecretsManager();
  const env = productionEnvironment(process.cwd(), process.env, raw, file ? "secret-file" : "aws-secrets-manager");
  raw = undefined;
  // Standard input may be the secret file itself, so the command doesn't inherit it.
  const child = spawn(executable, args, { env, stdio: ["ignore", "inherit", "inherit"], shell: false });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("error", () => { console.error("The production process could not start."); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
