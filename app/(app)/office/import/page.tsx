import type { Metadata } from "next";
import Link from "next/link";
import { Download, FileSpreadsheet, ShieldAlert } from "lucide-react";
import { officePage } from "@/lib/page";
import { getDb } from "@/lib/db/client";
import { getSchool } from "@/lib/queries/school";
import { formatDateTime } from "@/lib/dates";
import { peopleByAccount } from "@/lib/services/attendance";
import { discardExpiredPreviews, IMPORT_LIMITS, PREVIEW_HOURS, recentBatches, TEMPLATE_FILES, type BatchSummary } from "@/lib/services/import";
import { mayManageAdminAccess } from "@/lib/services/staff";
import { Alert, buttonClasses, Card, CardTitle, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { Flash } from "@/components/flash";
import { ExcelUploadForm } from "@/components/setup/upload-form";
import { batchResultText, ImportStatusBadge } from "@/components/setup/import-status";
import { uploadImportAction } from "./actions";

export const metadata: Metadata = { title: "Import from Excel" };

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ done?: string }> }) {
  const ctx = await officePage();
  const sp = await searchParams;
  const db = await getDb();
  // Previews nobody confirmed within a day are thrown away, with the rows they held.
  await db.transaction((tx) => discardExpiredPreviews(tx));
  const [school, batches] = await Promise.all([getSchool(ctx.schoolId), recentBatches(ctx.schoolId)]);
  const people = await peopleByAccount(batches.map((b) => b.createdBy));
  const template = school ? TEMPLATE_FILES[school.loginPrefix] : undefined;
  const waiting = batches.filter((b) => b.status === "previewed");
  const adminLocked = !mayManageAdminAccess(ctx.actor.role);

  return (
    <>
      <PageHeader
        eyebrow={`School office · Session ${ctx.sessionId}`}
        title="Import from Excel"
        description="Add or update students and staff in one go, from the portal's Excel template. Nothing changes until you have checked the preview and confirmed it."
      />
      <Flash code={sp.done} messages={{ discarded: "The preview was discarded. Nothing was imported, and the rows it held were deleted." }} />

      {waiting.length ? (
        <Alert tone="amber" title={waiting.length === 1 ? "A preview is waiting for confirmation" : `${waiting.length} previews are waiting for confirmation`} className="mb-6">
          <ul className="mt-1 grid gap-1">
            {waiting.map((b) => (
              <li key={b.id}>
                <Link href={`/office/import/${b.id}`} className="inline-flex min-h-8 items-center font-semibold text-forest-800 underline underline-offset-2">
                  {b.fileName}
                </Link>{" "}
                <span className="text-muted">
                  uploaded by {people.get(b.createdBy)?.name ?? "someone"}, {formatDateTime(b.createdAt)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1">Previews are deleted after {PREVIEW_HOURS} hours if nobody confirms them.</p>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>1. Fill in the template</CardTitle>
          <ol className="grid list-decimal gap-2 pl-5 text-forest-900 marker:font-semibold marker:text-forest-700">
            <li>Download {school ? `${school.name}’s` : "the"} template below. Each school has its own file.</li>
            <li>
              Fill in the <strong>Students</strong> sheet from the SR register (current students only) and the <strong>Staff</strong> sheet from the staff register. The
              first sheet, “How to fill”, explains each column in English and Hindi.
            </li>
            <li>Watch the green Check column: it says OK when a row is complete.</li>
            <li>Don&rsquo;t rename the sheets or change the headings in row 1.</li>
            <li>
              To update people already in the portal, use the same SR No. or employee No. Only filled cells change anything; an empty cell never erases what is
              already saved.
            </li>
            <li>
              In &ldquo;Subjects taught&rdquo;, write the subjects as the school calls them, separated by commas. Short forms such as Maths, EVS or SST are understood;
              a subject the school doesn&rsquo;t have yet is added to its list (the preview shows which).
            </li>
            {adminLocked ? (
              <li>
                Only the AESRI administrator can add a principal or an office admin, or change anyone&rsquo;s access to or from those. Keep the principal&rsquo;s and
                office admins&rsquo; rows as they are in the portal.
              </li>
            ) : null}
          </ol>
          {template ? (
            <a href={template} download className={buttonClasses("secondary", "md", "mt-5")}>
              <Download className="h-4 w-4" aria-hidden />
              <span>
                Download the template<span className="sr-only"> for {school?.name}</span> (.xlsx)
              </span>
            </a>
          ) : (
            <p className="mt-5 text-muted">There is no template for this school yet. Please ask the AESRI administrator.</p>
          )}
          <p className="mt-5 flex gap-2 text-[0.9rem] text-muted">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-ochre-600" aria-hidden />
            <span>
              The filled file holds children&rsquo;s personal details. Keep it on the office computer, don&rsquo;t share it on WhatsApp, and delete extra copies once it
              is imported. Don&rsquo;t add Aadhaar numbers, caste, bank or health details.
            </span>
          </p>
        </Card>

        <Card>
          <CardTitle>2. Upload it and check the preview</CardTitle>
          <ExcelUploadForm action={uploadImportAction} maxBytes={IMPORT_LIMITS.fileBytes} />
        </Card>
      </div>

      <section className="mt-10" aria-labelledby="recent-imports">
        <h2 id="recent-imports" className="mb-4 font-display text-[1.35rem] text-forest-900">
          Recent imports
        </h2>
        {batches.length ? (
          <Table caption="Recent imports, newest first">
            <thead>
              <tr>
                <Th>Uploaded</Th>
                <Th>File</Th>
                <Th>By</Th>
                <Th>Status</Th>
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const summary = (b.summary as BatchSummary | null) ?? null;
                return (
                  <tr key={b.id}>
                    <Td className="whitespace-nowrap text-[0.92rem]">{formatDateTime(b.createdAt)}</Td>
                    <Td className="max-w-64">
                      <Link href={`/office/import/${b.id}`} className="inline-flex min-h-8 items-center font-semibold break-all text-forest-800 underline-offset-2 hover:underline">
                        {b.fileName}
                      </Link>
                    </Td>
                    <Td className="whitespace-nowrap text-[0.92rem]">{people.get(b.createdBy)?.name ?? "—"}</Td>
                    <Td>
                      <ImportStatusBadge status={b.status} summary={summary} />
                    </Td>
                    <Td className="min-w-56 text-[0.92rem]">{batchResultText(b.status, summary)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <EmptyState icon={<FileSpreadsheet className="h-5 w-5" aria-hidden />} title="No imports yet">
            Files you upload appear here, with what was imported.
          </EmptyState>
        )}
      </section>
    </>
  );
}
