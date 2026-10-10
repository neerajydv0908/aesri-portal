/**
 * Where Stud-AI is on this server, and what model it has.
 *
 *   STUD_AI_DIR      the Stud-AI folder (with stud_ai/ and models/pass_risk.cbm).
 *                    Empty: no estimates; the portal works without them.
 *   STUD_AI_PYTHON   the Python to run it with. Default: the folder's own
 *                    .venv (or .venv.nosync), otherwise python3.
 *   STUD_AI_TIMEOUT_SECONDS  how long one run may take (default 30).
 *
 * No "server-only" import, so the unit tests and start-up checks can use it.
 *
 * The files are outside the portal, at paths only known when it runs: the
 * `turbopackIgnore` comments stop the build from copying the whole project
 * into its server output to cover them.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONTRACT } from "./contract";

type Env = Record<string, string | undefined>;

export const MODEL_FILE = path.join("models", "pass_risk.cbm");
export const CARD_FILE = path.join("models", "model_card.json");

/** The Stud-AI folder, or null when Stud-AI isn't set up on this server. */
export function studAiDir(env: Env = process.env): string | null {
  const dir = env.STUD_AI_DIR?.trim();
  return dir ? path.resolve(dir) : null;
}

export function studAiConfigured(env: Env = process.env): boolean {
  return studAiDir(env) !== null;
}

/** The Python that runs Stud-AI: STUD_AI_PYTHON, else the folder's virtual environment, else python3. */
export function studAiPython(dir: string, env: Env = process.env): string {
  const set = env.STUD_AI_PYTHON?.trim();
  if (set) return set;
  for (const venv of [".venv", ".venv.nosync"]) {
    for (const bin of [path.join(venv, "bin", "python"), path.join(venv, "Scripts", "python.exe")]) {
      const p = path.join(dir, bin);
      if (fs.existsSync(/*turbopackIgnore: true*/ p)) return p;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

/** How long one run may take, in milliseconds (5 s to 10 minutes; default 30 s). */
export function studAiTimeoutMs(env: Env = process.env): number {
  const n = Number(env.STUD_AI_TIMEOUT_SECONDS?.trim() || 30);
  return Math.round(Math.min(600, Math.max(5, Number.isFinite(n) ? n : 30)) * 1000);
}

/** What is wrong with the Stud-AI settings, in words, or null when they look right (or Stud-AI isn't set up). */
export function studAiConfigProblem(env: Env = process.env): string | null {
  const dir = studAiDir(env);
  if (!dir) return null;
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir) || !fs.statSync(/*turbopackIgnore: true*/ dir).isDirectory()) return `STUD_AI_DIR is ${dir}, but there is no folder there.`;
  const batch = path.join(dir, "stud_ai", "batch.py");
  if (!fs.existsSync(/*turbopackIgnore: true*/ batch)) return `STUD_AI_DIR (${dir}) isn't a Stud-AI folder: stud_ai/batch.py is missing.`;
  const model = path.join(dir, MODEL_FILE);
  if (!fs.existsSync(/*turbopackIgnore: true*/ model)) return `Stud-AI has no trained model yet (${model}). Run: python -m stud_ai.train`;
  const py = studAiPython(dir, env);
  if (path.isAbsolute(py) && !fs.existsSync(/*turbopackIgnore: true*/ py)) return `STUD_AI_PYTHON is ${py}, but there is no program there.`;
  try { verifiedArtifacts(dir, env); } catch { return "Stud-AI model integrity configuration is invalid."; }
  return null;
}

/** The trust anchor is supplied by the deployment, never learned from the weights. */
export function trustedPins(dir: string, env: Env = process.env): { model_sha256: string; card_sha256: string } {
  let model = env.STUD_AI_MODEL_SHA256;
  let card = env.STUD_AI_CARD_SHA256;
  if (!model && !card && env.NODE_ENV !== "production") {
    const pins = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ path.join(dir, "stud_ai", "trusted_artifacts.json"), "utf8"));
    model = pins.model_sha256;
    card = pins.card_sha256;
  }
  if (typeof model !== "string" || typeof card !== "string" || !/^[a-f0-9]{64}$/.test(model) || !/^[a-f0-9]{64}$/.test(card)) {
    throw new Error("Trusted STUD_AI_MODEL_SHA256 and STUD_AI_CARD_SHA256 pins are required.");
  }
  return { model_sha256: model, card_sha256: card };
}

export function verifiedArtifacts(dir: string, env: Env = process.env) {
  const pins = trustedPins(dir, env);
  const weights = fs.readFileSync(/*turbopackIgnore: true*/ path.join(dir, MODEL_FILE));
  const card = fs.readFileSync(/*turbopackIgnore: true*/ path.join(dir, CARD_FILE));
  for (const [bytes, expected] of [[weights, pins.model_sha256], [card, pins.card_sha256]] as const) {
    const actual = crypto.createHash("sha256").update(bytes).digest();
    if (!crypto.timingSafeEqual(actual, Buffer.from(expected, "hex"))) throw new Error("Stud-AI artifact integrity verification failed; inference was refused.");
  }
  return { pins, card };
}

/** Verified model AND card, and the contract, invalidate cached estimates. */
export function modelFingerprint(dir: string, env: Env = process.env): string | null {
  try {
    const { pins } = verifiedArtifacts(dir, env);
    return crypto.createHash("sha256").update(JSON.stringify([CONTRACT, pins])).digest("hex");
  } catch { return null; }
}

export type ModelCard = {
  version: string | null;
  created: string | null;
  trees: number | null;
  subjects: string[];
  /** Test-set results, all subjects, all tests known (if the model was tested). */
  test: { students: number | null; rocAuc: number | null; accuracy: number | null; recall: number | null; precision: number | null } | null;
  byTestSubject: { subject: string; rocAuc: number | null }[];
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** What the model is, from its card (models/model_card.json), or null when there is none. */
export function readModelCard(dir: string): ModelCard | null {
  try {
    const { card } = verifiedArtifacts(dir);
    {
      const c = obj(JSON.parse(card.toString("utf8")));
      const test = obj(c.test);
      const t = c.test ? obj(test.all_subjects_5_tests) : null;
      return {
        version: str(obj(c.versions).stud_ai),
        created: str(c.created),
        trees: num(c.trees),
        subjects: Array.isArray(c.subjects_trained_on) ? c.subjects_trained_on.filter((s): s is string => typeof s === "string") : [],
        test: t ? { students: num(test.students), rocAuc: num(t.roc_auc), accuracy: num(t.accuracy), recall: num(t.recall), precision: num(t.precision) } : null,
        byTestSubject: Array.isArray(test.by_subject_5_tests) ? test.by_subject_5_tests.map((s) => ({ subject: String(obj(s).subject ?? ""), rocAuc: num(obj(s).roc_auc) })) : [],
      };
    }
  } catch {
    return null;
  }
}
