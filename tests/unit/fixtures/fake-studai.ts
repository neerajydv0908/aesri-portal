/**
 * A stand-in for the Stud-AI folder, for the tests: the same files the
 * portal looks for (stud_ai/batch.py, models/pass_risk.cbm and the model
 * card), with a tiny batch.py that answers in contract 3 without CatBoost.
 * Its estimate is 100 − the average test score (1–99); a subject other than
 * mathematics, maths, English or science gets "Not enough data as of now".
 * Write a MODE file in the folder to make it misbehave; every run appends the
 * number of students it was sent to CALLS.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BATCH_PY = String.raw`
import json, os, sys, time, hashlib
mode = open("MODE").read().strip() if os.path.exists("MODE") else "ok"
if mode == "fail2":
    print("stud-ai: The request is not valid JSON (test).", file=sys.stderr); sys.exit(2)
if mode == "fail3":
    print("stud-ai: No trained model at models/pass_risk.cbm.", file=sys.stderr); sys.exit(3)
if mode == "crash":
    raise RuntimeError("something broke")
if mode == "sleep":
    time.sleep(30)
if mode == "garbage":
    sys.stdout.write("not json"); sys.exit(0)
if mode == "env":
    print("stud-ai: " + ",".join(sorted(os.environ.keys())), file=sys.stderr); sys.exit(2)
if mode == "missing-module":
    import no_such_module_for_stud_ai_tests
req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
with open("CALLS", "a") as f:
    f.write(str(len(req["students"])) + "\n")
results, skipped = [], []
for st in req["students"]:
    for sub in st["subjects"]:
        tests = sub["tests"][-5:]
        if not tests:
            skipped.append({"ref": st["ref"], "key": sub["key"], "reason": "no test scores yet"})
            continue
        avg = sum(tests) / len(tests)
        pct = max(1, min(99, round(100 - avg)))
        name = sub["name"].lower()
        known = name in ("mathematics", "maths", "english", "science")
        if known:
            effect = "raises" if pct >= 50 else "lowers"
            reason = {"key": "scores", "words": name + " test scores so far", "value": "average " + str(round(avg)), "effect": effect,
                "sentence": name + " test scores so far: average " + str(round(avg)) + " (" + effect + " the risk)"}
            result = {"ref": st["ref"], "key": sub["key"], "subject": name, "percent": pct,
                "text": "Estimated risk of not passing the next " + name + " examination: " + str(pct) + "%",
                "reasons": [reason], "assumed": [] if sub["homework"] is not None else ["Homework done in " + name],
                "known_subject": True, "tests_used": len(tests)}
        else:
            result = {"ref": st["ref"], "key": sub["key"], "subject": name, "percent": None,
                "text": "Not enough data as of now for " + name, "reasons": [], "assumed": [],
                "known_subject": False, "tests_used": len(tests)}
        if mode == "leak": result["risk"] = pct / 100
        results.append(result)
print(json.dumps({"contract": 3, "model": {"version": "test", "created": "2026-10-01T00:00:00+00:00", "trees": 1,
      "subjects_trained_on": ["mathematics", "english", "science"], "file_sha256": hashlib.sha256(open("models/pass_risk.cbm", "rb").read()).hexdigest(), "card_sha256": hashlib.sha256(open("models/model_card.json", "rb").read()).hexdigest()},
      "results": results, "skipped": skipped, "errors": []}))
`;

export type FakeStudAi = { dir: string; setMode(mode: string | null): void; calls(): number[]; retrain(): void; remove(): void };

/** Is there a Python 3 to run the stand-in with? */
export function pythonAvailable(): boolean {
  const r = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return r.status === 0 && /Python 3\./.test(r.stdout + r.stderr);
}

export function makeFakeStudAi(): FakeStudAi {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aesri-fake-studai-"));
  fs.mkdirSync(path.join(dir, "stud_ai"));
  fs.mkdirSync(path.join(dir, "models"));
  fs.writeFileSync(path.join(dir, "stud_ai", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "stud_ai", "batch.py"), BATCH_PY);
  fs.writeFileSync(path.join(dir, "models", "pass_risk.cbm"), "model v1");
  fs.writeFileSync(
    path.join(dir, "models", "model_card.json"),
    JSON.stringify({ versions: { stud_ai: "test" }, created: "2026-10-01T00:00:00+00:00", trees: 1, subjects_trained_on: ["mathematics", "english", "science"] }),
  );
  const pin = () => fs.writeFileSync(path.join(dir, "stud_ai", "trusted_artifacts.json"), JSON.stringify({
    model_sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "models", "pass_risk.cbm"))).digest("hex"),
    card_sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "models", "model_card.json"))).digest("hex"),
  }));
  pin();
  let version = 1;
  return {
    dir,
    setMode(mode) {
      const f = path.join(dir, "MODE");
      if (mode) fs.writeFileSync(f, mode);
      else fs.rmSync(f, { force: true });
    },
    calls() {
      const f = path.join(dir, "CALLS");
      return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
    },
    retrain() {
      version++;
      // A different file (and time) is a new model to the portal.
      fs.writeFileSync(path.join(dir, "models", "pass_risk.cbm"), `model v${version}`);
      pin();
    },
    remove() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
