/** Small pieces shared by the import pages: status badges and the list of problems. */
import { CircleCheck, CircleDashed, CircleX, Hourglass } from "lucide-react";
import { Badge } from "@/components/ui";
import type { BatchSummary, ImportIssue } from "@/lib/services/import";

const ic = "h-3.5 w-3.5";

export function ImportStatusBadge({ status, summary }: { status: string; summary: BatchSummary | null }) {
  if (status === "imported") {
    return (
      <Badge tone="green">
        <CircleCheck className={ic} aria-hidden />
        Imported
      </Badge>
    );
  }
  if (status === "previewed") {
    return summary?.errors ? (
      <Badge tone="red">
        <CircleX className={ic} aria-hidden />
        Has problems to fix
      </Badge>
    ) : (
      <Badge tone="amber">
        <Hourglass className={ic} aria-hidden />
        Waiting for confirmation
      </Badge>
    );
  }
  return (
    <Badge tone="grey">
      <CircleDashed className={ic} aria-hidden />
      {summary?.errors ? "Not imported (had problems)" : "Discarded"}
    </Badge>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

/** "600 students, 40 staff" / "412 new students, 20 updated…" for a batch. */
export function batchResultText(status: string, s: BatchSummary | null): string {
  if (!s) return "—";
  if (status === "imported" && s.result) {
    const r = s.result;
    const parts = [
      r.studentsNew ? plural(r.studentsNew, "student added", "students added") : null,
      r.studentsUpdated ? plural(r.studentsUpdated, "student updated", "students updated") : null,
      r.staffNew ? plural(r.staffNew, "member of staff added", "staff added") : null,
      r.staffUpdated ? plural(r.staffUpdated, "member of staff updated", "staff updated") : null,
    ].filter(Boolean);
    return parts.length ? parts.join(", ") : "No changes were needed";
  }
  const read = `${plural(s.rows.students, "student", "students")} and ${plural(s.rows.staff, "member of staff", "staff")} in the file`;
  return s.errors ? `${read}; ${plural(s.errors, "problem", "problems")} to fix` : read;
}

/**
 * Problems or warnings, as Excel shows them: sheet, row, column. A list rather
 * than a table, so each problem reads in full on a phone; on wider screens
 * the parts line up in columns.
 */
export function IssueList({ issues, caption, limit = 200 }: { issues: ImportIssue[]; caption: string; limit?: number }) {
  const shown = issues.slice(0, limit);
  const cols = "md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(0,1fr)] md:gap-5";
  return (
    <>
      <div className="card overflow-hidden">
        <div aria-hidden className={`hidden border-b border-forest-900/10 bg-cream-200/50 px-6 py-3 text-[0.74rem] font-bold uppercase tracking-[0.1em] text-muted md:grid ${cols}`}>
          <span>Where</span>
          <span>Problem</span>
          <span>How to fix it</span>
        </div>
        <ol aria-label={caption} className="divide-y divide-forest-900/[0.06]">
          {shown.map((i, n) => (
            <li key={n} className={`grid gap-1.5 px-5 py-4 md:px-6 ${cols}`}>
              <div>
                <p className="font-semibold text-forest-900">
                  {i.sheet === "File" ? "The whole file" : `${i.sheet} sheet`}
                  {i.row !== null && i.row > 1 ? <span className="tabular">, row {i.row}</span> : i.row === 1 ? ", headings (row 1)" : ""}
                </p>
                {i.column ? (
                  <p className="text-[0.85rem] text-muted">
                    {i.column}
                    {i.letter ? <span className="tabular"> · column {i.letter}</span> : null}
                  </p>
                ) : null}
              </div>
              <p className="text-forest-900">{i.problem}</p>
              <p className="text-[0.92rem] text-muted">
                <span className="font-semibold md:sr-only">How to fix it: </span>
                {i.fix ?? "—"}
              </p>
            </li>
          ))}
        </ol>
      </div>
      {issues.length > shown.length ? (
        <p className="mt-2 text-[0.9rem] text-muted">
          Showing the first {shown.length} of {issues.length.toLocaleString("en-IN")}. Fix these and upload the file again to see the rest.
        </p>
      ) : null}
    </>
  );
}
