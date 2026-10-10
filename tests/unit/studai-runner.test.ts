/**
 * Running Stud-AI (lib/studai/runner.ts and config.ts) against a stand-in
 * Stud-AI folder (tests/unit/fixtures/fake-studai.ts): the answer is read
 * back and checked; every way it can go wrong comes back as a plain
 * message, never an exception; and Python never gets the portal's secrets.
 *
 *   node --import tsx --test tests/unit/studai-runner.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { CONTRACT, type BatchRequest } from "../../lib/studai/contract";
import { studAiConfigProblem, studAiPython, studAiTimeoutMs, modelFingerprint } from "../../lib/studai/config";
import { pythonEnv, runStudAi, MAX_PENDING } from "../../lib/studai/runner";
import { makeFakeStudAi, pythonAvailable } from "./fixtures/fake-studai";

const skip = pythonAvailable() ? false : "needs python3";
const fake = makeFakeStudAi();
after(() => fake.remove());

const env = (over: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", STUD_AI_DIR: fake.dir, STUD_AI_PYTHON: "python3", ...over });

const request: BatchRequest = {
  contract: CONTRACT,
  students: [
    {
      ref: "s1",
      subjects: [
        { key: "m", name: "Mathematics", tests: [40, 44], attendance: 80, homework: null },
        { key: "h", name: "Hindi", tests: [], attendance: 80, homework: 60 },
      ],
    },
  ],
};

test("an answer comes back, checked", { skip }, async () => {
  fake.setMode(null);
  const r = await runStudAi(request, { env: env() });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.response.results.length, 1);
  assert.equal(r.response.results[0].percent, 58); // tests 40 and 44: average 42
  assert.equal(r.response.results[0].text, "Estimated risk of not passing the next mathematics examination: 58%");
  assert.equal(r.response.results[0].known_subject, true);
  assert.deepEqual(r.response.results[0].assumed, ["Homework done in mathematics"]);
  assert.deepEqual(r.response.skipped, [{ ref: "s1", key: "h", reason: "no test scores yet" }]);
});

test("each problem comes back in words", { skip }, async () => {
  const cases: [string, RegExp][] = [
    ["fail2", /^Stud-AI refused the request: The request is not valid JSON \(test\)\.$/],
    ["fail3", /^Stud-AI has no trained model: No trained model at/],
    ["crash", /^Stud-AI stopped with an error: RuntimeError: something broke\.$/],
    ["missing-module", /^Stud-AI's Python packages are missing .*pip install -r requirements\.txt/],
    ["garbage", /^Stud-AI's answer wasn't valid JSON\.$/],
    ["leak", /expected shape/],
  ];
  for (const [mode, message] of cases) {
    fake.setMode(mode);
    const r = await runStudAi(request, { env: env() });
    assert.equal(r.ok, false, mode);
    if (!r.ok) assert.match(r.error, message, mode);
  }
  fake.setMode(null);
});

test("a run that takes too long is stopped", { skip }, async () => {
  fake.setMode("sleep");
  const t = Date.now();
  const r = await runStudAi(request, { env: env(), timeoutMs: 1500 });
  fake.setMode(null);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /took longer than 2 seconds and was stopped/);
  assert.ok(Date.now() - t < 10_000);
});

test("Python never gets the portal's secrets", { skip }, async () => {
  fake.setMode("env");
  const r = await runStudAi(request, { env: env({ APP_SECRET: "x".repeat(40), DATABASE_URL: "postgres://secret", RAZORPAY_KEY_SECRET: "rk", SMS_API_KEY: "sk" }) });
  fake.setMode(null);
  assert.equal(r.ok, false);
  const keys = r.ok ? [] : r.error.replace(/^Stud-AI refused the request: /, "").split(",");
  for (const secret of ["APP_SECRET", "DATABASE_URL", "RAZORPAY_KEY_SECRET", "SMS_API_KEY", "STUD_AI_DIR"]) assert.ok(!keys.includes(secret), secret);
  assert.ok(keys.includes("PATH") && keys.includes("PYTHONIOENCODING"));
  assert.deepEqual(Object.keys(pythonEnv({ PATH: "/bin", APP_SECRET: "s" })).sort(), ["LANG", "LC_ALL", "PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING", "PYTHONNOUSERSITE", "PYTHONUTF8"]);
});

test("runs wait for each other", { skip }, async () => {
  fake.setMode(null);
  const before = fake.calls().length;
  const all = await Promise.all([runStudAi(request, { env: env() }), runStudAi(request, { env: env() }), runStudAi(request, { env: env() })]);
  assert.ok(all.every((r) => r.ok));
  assert.equal(fake.calls().length, before + 3);
});

test("queue admission is bounded before work is scheduled", { skip }, async () => {
  fake.setMode(null);
  const all = await Promise.all(Array.from({ length: MAX_PENDING + 5 }, () => runStudAi(request, { env: env() })));
  assert.equal(all.filter(r => r.ok).length, MAX_PENDING);
  assert.equal(all.filter(r => !r.ok && /busy/.test(r.error)).length, 5);
});

test("same-size model and card tampering is refused without using a metadata cache", { skip }, async () => {
  for (const name of ["pass_risk.cbm", "model_card.json"]) {
    const file = path.join(fake.dir, "models", name);
    const original = fs.readFileSync(file);
    const st = fs.statSync(file);
    const before = fake.calls().length;
    try {
      const changed = Buffer.from(original);
      changed[changed.length - 1] ^= 1;
      fs.writeFileSync(file, changed);
      fs.utimesSync(file, st.atime, st.mtime);
      assert.equal(modelFingerprint(fake.dir, env()), null);
      const result = await runStudAi(request, { env: env() });
      assert.equal(result.ok, false);
      assert.equal(fake.calls().length, before);
    } finally { fs.writeFileSync(file, original); }
  }
});

test("production never falls back to development pins", async () => {
  const result = await runStudAi(request, { env: env({ NODE_ENV: "production" }) });
  assert.equal(result.ok, false);
});

test("settings: what is wrong, in words", () => {
  assert.equal(studAiConfigProblem({}), null); // not set up is not a problem
  assert.equal(studAiConfigProblem(env()), null);
  assert.match(studAiConfigProblem({ STUD_AI_DIR: path.join(fake.dir, "nope") })!, /there is no folder there/);
  assert.match(studAiConfigProblem({ STUD_AI_DIR: path.join(fake.dir, "models") })!, /isn't a Stud-AI folder/);
  assert.match(studAiConfigProblem(env({ STUD_AI_PYTHON: "/no/such/python" }))!, /STUD_AI_PYTHON is \/no\/such\/python, but there is no program there/);
  assert.equal(studAiPython(fake.dir, { STUD_AI_PYTHON: " /usr/bin/python3 " }), "/usr/bin/python3");
  assert.equal(studAiPython(fake.dir, {}), process.platform === "win32" ? "python" : "python3");
  assert.equal(studAiTimeoutMs({}), 30_000);
  assert.equal(studAiTimeoutMs({ STUD_AI_TIMEOUT_SECONDS: "1" }), 5_000);
  assert.equal(studAiTimeoutMs({ STUD_AI_TIMEOUT_SECONDS: "abc" }), 30_000);
});

test("not set up, or Python missing: a message, not an exception", async () => {
  const off = await runStudAi(request, { env: { PATH: process.env.PATH ?? "" } });
  assert.equal(off.ok, false);
  if (!off.ok) assert.match(off.error, /isn't set up on this server/);
  const noPython = await runStudAi(request, { env: env({ STUD_AI_PYTHON: "no-such-python-for-stud-ai" }) });
  assert.equal(noPython.ok, false);
  if (!noPython.ok) assert.match(noPython.error, /Python wasn't found \(no-such-python-for-stud-ai\)/);
});

/** A real Stud-AI folder with its packages installed: STUD_AI_TEST_DIR, or the one next to this project. */
function realStudAi(): string | null {
  const hasVenv = (d: string) => [".venv", ".venv.nosync"].some((v) => fs.existsSync(path.join(d, v)));
  const candidates = [process.env.STUD_AI_TEST_DIR?.trim(), path.resolve("..", "Stud-AI"), path.resolve("..", "stud-ai-ml")].filter((d): d is string => !!d);
  return candidates.find((d) => fs.existsSync(path.join(d, "stud_ai", "batch.py")) && fs.existsSync(path.join(d, "models", "pass_risk.cbm")) && (hasVenv(d) || !!process.env.STUD_AI_TEST_DIR)) ?? null;
}
const real = realStudAi();

test("the real Stud-AI answers in the same contract", { skip: real ? false : "no Stud-AI folder with its packages next to the portal (set STUD_AI_TEST_DIR)" }, async () => {
  const subjects = (tests: number[]) => [
    { key: "m", name: "Mathematics", tests, attendance: 85, homework: 70 },
    { key: "e", name: "English", tests: tests.map((t) => t + 5), attendance: 85, homework: 70 },
    { key: "h", name: "Hindi", tests, attendance: 85, homework: null },
    { key: "s", name: "Social Science", tests: [], attendance: 85, homework: 80 },
  ];
  const r = await runStudAi(
    { contract: CONTRACT, students: [{ ref: "weak", subjects: subjects([30, 28, 35]) }, { ref: "strong", subjects: subjects([80, 85, 82]) }] },
    { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", STUD_AI_DIR: real! }, timeoutMs: 120_000 },
  );
  assert.ok(r.ok, r.ok ? "" : r.error);
  const get = (ref: string, key: string) => r.response.results.find((x) => x.ref === ref && x.key === key)!;
  assert.equal(r.response.results.length, 6);
  // Hindi isn't in the model's training: no estimate, only "Not enough data as of now".
  assert.equal(get("weak", "h").known_subject, false);
  assert.equal(get("weak", "h").percent, null);
  assert.equal(get("weak", "h").text, "Not enough data as of now for Hindi");
  assert.deepEqual(get("weak", "h").reasons, []);
  assert.ok(get("weak", "m").percent! >= 50, String(get("weak", "m").percent));
  assert.ok(get("strong", "m").percent! < 50, String(get("strong", "m").percent));
  assert.match(get("strong", "m").text, /^Estimated risk of not passing the next mathematics examination: \d{1,2}%$/);
  assert.ok(get("weak", "m").reasons.length > 0);
  for (const result of r.response.results) {
    assert.deepEqual(Object.keys(result).sort(), ["assumed", "key", "known_subject", "percent", "reasons", "ref", "subject", "tests_used", "text"]);
    for (const reason of result.reasons) assert.deepEqual(Object.keys(reason).sort(), ["effect", "key", "sentence", "value", "words"]);
  }
  assert.deepEqual(r.response.skipped.map((x) => `${x.ref}:${x.key}`).sort(), ["strong:s", "weak:s"]);
  assert.ok(r.response.model.subjects_trained_on.includes("mathematics"));
});
