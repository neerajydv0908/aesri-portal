// Fresh demo database, then the development server (used by playwright.config.ts).
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = process.argv[2] ?? "3100";
const dir = path.join(process.cwd(), ".data", "e2e-db");
fs.rmSync(dir, { recursive: true, force: true });
const env = { ...process.env, PGLITE_DIR: dir, APP_URL: `http://localhost:${port}`, DATABASE_URL: "", APP_SECRET: "e2e-only-not-a-real-secret-".repeat(3), SMS_WORKER: "off", SMS_PROVIDER: "log", PAYMENT_PROVIDER: "mock" };
execSync("npx tsx scripts/demo.ts", { stdio: "inherit", env });
const server = spawn("npx", ["next", "dev", "--port", port], { stdio: "inherit", env });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill(sig));
server.on("exit", (code) => process.exit(code ?? 0));
