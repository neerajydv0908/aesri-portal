/**
 * Runs Stud-AI on this server: `python -m stud_ai.batch` in the Stud-AI
 * folder, with the request on its standard input and the answer read from
 * its standard output (lib/studai/contract.ts).
 *
 * - Nothing goes over the network, and Python gets a minimal environment:
 *   none of the portal's secrets (APP_SECRET, DATABASE_URL, payment or SMS
 *   keys) are passed on.
 * - One run at a time per server process; a run that takes longer than
 *   STUD_AI_TIMEOUT_SECONDS is stopped.
 * - It never throws: problems come back as { ok: false, error } in words.
 *
 * No "server-only" import, so the unit tests can run it with a stand-in.
 */
import { spawn } from "node:child_process";
import { CONTRACT, parseResponse, type BatchRequest, type BatchResponse } from "./contract";
import { studAiConfigProblem, studAiDir, studAiPython, studAiTimeoutMs, trustedPins } from "./config";

export type RunResult = { ok: true; response: BatchResponse; ms: number } | { ok: false; error: string; ms: number; limited?: boolean };

const MAX_STDOUT = 64 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

/** The environment Python gets: enough to run, nothing secret. */
export function pythonEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const keep: Record<string, string> = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    // Don't write __pycache__ folders into the Stud-AI folder (it may be read-only on the server).
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  };
  for (const k of ["HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"]) {
    const v = env[k];
    if (v) keep[k] = v;
  }
  return keep;
}

let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
export const MAX_PENDING = 8;

/** Run one request through Stud-AI (waits for any run already going in this process). */
export function runStudAi(request: BatchRequest, opts: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<RunResult> {
  if (pending >= MAX_PENDING) return Promise.resolve({ ok: false, error: "Stud-AI is busy. Please try again shortly.", ms: 0 });
  pending++;
  const next = queue.then(() => runOnce(request, opts)).catch((): RunResult => ({ ok: false, error: "Stud-AI could not verify or process the request.", ms: 0 })).finally(() => { pending--; });
  queue = next.catch(() => undefined);
  return next;
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return (lines[lines.length - 1] ?? "").replace(/^stud-ai:\s*/, "").slice(0, 400);
}

async function runOnce(request: BatchRequest, opts: { timeoutMs?: number; env?: Record<string, string | undefined> }): Promise<RunResult> {
  const env = opts.env ?? process.env;
  const started = Date.now();
  const fail = (error: string): RunResult => ({ ok: false, error, ms: Date.now() - started });
  const dir = studAiDir(env);
  if (!dir) return fail("Stud-AI isn't set up on this server (STUD_AI_DIR is empty).");
  const problem = studAiConfigProblem(env);
  if (problem) return fail(problem);
  if (request.contract !== CONTRACT) return fail(`The portal speaks contract ${request.contract}, but this code expects ${CONTRACT}.`);
  const pins = trustedPins(dir, env);
  const childEnv = { ...pythonEnv(env), STUD_AI_MODEL_SHA256: pins.model_sha256, STUD_AI_CARD_SHA256: pins.card_sha256, STUD_AI_PRODUCTION: env.NODE_ENV === "production" ? "1" : "0" };
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 2 * 1024 * 1024) return fail("Stud-AI request exceeds the 2 MiB limit.");
  const python = studAiPython(dir, env);
  const timeoutMs = opts.timeoutMs ?? studAiTimeoutMs(env);

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const out: Buffer[] = [];
    let outSize = 0;
    let err = "";
    let child: ReturnType<typeof spawn>;
    try {
      // (Node's types want NODE_ENV in any environment; Python doesn't need it, so it isn't passed.)
      child = spawn(python, ["-m", "stud_ai.batch"], { cwd: dir, env: childEnv as unknown as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      finish(fail(`Python couldn't be started (${python}): ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      const secs = Math.round(timeoutMs / 1000);
      finish(fail(`Stud-AI took longer than ${secs} ${secs === 1 ? "second" : "seconds"} and was stopped. Try again, or raise STUD_AI_TIMEOUT_SECONDS.`));
    }, timeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => {
      finish(
        fail(
          e.code === "ENOENT"
            ? `Python wasn't found (${python}). Install Python 3.10+ and Stud-AI's packages, or set STUD_AI_PYTHON to the right Python.`
            : `Python couldn't be started (${python}): ${e.message}`,
        ),
      );
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize > MAX_STDOUT) {
        child.kill("SIGKILL");
        finish(fail("Stud-AI's answer was far too long and was refused."));
        return;
      }
      out.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      err = (err + chunk.toString("utf8")).slice(-MAX_STDERR);
    });
    child.stdin!.on("error", () => {
      // Python ended before reading everything (it says why on stderr; handled on close).
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 2) return finish(fail(`Stud-AI refused the request: ${lastLine(err) || "no reason given"}`));
      if (code === 3) return finish(fail(`Stud-AI has no trained model: ${lastLine(err) || "run python -m stud_ai.train"}`));
      if (code !== 0) {
        const why = lastLine(err);
        if (/No module named/.test(err)) return finish(fail(`Stud-AI's Python packages are missing (${why}). Run: pip install -r requirements.txt in the Stud-AI folder.`));
        return finish(fail(`Stud-AI stopped with an error${why ? `: ${why}` : ` (exit code ${code})`}.`));
      }
      try {
        const response = parseResponse(JSON.parse(Buffer.concat(out).toString("utf8")));
        if (response.model.file_sha256 !== pins.model_sha256 || response.model.card_sha256 !== pins.card_sha256) return finish(fail("Stud-AI answered with unverified artifacts."));
        finish({ ok: true, response, ms: Date.now() - started });
      } catch (e) {
        finish(fail(e instanceof SyntaxError ? "Stud-AI's answer wasn't valid JSON." : e instanceof Error ? e.message : String(e)));
      }
    });
    child.stdin!.end(payload, "utf8");
  });
}
