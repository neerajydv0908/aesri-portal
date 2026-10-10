/**
 * CSV download of the collections report: every receipt and refund in the
 * period (at most a year, collections/range.ts), however many, then the
 * totals. "Amount (Rs)" is what each entry counts: refunds negative, and 0 for
 * a cancelled receipt or refund (its amount is in "Cancelled amount (Rs)"), so
 * adding up the entries' amounts gives the net received. A route handler does
 * its own access check (no redirects): 403 for anyone who may not see fees,
 * 404 when the account has no school.
 */
import { auditActor, getActor, isAdminRole, officeSchoolId } from "@/lib/auth/dal";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db/client";
import { getSchool } from "@/lib/queries/school";
import { FEE_ROLES } from "@/lib/roles";
import { sectionLabel } from "@/lib/classes";
import { collectionRows, collectionTotals, METHOD_LABELS } from "@/lib/services/fees";
import { REFUND_METHOD_LABELS } from "@/lib/services/refunds";
import { collectionRange } from "../range";

export const dynamic = "force-dynamic";

/** Quote a CSV cell, and stop spreadsheet programs from treating text as a formula. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** An amount in rupees: only digits, a point and (for refunds) a leading minus, so spreadsheets read it as a number. */
function amountCell(paise: number): string {
  return (paise / 100).toFixed(2);
}

const deny = (status: 403 | 404) =>
  new Response(status === 403 ? "You don't have access to fee reports." : "Not found.", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor || !FEE_ROLES.includes(actor.role)) return deny(403);
  if (isAdminRole(actor.role) && !actor.mfaPassed) return deny(403);
  if (actor.role !== "super_admin" && !actor.schoolId) return deny(404);
  const schoolId = await officeSchoolId(actor);

  const url = new URL(request.url);
  const { from, to, includeOpening } = collectionRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to"), opening: url.searchParams.get("opening") });
  const db = await getDb();
  const [{ rows }, totals, school] = await Promise.all([collectionRows(db, schoolId, from, to, includeOpening), collectionTotals(db, schoolId, from, to, includeOpening), getSchool(schoolId)]);
  if (!school) return deny(404);

  const header = ["Type", "Receipt no.", "Refund voucher", "Date", "Student", "SR No.", "Class", "Paid by", "Reference", "Gateway ID", "Amount (Rs)", "Cancelled amount (Rs)", "Status", "Note", "Received or given back by"];
  const lines = rows.map((r) => {
    const refund = r.kind === "refund";
    const cells = [
      refund ? "Refund" : "Receipt",
      r.receiptNo,
      r.voucherNo,
      r.paidOn,
      r.studentName,
      r.srNo,
      r.className ? sectionLabel(r.className, r.sectionName ?? "") : "",
      refund ? (REFUND_METHOD_LABELS[r.method as keyof typeof REFUND_METHOD_LABELS]?.en ?? r.method) : METHOD_LABELS[r.method].en,
      r.method === "online" && !refund ? "" : r.reference,
      r.providerId,
    ].map(cell);
    const cancelled = r.status === "reversed";
    const after = [
      refund ? (cancelled ? "Refund cancelled" : "Refunded") : cancelled ? "Cancelled" : "Completed",
      r.note,
      refund ? (r.recordedByName ?? (r.method === "online" ? "Razorpay" : "")) : r.method === "online" ? "Paid online" : r.recordedByName,
    ].map(cell);
    const counted = cancelled ? 0 : refund ? -r.amount : r.amount;
    return [...cells, amountCell(counted), cancelled ? amountCell(refund ? -r.amount : r.amount) : "", ...after].join(",");
  });
  const total = (label: string, paise: number) => [...["", "", "", "", "", "", "", "", "", label].map(cell), amountCell(paise), "", "", "", ""].join(",");
  lines.push(total("Total received", totals.received.total));
  if (totals.refunded.count) {
    lines.push(total("Total refunded", -totals.refunded.total));
    lines.push(total("Net received", totals.net));
  }
  const body = `\uFEFF${[header.map(cell).join(","), ...lines].join("\r\n")}\r\n`;

  await audit(db, await auditActor(actor), "fees.collections_exported", {
    schoolId,
    targetType: "report",
    targetId: "collections",
    details: { from, to, includeOpening, rows: rows.length },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="collections-${school.code}-${from}-to-${to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
