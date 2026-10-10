/**
 * What is waiting for the signed-in person, for the red dots on the menu
 * (components/shell/nav-counts.tsx reads it as people move around). Only the
 * principal, office admins and AESRI administrators get a count: the cash
 * payments families recorded that wait for their approval. A route handler
 * does its own access check (no redirects), and reading it doesn't extend
 * the session (peekActor).
 */
import { isAdminRole, officeSchoolId, peekActor } from "@/lib/auth/dal";
import { getDb } from "@/lib/db/client";
import { OFFICE_ROLES } from "@/lib/roles";
import { waitingClaimCount } from "@/lib/services/cash-claims";
import type { NavCounts } from "@/components/shell/nav";

export const dynamic = "force-dynamic";

const answer = (body: NavCounts, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET() {
  // Asked by the page itself, every minute: never counts as activity, so an open tab doesn't keep the session alive.
  const actor = await peekActor();
  if (!actor || (isAdminRole(actor.role) && !actor.mfaPassed)) return answer({}, 401);
  if (!OFFICE_ROLES.includes(actor.role) || (actor.role !== "super_admin" && !actor.schoolId)) return answer({});
  const schoolId = await officeSchoolId(actor);
  return answer({ cashToApprove: await waitingClaimCount(await getDb(), schoolId) });
}
