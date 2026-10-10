import { getDb } from "@/lib/db/client";
import type { BatchRequest } from "./contract";
import { consumeInferenceQuota } from "./quota";
import { runStudAi, type RunResult } from "./runner";

/** Call only with the account ID resolved by the authenticated page/action.
 * Every application inference entry point goes through this admission check.
 */
export async function runStudAiForAccount(request: BatchRequest, accountId: string): Promise<RunResult> {
  try {
    if (!await consumeInferenceQuota(await getDb(), accountId)) {
      return { ok: false, error: "Your inference limit has been reached. Please try again after the current minute or daily window ends.", ms: 0, limited: true };
    }
  } catch {
    return { ok: false, error: "Inference admission is unavailable. Please try again later.", ms: 0, limited: true };
  }
  return runStudAi(request);
}
