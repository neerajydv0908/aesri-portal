"use server";

import { notFound, redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/lib/db/client";
import { auditActor } from "@/lib/auth/dal";
import { fail, type FormState } from "@/lib/forms";
import { officePage } from "@/lib/page";
import { todayIST } from "@/lib/dates";
import { str } from "@/lib/validation";
import { RecordError } from "@/lib/services/students";
import { pgErrorCode } from "@/lib/services/classes";
import { mayManageAdminAccess } from "@/lib/services/staff";
import {
  applyImport,
  checkWorkbook,
  discardBatch,
  getBatch,
  IMPORT_LIMITS,
  ImportFileError,
  ImportStateError,
  importReference,
  isExpired,
  planImport,
  readWorkbook,
  savePreview,
} from "@/lib/services/import";

/** The name to show for an uploaded file: no folders, no control characters, not too long. */
function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return (clean || "upload.xlsx").slice(-120);
}

const MB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** Read and check an uploaded file, keep it as a preview, and open the preview. */
export async function uploadImportAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await officePage();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0 || !file.name) {
    return fail("Choose the filled-in Excel file first.", { file: "Choose the Excel file (.xlsx) to upload." });
  }
  const fileName = cleanFileName(file.name);
  if (/\.(xls|xlsm|xlsb|csv|ods)$/i.test(fileName)) {
    const msg = "This isn't an Excel Workbook (.xlsx). Open it in Excel, use File → Save As → “Excel Workbook (.xlsx)”, and upload that file.";
    return fail(msg, { file: msg });
  }
  if (!/\.xlsx$/i.test(fileName)) {
    return fail("Upload the portal's Excel template, saved as .xlsx.", { file: "Choose an Excel workbook (.xlsx)." });
  }
  if (file.size > IMPORT_LIMITS.fileBytes) {
    const msg = `This file is ${MB(file.size)} MB; the limit is ${MB(IMPORT_LIMITS.fileBytes)} MB. Use the portal's template with only the Students and Staff sheets filled in.`;
    return fail(msg, { file: msg });
  }

  let wb;
  try {
    wb = await readWorkbook(Buffer.from(await file.arrayBuffer()));
  } catch (err) {
    if (err instanceof ImportFileError) return fail(err.message, { file: err.message });
    throw err;
  }
  const db = await getDb();
  const ref = await importReference(db, ctx.schoolId, ctx.sessionId, todayIST(), ctx.actor.role === "super_admin");
  const checked = checkWorkbook(wb, ref);
  // Compare the readable rows with the portal's records too, so every problem shows at once.
  const plan =
    checked.students.length || checked.staff.length
      ? await planImport(db, {
          schoolId: ctx.schoolId,
          sessionId: ctx.sessionId,
          file: checked,
          actorStaffId: ctx.actor.staffId,
          mayManageAdmins: mayManageAdminAccess(ctx.actor.role),
        })
      : null;
  const who = { ...(await auditActor(ctx.actor)), accountId: ctx.actor.accountId };
  const { id } = await db.transaction((tx) =>
    savePreview(tx, { schoolId: ctx.schoolId, sessionId: ctx.sessionId, fileName, file: checked, planIssues: plan?.issues ?? [] }, who),
  );
  redirect(`/office/import/${id}`);
}

async function batchFromForm(formData: FormData) {
  const ctx = await officePage();
  const db = await getDb();
  const batch = await getBatch(db, ctx.schoolId, str(formData, "batch"));
  if (!batch) notFound();
  return { ctx, db, batch };
}

/** Import everything in a checked preview, in one go. */
export async function confirmImportAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, db, batch } = await batchFromForm(formData);
  const who = await auditActor(ctx.actor);
  const here = `/office/import/${batch.id}`;
  if (batch.status === "imported") redirect(`${here}?done=imported`);
  if (batch.status !== "previewed") redirect(here);
  if (isExpired(batch)) {
    await db.transaction((tx) => discardBatch(tx, ctx.schoolId, batch.id, who, "expired"));
    redirect(here);
  }
  try {
    await db.transaction((tx) =>
      applyImport(
        tx,
        {
          schoolId: ctx.schoolId,
          sessionId: ctx.sessionId,
          batchId: batch.id,
          expect: str(formData, "expect"),
          chargeAdmissionFee: str(formData, "admissionFee") === "yes",
          actorStaffId: ctx.actor.staffId,
          mayManageAdmins: mayManageAdminAccess(ctx.actor.role),
        },
        who,
      ),
    );
  } catch (err) {
    if (err instanceof ImportStateError) {
      if (err.reason === "imported") redirect(`${here}?done=imported`);
      if (err.reason === "expired") {
        await db.transaction((tx) => discardBatch(tx, ctx.schoolId, batch.id, who, "expired"));
        redirect(here);
      }
      refresh();
      return fail(err.message);
    }
    if (err instanceof RecordError) return fail(err.message);
    // Someone else saved some of the same records at the same moment (PostgreSQL only).
    const code = pgErrorCode(err);
    if (code === "23505" || code === "40P01" || code === "40001") {
      refresh();
      return fail("Someone else changed some of these records at the same moment, so nothing was imported. Check the preview below and confirm again.");
    }
    throw err;
  }
  redirect(`${here}?done=imported`);
}

/** Throw a preview away: nothing is imported and its rows are deleted. */
export async function discardImportAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, db, batch } = await batchFromForm(formData);
  if (batch.status !== "previewed") redirect(`/office/import/${batch.id}`);
  const who = await auditActor(ctx.actor);
  const gone = await db.transaction((tx) => discardBatch(tx, ctx.schoolId, batch.id, who, "discarded"));
  redirect(gone ? "/office/import?done=discarded" : `/office/import/${batch.id}`);
}
