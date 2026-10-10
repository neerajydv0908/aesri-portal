/**
 * Runs once when the portal's server starts (Next.js instrumentation hook).
 * The checks live in instrumentation-node.ts, which only the Node.js server
 * loads (Next.js also compiles this file for its Edge runtime).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
