import { auditLog } from "@/lib/db/schema";
import type { Tx } from "@/lib/db/client";

export type AuditActor = { accountId: string | null; loginId: string | null; ip?: string | null };

/** Record who did what. Written inside the same transaction as the change. */
export async function audit(
  tx: Tx,
  actor: AuditActor,
  action: string,
  opts: { schoolId?: string | null; targetType?: string; targetId?: string; details?: Record<string, unknown> } = {},
): Promise<void> {
  await tx.insert(auditLog).values({
    actorId: actor.accountId,
    actorLogin: actor.loginId,
    ip: actor.ip ?? null,
    schoolId: opts.schoolId ?? null,
    action,
    targetType: opts.targetType ?? null,
    targetId: opts.targetId ?? null,
    details: opts.details ?? null,
  });
}
