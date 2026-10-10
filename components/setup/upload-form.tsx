"use client";

/**
 * The upload form for the Excel import. The file is checked in the browser
 * first (type and size), so a wrong or oversized file is caught before it
 * is sent; the server checks everything again.
 */
import { useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { ActionForm, useFormResult } from "@/components/forms";
import { Field, describedBy } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import type { FormState } from "@/lib/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

function FileField({ maxBytes, label }: { maxBytes: number; label: string }) {
  const result = useFormResult();
  const [problem, setProblem] = useState<string | null>(null);
  // The server's message about the file stops applying once another file is chosen.
  const [seen, setSeen] = useState<FormState>(undefined);
  const error = problem ?? (result !== seen ? result?.fields?.file : null) ?? null;
  const maxMb = Math.round(maxBytes / 1024 / 1024);
  return (
    <Field label={label} htmlFor="import-file" hint={`The portal's template, saved as an Excel workbook (.xlsx), up to ${maxMb} MB.`} error={error} required>
      <input
        id="import-file"
        name="file"
        type="file"
        required
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        {...describedBy("import-file", error, true)}
        onChange={(e) => {
          const input = e.currentTarget;
          const f = input.files?.[0];
          setSeen(result);
          if (!f) return setProblem(null);
          if (/\.(xls|xlsm|xlsb|csv|ods)$/i.test(f.name)) {
            input.value = "";
            return setProblem("This isn't an Excel Workbook (.xlsx). Open it in Excel, use File → Save As → “Excel Workbook (.xlsx)”, and choose that file.");
          }
          if (!/\.xlsx$/i.test(f.name)) {
            input.value = "";
            return setProblem("Choose the filled-in template: an Excel workbook ending in .xlsx.");
          }
          if (f.size > maxBytes) {
            input.value = "";
            return setProblem(`This file is ${(f.size / 1024 / 1024).toFixed(1)} MB; the limit is ${maxMb} MB. Use the portal's template with only the Students and Staff sheets filled in.`);
          }
          setProblem(null);
        }}
        className="block w-full min-h-12 cursor-pointer rounded-xl bg-cream-50 text-[0.95rem] text-ink ring-1 ring-forest-900/15 file:mr-3 file:min-h-12 file:cursor-pointer file:rounded-l-xl file:border-0 file:bg-forest-800 file:px-4 file:font-semibold file:text-cream-50 hover:file:bg-forest-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-forest-700 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-clay-500"
      />
    </Field>
  );
}

export function ExcelUploadForm({ action, maxBytes, label = "Filled-in Excel file", submitLabel = "Upload and check" }: { action: Action; maxBytes: number; label?: string; submitLabel?: string }) {
  return (
    <ActionForm action={action} className="gap-4" aria-label="Upload the Excel file">
      <FileField maxBytes={maxBytes} label={label} />
      <div>
        <SubmitButton pendingLabel="Checking the file…">
          <FileSpreadsheet className="h-4 w-4" aria-hidden />
          {submitLabel}
        </SubmitButton>
      </div>
      <p className="text-[0.88rem] text-muted">Nothing is saved to anyone&rsquo;s record yet: you&rsquo;ll see a preview first.</p>
    </ActionForm>
  );
}
