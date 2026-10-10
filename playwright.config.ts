/**
 * Browser tests: `npm run test:e2e`. They start a development server on
 * port 3100 with a fresh fictional demo database (.data/e2e-db), so they
 * never touch real data.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, ...devices["Desktop Chrome"], channel: process.env.E2E_BROWSER_CHANNEL, trace: "retain-on-failure" },
  webServer: {
    command: `node tests/e2e/start-server.mjs ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
  },
});
