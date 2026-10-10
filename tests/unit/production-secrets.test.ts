import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productionCommand, productionEnvironment, parseProductionSecret, readSecretFile } from "../../scripts/production-secrets.mjs";

const secret = { APP_SECRET: "test-only-".repeat(5), DATABASE_URL: "postgresql://test-only@localhost/test" };
test("production gets secrets only from the validated store response", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-secrets-test-"));
  try {
    fs.writeFileSync(path.join(dir, ".env.example"), "APP_SECRET=");
    const env = productionEnvironment(dir, { APP_SECRET: "wrong", RAZORPAY_KEY_SECRET: "stale", APP_URL: "https://example.org" }, JSON.stringify(secret));
    assert.equal(env.APP_SECRET, secret.APP_SECRET);
    assert.equal(env.RAZORPAY_KEY_SECRET, undefined);
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.AESRI_SECRETS_PROVIDER, "aws-secrets-manager");
    assert.throws(() => productionEnvironment(dir, { STUD_AI_DIR: "/srv/stud-ai" }, JSON.stringify(secret)), /both integrity pins/);
    for (const name of [".env", ".env.production", ".env.production.local", ".env.local"]) {
      fs.writeFileSync(path.join(dir, name), "test-only");
      assert.throws(() => productionEnvironment(dir, {}, JSON.stringify(secret)), /refuses .env/);
      fs.unlinkSync(path.join(dir, name));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("secret payloads cannot inject executable configuration or public variables", () => {
  for (const value of ["bad", "[]", "{}", JSON.stringify({ ...secret, NODE_OPTIONS: "--require /bad" }), JSON.stringify({ ...secret, NEXT_PUBLIC_APP_SECRET: "bad" })]) {
    assert.throws(() => parseProductionSecret(value));
  }
  assert.throws(() => productionCommand("shell"));
  assert.throws(() => productionCommand("start", ["--hostname", "0.0.0.0"]));
  assert.ok(productionCommand("start").includes("127.0.0.1"));
  assert.ok(productionCommand("payments:check").includes("scripts/payments-check.ts"));
  assert.throws(() => productionCommand("payments:check", ["--local"]));
  assert.ok(productionCommand("signin:unlock", ["aesri.meena"]).includes("aesri.meena"));
  assert.ok(productionCommand("fees:relabel", ["--dry-run"]).includes("scripts/relabel-fees.ts"));
});

test("a locked secret file is read; an open, misplaced or missing one is refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-secret-file-"));
  const app = path.join(root, "app");
  fs.mkdirSync(app);
  try {
    const file = path.join(root, "portal.json");
    fs.writeFileSync(file, JSON.stringify(secret));
    fs.chmodSync(file, 0o600);
    assert.equal(readSecretFile(file, app), JSON.stringify(secret));
    const env = productionEnvironment(app, { AESRI_SECRET_FILE: file, APP_URL: "https://example.org" }, readSecretFile(file, app), "secret-file");
    assert.equal(env.AESRI_SECRETS_PROVIDER, "secret-file");
    assert.equal(env.AESRI_SECRET_FILE, undefined);
    assert.equal(env.APP_SECRET, secret.APP_SECRET);
    fs.chmodSync(file, 0o644);
    assert.throws(() => readSecretFile(file, app), /other accounts/);
    const inside = path.join(app, "portal.json");
    fs.writeFileSync(inside, JSON.stringify(secret));
    fs.chmodSync(inside, 0o600);
    assert.throws(() => readSecretFile(inside, app), /outside the app folder/);
    assert.throws(() => readSecretFile("portal.json", app), /absolute path/);
    assert.throws(() => readSecretFile(path.join(root, "missing.json"), app), /can't be opened/);
    assert.throws(() => productionEnvironment(app, {}, JSON.stringify(secret), "env-file"), /Unknown production secret source/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
