import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CheckCircle2, CircleDashed } from "lucide-react";
import { officePage } from "@/lib/page";
import { OFFICE_ROLES } from "@/lib/roles";
import { getDb } from "@/lib/db/client";
import { listSections, sectionStudents } from "@/lib/queries/school";
import { openingDone, openingProgress } from "@/lib/queries/home";
import { formatDateTime, todayIST } from "@/lib/dates";
import { peopleByAccount } from "@/lib/services/attendance";
import { isRteWaiver, ledgerLinesFor, rupees, type LedgerCharge } from "@/lib/services/fees";
import { ActionForm, FieldError } from "@/components/forms";
import { Flash } from "@/components/flash";
import { Alert, Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { FilterBar, SectionField } from "@/components/pickers";
import { ColumnToggle, RememberedChoice, RememberedInput } from "@/components/fees/client";
import { markNothingPaidAction, saveOpeningAction } from "./actions";

export const metadata: Metadata = { title: "Opening balances" };

type Column = { key: string; label: string; dueOn: string; amounts: Set<number>; open: number };

/** Lines of the same kind line up in one column: "Term I", "Term II", "Admission fee". */
function columnOf(l: LedgerCharge): { key: string; label: string } {
  if (l.kind === "instalment") {
    const label = l.label.split(" — ")[0];
    return { key: `ins:${label}`, label };
  }
  return { key: l.kind, label: l.kind === "admission" ? "Admission fee" : l.label };
}

export default async function OpeningBalancesPage({ searchParams }: { searchParams: Promise<{ section?: string; done?: string }> }) {
  const { schoolId, sessionId } = await officePage(OFFICE_ROLES);
  const sp = await searchParams;
  const [sections, progress] = await Promise.all([listSections(schoolId, sessionId), openingProgress(schoolId, sessionId)]);
  // The class asked for; otherwise the first class that still needs doing, or the first with students.
  const withStudents = sections.filter((s) => s.studentCount > 0);
  const section =
    sections.find((s) => s.id === sp.section) ??
    withStudents.find((s) => !openingDone(progress, s.id)) ??
    withStudents[0] ??
    sections[0] ??
    null;
  const today = todayIST();
  // Classes with fees to bring forward, and how many of them are done (the "Getting started" step on the home page uses the same count).
  const toDo = withStudents.filter((s) => progress.needed.has(s.id));
  const doneCount = toDo.filter((s) => openingDone(progress, s.id)).length;

  const header = (
    <PageHeader
      eyebrow={
        <Link href="/office/fees" className="inline-flex min-h-6 items-center gap-1.5 hover:text-forest-900">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Fees
        </Link>
      }
      title="Opening balances"
      description="Record what families paid on paper before the portal started, one class at a time. Each saved student gets an opening receipt (OB series). Saving again never records a fee twice. Only the principal and office admins can record opening balances."
    />
  );
  if (!section) {
    return (
      <>
        {header}
        <EmptyState title="No classes yet">Classes and sections for this session appear here once they are set up.</EmptyState>
      </>
    );
  }

  const students = await sectionStudents(section.id);
  const db = await getDb();
  const linesBy = await ledgerLinesFor(
    db,
    students.map((s) => s.id),
    sessionId,
  );

  const columns = new Map<string, Column>();
  for (const s of students) {
    for (const l of linesBy.get(s.id) ?? []) {
      const c = columnOf(l);
      const col = columns.get(c.key) ?? { ...c, dueOn: l.dueOn, amounts: new Set<number>(), open: 0 };
      col.amounts.add(l.amount);
      if (!l.waived && l.outstanding > 0) col.open++;
      if (l.dueOn < col.dueOn) col.dueOn = l.dueOn;
      columns.set(c.key, col);
    }
  }
  const cols = [...columns.values()].sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const cellFor = (studentId: string, key: string) => (linesBy.get(studentId) ?? []).find((l) => columnOf(l).key === key) ?? null;

  const allLines = students.flatMap((s) => linesBy.get(s.id) ?? []);
  const open = allLines.filter((l) => !l.waived && l.outstanding > 0).length;
  const paid = allLines.filter((l) => !l.waived && l.outstanding === 0).length;
  const idx = withStudents.findIndex((s) => s.id === section.id);
  const next = withStudents.slice(idx + 1).find((s) => !openingDone(progress, s.id)) ?? (idx >= 0 ? withStudents[idx + 1] : withStudents[0]) ?? null;
  const nextLink = next ? (
    <Link href={`/office/fees/opening?section=${next.id}`} className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-forest-800 underline-offset-2 hover:underline">
      Next class: {next.label}
      <ArrowRight className="h-4 w-4" aria-hidden />
    </Link>
  ) : null;

  // Where this class stands.
  const classDone = openingDone(progress, section.id);
  const marked = progress.markedNone.get(section.id);
  const markedBy = marked?.by ? (await peopleByAccount([marked.by])).get(marked.by)?.name : null;
  const needsDoing = progress.needed.has(section.id);

  return (
    <>
      {header}
      <Flash
        code={sp.done}
        messages={{
          "nothing-paid": `${section.label} is marked as done: nobody in it paid fees on paper. If someone did after all, you can still enter it below.`,
        }}
      />

      <section aria-labelledby="progress-title" className="card mb-6 grid gap-2 p-5 sm:p-6">
        <h2 id="progress-title" className="font-display text-[1.2rem] text-forest-900">
          {toDo.length ? `Classes done: ${doneCount} of ${toDo.length}` : "No class has fees to bring forward"}
        </h2>
        <p className="max-w-3xl text-[0.92rem] text-muted">
          A class counts as done once its opening balances are saved here — or, if nobody in it paid anything on paper, once you mark it so. Families should sign in
          only after their class is done: until then, fees they paid on paper show as unpaid or overdue. “Getting started” on the home page uses the same count.
        </p>
        {toDo.length > doneCount ? (
          <p className="text-[0.92rem] text-forest-900">
            <span className="font-semibold">Still to do:</span>{" "}
            {toDo
              .filter((s) => !openingDone(progress, s.id))
              .map((s, i, list) => (
                <span key={s.id}>
                  <Link href={`/office/fees/opening?section=${s.id}`} className="inline-flex min-h-6 items-center font-semibold text-forest-800 underline underline-offset-2 tabular">
                    {s.label}
                  </Link>
                  {i < list.length - 1 ? ", " : ""}
                </span>
              ))}
          </p>
        ) : null}
      </section>

      <FilterBar submitLabel="Show class">
        <SectionField sections={sections.map((s) => ({ ...s, label: progress.needed.has(s.id) && openingDone(progress, s.id) ? `${s.label} (done)` : s.label }))} value={section.id} />
      </FilterBar>

      <p className="mb-5 flex flex-wrap items-center gap-2 text-[0.95rem] text-forest-900">
        <span className="font-semibold">{section.longLabel}:</span>
        {!students.length ? (
          <span className="text-muted">no students.</span>
        ) : !needsDoing ? (
          <Badge tone="grey">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            Nothing to bring forward
          </Badge>
        ) : classDone ? (
          <Badge tone="green">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            Done
          </Badge>
        ) : (
          <Badge tone="amber">
            <CircleDashed className="h-3.5 w-3.5" aria-hidden />
            Not done yet
          </Badge>
        )}
        {marked && !progress.saved.has(section.id) ? (
          <span className="text-[0.88rem] text-muted">
            Marked as “nobody paid on paper”{markedBy ? ` by ${markedBy}` : ""}, {formatDateTime(marked.at)}.
          </span>
        ) : null}
      </p>

      {!students.length ? (
        <EmptyState title={`No students in ${section.label}`}>
          {next ? (
            <>
              Choose another class, for example <Link href={`/office/fees/opening?section=${next.id}`} className="font-semibold underline underline-offset-2">{next.label}</Link>.
            </>
          ) : (
            "Choose another class."
          )}
        </EmptyState>
      ) : !cols.length ? (
        <EmptyState title="No fee lines in this class">The fee plan has no fee for this class, so there is nothing to bring forward.</EmptyState>
      ) : (
        <>
          <ActionForm action={saveOpeningAction} resetOnSuccess>
            <input type="hidden" name="section" value={section.id} />
            <Card className="grid gap-5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-start">
              <div className="grid gap-1.5">
                <label htmlFor="paidOn" className="text-[0.92rem] font-semibold text-forest-900">
                  Date on these receipts<span className="text-clay-600"> *</span>
                </label>
                <RememberedInput key={`d-${today}`} id="paidOn" name="paidOn" type="date" defaultValue={today} max={today} aria-describedby="paidOn-hint paidOn-error" />
                <p id="paidOn-hint" className="text-[0.85rem] text-muted">
                  Usually the day the portal started.
                </p>
                <FieldError name="paidOn" />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="reference" className="text-[0.92rem] font-semibold text-forest-900">
                  Note printed on the receipts
                </label>
                <RememberedInput id="reference" name="reference" maxLength={80} placeholder="Paid before the portal (paper receipt)" aria-describedby="reference-hint" />
                <p id="reference-hint" className="text-[0.85rem] text-muted">
                  Optional, e.g. “Paper receipt book 3”.
                </p>
              </div>
            </Card>

            {open ? (
              <Alert tone="blue">
                <strong className="font-semibold">{section.longLabel}:</strong> {paid} {paid === 1 ? "fee is" : "fees are"} already recorded as paid, {open} still open. Tick{" "}
                <em>Paid in full</em>, or type the total paid so far for a part payment. The tick box in a column heading marks the whole class.
              </Alert>
            ) : (
              <Alert tone="green" title={`Everything in ${section.label} is recorded`}>
                Every fee in this class is paid or waived. {next ? "Carry on with the next class." : "This was the last class."}
              </Alert>
            )}

            <Table caption={`Opening balances for ${section.longLabel}`}>
              <thead>
                <tr className="align-top">
                  <Th className="normal-case tracking-normal">
                    <span className="text-[0.74rem] uppercase tracking-[0.1em]">Student</span>
                  </Th>
                  {cols.map((c) => (
                    <Th key={c.key} className="min-w-[12rem]">
                      <span className="block">{c.label}</span>
                      <span className="block font-semibold normal-case tracking-normal text-forest-900 tabular">{[...c.amounts].map((a) => rupees(a)).join(" / ")}</span>
                      {c.open ? <ColumnToggle column={c.key} label="All paid in full" /> : null}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {students.map((s) => (
                  <tr key={s.id} className="align-top">
                    <Td>
                      <span className="font-semibold text-forest-900">{s.name}</span>
                      <span className="block text-[0.85rem] text-muted tabular">
                        SR {s.srNo}
                        {s.rollNo ? ` · Roll ${s.rollNo}` : ""}
                      </span>
                    </Td>
                    {cols.map((c) => {
                      const l = cellFor(s.id, c.key);
                      if (!l)
                        return (
                          <Td key={c.key} className="text-muted">
                            —
                          </Td>
                        );
                      if (l.waived) {
                        return (
                          <Td key={c.key} className="text-[0.9rem] text-muted">
                            {isRteWaiver(l.waiverNote) ? "RTE — no fee" : "Waived"}
                          </Td>
                        );
                      }
                      if (l.outstanding === 0) {
                        return (
                          <Td key={c.key}>
                            <span className="inline-flex items-center gap-1.5 font-semibold text-forest-700">
                              <CheckCircle2 className="h-4 w-4" aria-hidden />
                              Paid
                            </span>
                            <span className="block text-[0.82rem] text-muted tabular">{rupees(l.paid)}</span>
                          </Td>
                        );
                      }
                      const partId = `part-${l.id}`;
                      const field = `part:${l.id}`;
                      return (
                        <Td key={c.key}>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 font-semibold text-forest-900">
                              <RememberedChoice name="full" value={l.id} data-col={c.key} className="h-6 w-6 shrink-0 cursor-pointer accent-forest-700" />
                              <span>
                                Paid in full
                                <span className="sr-only">
                                  {" "}
                                  — {c.label}, {s.name}
                                </span>
                              </span>
                            </label>
                            <div className="flex items-center gap-2">
                              <label htmlFor={partId} className="whitespace-nowrap text-[0.85rem] text-muted">
                                or so far ₹
                                <span className="sr-only">
                                  {" "}
                                  paid for {c.label}, {s.name}
                                </span>
                              </label>
                              <div className="w-24">
                                <RememberedInput
                                  id={partId}
                                  name={field}
                                  inputMode="decimal"
                                  autoComplete="off"
                                  className="tabular"
                                  aria-describedby={l.paid > 0 ? `${field}-error ${partId}-recorded` : `${field}-error`}
                                />
                              </div>
                            </div>
                          </div>
                          {l.paid > 0 ? (
                            <span id={`${partId}-recorded`} className="mt-1 block text-[0.82rem] text-muted tabular">
                              {rupees(l.paid)} already recorded
                            </span>
                          ) : null}
                          <FieldError name={field} />
                        </Td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </Table>

            {open ? (
              <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-cream-100/95 px-1 py-3 backdrop-blur">
                <p className="text-[0.88rem] text-muted">Only the ticked and typed fees are saved. Fees already recorded are never recorded again.</p>
                <div className="ml-auto flex flex-wrap items-center gap-4">
                  {nextLink}
                  <SubmitButton size="lg" pendingLabel="Saving…">
                    Save opening balances
                  </SubmitButton>
                </div>
              </div>
            ) : (
              <p className="flex justify-end">{nextLink}</p>
            )}
          </ActionForm>

          {needsDoing && !classDone ? (
            <Card className="mt-8">
              <h2 className="font-display text-[1.2rem] text-forest-900">Nobody in {section.label} paid on paper?</h2>
              <ActionForm action={markNothingPaidAction} className="mt-3 gap-3">
                <input type="hidden" name="section" value={section.id} />
                <p className="max-w-3xl text-[0.92rem] text-muted">
                  If no family in this class paid anything on paper before the portal started, there is nothing to enter here. Mark the class as done so “Getting
                  started” counts it. Nothing about anyone’s fees changes.
                </p>
                <div>
                  <ConfirmSubmit variant="secondary" question={`Mark ${section.label} as done, with nothing paid on paper?`} confirmLabel="Yes, mark as done">
                    Nobody paid on paper — mark as done
                  </ConfirmSubmit>
                </div>
              </ActionForm>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}
