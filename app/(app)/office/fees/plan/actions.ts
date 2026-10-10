"use server";

import { refresh } from "next/cache";
import { auditActor } from "@/lib/auth/dal";
import { getDb } from "@/lib/db/client";
import { officePage } from "@/lib/page";
import { FEE_ROLES, OFFICE_ROLES } from "@/lib/roles";
import { done, fail, type FormState } from "@/lib/forms";
import { str } from "@/lib/validation";
import { failKeeping } from "@/components/fees/remember";
import { isValidIsoDate } from "@/lib/dates";
import { changeInstalmentSplit, currentPlan, PaymentError } from "@/lib/services/fees";

/** Administrators only, and only before any payment of the session: change the instalment split and due dates. */
export async function changeSplitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { actor, schoolId, sessionId } = await officePage(FEE_ROLES);
  if (!OFFICE_ROLES.includes(actor.role)) return fail("Only the principal or the office administrator can change the instalments.");
  const db = await getDb();
  const plan = await currentPlan(db, schoolId);
  if (!plan) return fail("This school has no fee plan.");

  const fields: Record<string, string> = {};
  const instalments = plan.instalments.map((ins) => {
    const pct = str(formData, `percent:${ins.id}`);
    const due = str(formData, `due:${ins.id}`);
    if (!/^\d{1,3}$/.test(pct) || Number(pct) < 1 || Number(pct) > 100) fields[`percent:${ins.id}`] = "A whole number from 1 to 100";
    if (!isValidIsoDate(due)) fields[`due:${ins.id}`] = "Choose a date";
    return { id: ins.id, percent: Number(pct), dueOn: due };
  });
  if (Object.keys(fields).length) return failKeeping(formData, "Please check the highlighted fields.", fields);

  const who = await auditActor(actor);
  try {
    const r = await db.transaction((tx) => changeInstalmentSplit(tx, { schoolId, sessionId, instalments }, who));
    refresh();
    return done(`Saved. Fee lines were recreated for ${r.students} ${r.students === 1 ? "student" : "students"}.`);
  } catch (err) {
    if (err instanceof PaymentError) return failKeeping(formData, err.message);
    throw err;
  }
}
