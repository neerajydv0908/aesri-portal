import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CircleCheck, KeyRound, Layers, Printer, ReceiptText } from "lucide-react";
import { officePage, type OfficeContext } from "@/lib/page";
import { getDb } from "@/lib/db/client";
import { auditActor } from "@/lib/auth/dal";
import { formatDateTime } from "@/lib/dates";
import { slipQueue, staffAccessPeople, studentAccessPeople, type SlipQueue } from "@/lib/queries/access";
import { rupees } from "@/lib/services/fees";
import { peopleByAccount } from "@/lib/services/attendance";
import { mayManageAdminAccess } from "@/lib/services/staff";
import {
  batchCreated,
  batchFile,
  discardBatch,
  getBatch,
  hasErrors,
  IMPORT_LIMITS,
  isExpired,
  planImport,
  planKey,
  PREVIEW_HOURS,
  type BatchSummary,
  type ImportIssue,
  type ImportPlan,
  type ImportResult,
  type NewSubject,
} from "@/lib/services/import";
import { Alert, Badge, ButtonLink, Card, CardTitle, Checkbox, EmptyState, PageHeader, Stat, TabLinks, Table, Td, Th } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { ActionForm } from "@/components/forms";
import { Flash } from "@/components/flash";
import { ExcelUploadForm } from "@/components/setup/upload-form";
import { IssueList } from "@/components/setup/import-status";
import { BulkPrintButton, SlipResult, SlipsForm } from "@/components/access/client";
import { MAX_BULK_PRINT } from "@/components/access/slip-types";
import { confirmImportAction, discardImportAction, uploadImportAction } from "../actions";
import { printSlipsAction } from "../../access/actions";

export const metadata: Metadata = { title: "Import preview" };

const PAGE_SIZE = 100;
const n = (x: number) => x.toLocaleString("en-IN");
const plural = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`;
const ACCESS: Record<string, string> = { teacher: "Teacher", principal: "Principal", office_admin: "Office admin", accounts: "Accounts", none: "No login" };

type SP = { done?: string; list?: string; page?: string };

export default async function ImportBatchPage({ params, searchParams }: { params: Promise<{ batchId: string }>; searchParams: Promise<SP> }) {
  const ctx = await officePage();
  const { batchId } = await params;
  const sp = await searchParams;
  const db = await getDb();
  let batch = await getBatch(db, ctx.schoolId, batchId);
  if (!batch) notFound();
  let expiredNow = false;
  if (batch.status === "previewed" && isExpired(batch)) {
    const who = await auditActor(ctx.actor);
    expiredNow = await db.transaction((tx) => discardBatch(tx, ctx.schoolId, batch!.id, who, "expired"));
    batch = (await getBatch(db, ctx.schoolId, batchId))!;
  }
  const people = await peopleByAccount([batch.createdBy]);
  const by = people.get(batch.createdBy)?.name ?? "someone";
  const summary = (batch.summary as BatchSummary | null) ?? null;
  const uploaded = `${batch.fileName} · uploaded by ${by}, ${formatDateTime(batch.createdAt)}`;

  if (batch.status === "imported") {
    // The students and staff this import added (kept since the list was recorded; this session's imports only).
    const created = batch.sessionId === ctx.sessionId ? batchCreated(batch) : null;
    const slips = created && summary?.result ? await importSlips(ctx, created) : null;
    return (
      <>
        <div className="no-print">
          <PageHeader eyebrow="Import from Excel" title="Import complete" description={uploaded} />
          <Flash code={sp.done} messages={{ imported: "Imported. Everyone in the file is now in the portal." }} />
        </div>
        {summary?.result ? (
          <ImportedView result={summary.result} finishedAt={batch.finishedAt} batchId={batch.id} slips={slips} />
        ) : (
          <p className="text-muted">This file was imported.</p>
        )}
      </>
    );
  }

  if (batch.status !== "previewed") {
    return (
      <>
        <PageHeader eyebrow="Import from Excel" title={expiredNow ? "This preview has expired" : "This preview was discarded"} description={uploaded} />
        <Card className="max-w-3xl">
          <p className="text-forest-900">
            {expiredNow
              ? `Nobody confirmed it within ${PREVIEW_HOURS} hours, so it was deleted. Nothing was imported.`
              : "Nothing from this file was imported, and the rows it held have been deleted."}{" "}
            To import the file, upload it again: it will be checked against today&rsquo;s records.
          </p>
          <ButtonLink href="/office/import" variant="secondary" className="mt-5">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to Import from Excel
          </ButtonLink>
        </Card>
      </>
    );
  }

  const file = batchFile(batch);
  if (!file) notFound();
  const wrongSession = batch.sessionId !== ctx.sessionId;
  const stored = file.issues;
  const plan =
    !wrongSession && !hasErrors(stored)
      ? await planImport(db, { schoolId: ctx.schoolId, sessionId: ctx.sessionId, file, actorStaffId: ctx.actor.staffId, mayManageAdmins: mayManageAdminAccess(ctx.actor.role) })
      : null;
  const issues: ImportIssue[] = plan ? [...stored, ...plan.issues] : stored;
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const expires = new Date(batch.createdAt.getTime() + PREVIEW_HOURS * 3600_000);

  if (wrongSession) {
    return (
      <>
        <PageHeader eyebrow="Import from Excel" title="This preview is for another session" description={uploaded} />
        <Card className="max-w-3xl">
          <p className="text-forest-900">It was checked for the {batch.sessionId} session, but the portal is now working in {ctx.sessionId}. Discard it and upload the file again.</p>
          <DiscardForm batchId={batch.id} />
        </Card>
      </>
    );
  }

  if (errors.length || !plan) {
    return (
      <>
        <PageHeader eyebrow="Import from Excel" title="Some things need fixing first" description={uploaded} />
        <Alert tone="red" title={`${plural(errors.length, "problem", "problems")} to fix — nothing has been imported`} className="mb-6">
          Correct {errors.length === 1 ? "it" : "them"} in the Excel file (the row numbers are the ones Excel shows), save it, and upload it again below. Nothing is
          imported while any problem remains.
        </Alert>
        <p className="mb-6 text-[0.95rem] text-muted">
          The file has {plural(file.rows.students, "student row", "student rows")} and {plural(file.rows.staff, "staff row", "staff rows")}.
        </p>
        <section aria-labelledby="problems" className="mb-8">
          <h2 id="problems" className="mb-3 font-display text-[1.35rem] text-forest-900">
            Problems to fix
          </h2>
          <IssueList issues={errors} caption="Problems to fix in the Excel file" />
        </section>
        {warnings.length ? (
          <section aria-labelledby="warnings" className="mb-8">
            <h2 id="warnings" className="mb-1 font-display text-[1.35rem] text-forest-900">
              Worth checking
            </h2>
            <p className="mb-3 text-[0.92rem] text-muted">These don&rsquo;t stop the import.</p>
            <IssueList issues={warnings} caption="Warnings: worth checking, but they don't stop the import" />
          </section>
        ) : null}
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <Card>
            <CardTitle>Upload the corrected file</CardTitle>
            <ExcelUploadForm action={uploadImportAction} maxBytes={IMPORT_LIMITS.fileBytes} label="Corrected Excel file" />
          </Card>
          <Card>
            <CardTitle>Or stop here</CardTitle>
            <p className="text-forest-900">Discard this check. Nothing is imported.</p>
            <DiscardForm batchId={batch.id} />
          </Card>
        </div>
      </>
    );
  }

  const c = plan.counts;
  const toImportStudents = c.studentsNew + c.studentsUpdated;
  const toImportStaff = c.staffNew + c.staffUpdated;
  const anything = toImportStudents + toImportStaff + c.sections + (c.subjectsNew ?? 0) + plan.classTeacherMoves.length > 0;
  const ctGained = plan.classTeacherMoves.filter((m) => m.staffRow !== null).length;
  const ctLost = plan.classTeacherMoves.length - ctGained;

  return (
    <>
      <PageHeader eyebrow="Import from Excel" title="Check before importing" description={uploaded} />
      <p className="-mt-4 mb-6 text-[0.92rem] text-muted">
        Nothing has been imported yet. This preview is kept until {formatDateTime(expires)}.
      </p>

      <section aria-labelledby="counts" className="mb-8">
        <h2 id="counts" className="sr-only">
          What the file contains
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Stat label="New students" value={n(c.studentsNew)} tone={c.studentsNew ? "green" : "default"} hint="Will be added, with a family login each" />
          <Stat label="Students with changes" value={n(c.studentsUpdated)} hint="Already in the portal; only filled cells change" />
          <Stat label="Students unchanged" value={n(c.studentsSame)} tone="grey" hint="Already match the portal" />
          <Stat label="New staff" value={n(c.staffNew)} tone={c.staffNew ? "green" : "default"} hint="Will be added" />
          <Stat label="Staff with changes" value={n(c.staffUpdated)} hint={`${n(c.staffSame)} already ${c.staffSame === 1 ? "matches" : "match"} the portal`} />
          <Stat label="Sections to create" value={n(c.sections)} hint={c.sections ? plan.sectionsToCreate.map((s) => s.label).join(", ") : "All sections already exist"} />
        </div>
      </section>

      {plan.subjectsToAdd.length ? <NewSubjectsSection subjects={plan.subjectsToAdd} /> : null}

      {warnings.length ? (
        <section aria-labelledby="warnings" className="mb-8">
          <h2 id="warnings" className="mb-1 font-display text-[1.35rem] text-forest-900">
            Worth checking ({n(warnings.length)})
          </h2>
          <p className="mb-3 text-[0.92rem] text-muted">These don&rsquo;t stop the import. If one is a mistake, correct the file and upload it again.</p>
          <IssueList issues={warnings} caption="Warnings: worth checking, but they don't stop the import" />
        </section>
      ) : null}

      <Card className="mb-10">
        <CardTitle>Import</CardTitle>
        {anything ? (
          <ActionForm action={confirmImportAction}>
            <input type="hidden" name="batch" value={batch.id} />
            <input type="hidden" name="expect" value={planKey(c)} />
            <ul className="grid list-disc gap-1 pl-5 text-forest-900">
              {c.studentsNew ? <li>{plural(c.studentsNew, "new student", "new students")} will be added, each with a family login and this session&rsquo;s fee lines.</li> : null}
              {c.studentsUpdated ? <li>{plural(c.studentsUpdated, "student’s record", "students’ records")} will be updated (see “Students with changes” below).</li> : null}
              {c.staffNew ? <li>{plural(c.staffNew, "member of staff", "members of staff")} will be added.</li> : null}
              {c.staffUpdated ? <li>{plural(c.staffUpdated, "member of staff", "members of staff")} will be updated.</li> : null}
              {c.sections ? <li>{plural(c.sections, "section", "sections")} will be created: {plan.sectionsToCreate.map((s) => s.label).join(", ")}.</li> : null}
              {plan.subjectsToAdd.length ? (
                <li>
                  {plural(plan.subjectsToAdd.length, "subject", "subjects")} will be added to the school&rsquo;s list: {plan.subjectsToAdd.map((s) => s.name).join(", ")}.
                </li>
              ) : null}
              {ctGained ? <li>{plural(ctGained, "section", "sections")} will get a new class teacher.</li> : null}
              {ctLost ? (
                <li>
                  {plural(ctLost, "section", "sections")} will have no class teacher, because {ctLost === 1 ? "its class teacher is" : "their class teachers are"} now listed for
                  another class. Choose new ones on the Classes &amp; subjects page.
                </li>
              ) : null}
            </ul>
            {plan.admission ? (
              <div className="rounded-2xl bg-sage-50 p-4 ring-1 ring-forest-700/15">
                <Checkbox
                  name="admissionFee"
                  value="yes"
                  aria-describedby="admission-hint"
                  label={
                    <>
                      Add the admission fee ({rupees(plan.admission.amount)}, from the current fee plan) for the {plural(plan.admission.eligible, "new student", "new students")}{" "}
                      admitted in this session
                    </>
                  }
                />
                <p id="admission-hint" className="mt-2 pl-9 text-[0.88rem] text-muted">
                  Leave it unticked if they paid it on paper before the portal — record those payments as opening balances on the Fees page.
                  {plan.admission.rte
                    ? ` ${plural(plan.admission.rte, "of them is", "of them are")} on an RTE seat and never ${plan.admission.rte === 1 ? "pays" : "pay"} it: their line is waived automatically.`
                    : " RTE-seat students never pay it: their line is waived automatically."}
                  {plan.admission.noDate
                    ? ` ${plural(plan.admission.noDate, "new student has", "new students have")} no admission date in the file, so ${plan.admission.noDate === 1 ? "isn't" : "aren't"} included.`
                    : ""}
                </p>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <SubmitButton size="lg" pendingLabel="Importing… this can take a minute">
                {importLabel(toImportStudents, toImportStaff, c.sections + plan.classTeacherMoves.length)}
              </SubmitButton>
            </div>
            <p className="text-[0.88rem] text-muted">Everything is imported together, or nothing is: if one row can&rsquo;t be saved, no changes are made.</p>
          </ActionForm>
        ) : (
          <p className="text-forest-900">
            <CircleCheck className="mr-1.5 inline h-5 w-5 text-forest-700" aria-hidden />
            Nothing to import: every row already matches the portal&rsquo;s records.
          </p>
        )}
        <div className="mt-5 border-t border-forest-900/10 pt-4">
          <DiscardForm batchId={batch.id} />
        </div>
      </Card>

      <RowsSection plan={plan} batchId={batch.id} sp={sp} />
    </>
  );
}

const rowList = (rows: number[]) => (rows.length === 1 ? `row ${rows[0]}` : `rows ${rows.slice(0, -1).join(", ")} and ${rows[rows.length - 1]}`);

/** Subjects the Staff sheet names that the school doesn't have yet: the import adds them to its list. */
function NewSubjectsSection({ subjects }: { subjects: NewSubject[] }) {
  const one = subjects.length === 1;
  return (
    <section aria-labelledby="new-subjects" className="mb-8">
      <h2 id="new-subjects" className="mb-1 font-display text-[1.35rem] text-forest-900">
        New subjects to add ({n(subjects.length)})
      </h2>
      <p className="mb-3 max-w-3xl text-[0.92rem] text-muted">
        The Staff sheet names {one ? "this subject" : "these subjects"} under &ldquo;Subjects taught&rdquo;, and the school&rsquo;s list doesn&rsquo;t have {one ? "it" : "them"} yet.
        Importing adds {one ? "it" : "them"} to the list. Afterwards, tick the classes that are taught {one ? "it" : "them"} on Classes &amp; subjects.
      </p>
      <ul aria-label="New subjects to add" className="card divide-y divide-forest-900/[0.06]">
        {subjects.map((s) => {
          const typed = s.typed.filter((t) => t !== s.name);
          return (
            <li key={s.key} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-3 sm:px-6">
              <span className="min-w-0">
                <span className="font-semibold text-forest-900">{s.name}</span>
                {s.nameHi && s.nameHi !== s.name ? (
                  <>
                    {" "}
                    <span lang="hi" className="ml-1 text-forest-900/80">
                      {s.nameHi}
                    </span>
                  </>
                ) : null}
              </span>
              <span className="text-[0.88rem] text-muted">
                {typed.length ? <>Written as {typed.map((t) => `“${t}”`).join(" and ")} · </> : null}Staff sheet, <span className="tabular">{rowList(s.rows)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function importLabel(students: number, staff: number, other: number): string {
  const parts = [students ? plural(students, "student", "students") : null, staff ? `${n(staff)} staff` : null].filter(Boolean);
  if (parts.length) return `Import ${parts.join(" and ")}`;
  return other ? "Save the class and section changes" : "Import";
}

function DiscardForm({ batchId }: { batchId: string }) {
  return (
    <ActionForm action={discardImportAction} className="gap-2">
      <input type="hidden" name="batch" value={batchId} />
      <div>
        <ConfirmSubmit question="Discard this preview? Nothing will be imported." confirmLabel="Yes, discard">
          Discard
        </ConfirmSubmit>
      </div>
    </ActionForm>
  );
}

/* ------------------------------------------------------------------ */
/* What will be imported, row by row                                   */
/* ------------------------------------------------------------------ */

type ListKey = "new" | "changed" | "same" | "staff";

function RowsSection({ plan, batchId, sp }: { plan: ImportPlan; batchId: string; sp: SP }) {
  const c = plan.counts;
  const lists: { key: ListKey; label: string; count: number }[] = [
    { key: "new", label: `New students (${n(c.studentsNew)})`, count: c.studentsNew },
    { key: "changed", label: `Students with changes (${n(c.studentsUpdated)})`, count: c.studentsUpdated },
    { key: "same", label: `Unchanged (${n(c.studentsSame)})`, count: c.studentsSame },
    { key: "staff", label: `Staff (${n(plan.staff.length)})`, count: plan.staff.length },
  ];
  const requested = lists.find((l) => l.key === sp.list);
  const current = requested ?? lists.find((l) => l.count > 0) ?? lists[0];
  const base = `/office/import/${batchId}`;
  const rows =
    current.key === "staff"
      ? plan.staff
      : plan.students.filter((s) => (current.key === "new" ? s.kind === "new" : current.key === "changed" ? s.kind === "update" : s.kind === "same"));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1));
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const href = (list: ListKey, p = 1) => `${base}?list=${list}${p > 1 ? `&page=${p}` : ""}#rows`;

  return (
    <section aria-labelledby="rows-title" className="scroll-mt-24" id="rows">
      <h2 id="rows-title" className="mb-4 font-display text-[1.35rem] text-forest-900">
        What will be imported
      </h2>
      <TabLinks current={current.key} tabs={lists.map((l) => ({ key: l.key, href: href(l.key), label: l.label }))} />
      {!rows.length ? (
        <EmptyState title="Nothing in this list" />
      ) : current.key === "staff" ? (
        <StaffTable rows={slice as ImportPlan["staff"]} />
      ) : (
        <StudentTable rows={slice as ImportPlan["students"]} kind={current.key} />
      )}
      {pages > 1 ? (
        <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center gap-3 text-[0.95rem]">
          <span className="text-muted">
            Rows {n((page - 1) * PAGE_SIZE + 1)}–{n(Math.min(rows.length, page * PAGE_SIZE))} of {n(rows.length)}
          </span>
          {page > 1 ? (
            <Link href={href(current.key, page - 1)} className="inline-flex min-h-11 items-center rounded-full px-4 font-semibold text-forest-800 ring-1 ring-forest-900/15 hover:ring-forest-900/35">
              Previous
            </Link>
          ) : null}
          {page < pages ? (
            <Link href={href(current.key, page + 1)} className="inline-flex min-h-11 items-center rounded-full px-4 font-semibold text-forest-800 ring-1 ring-forest-900/15 hover:ring-forest-900/35">
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}

function StudentTable({ rows, kind }: { rows: ImportPlan["students"]; kind: ListKey }) {
  return (
    <Table caption={kind === "new" ? "New students in the file" : kind === "changed" ? "Students whose records will change" : "Students already matching the portal"}>
      <thead>
        <tr>
          <Th className="text-right">Row</Th>
          <Th>Student</Th>
          <Th>Class</Th>
          <Th>{kind === "changed" ? "What changes" : "Roll No."}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.row} className="align-top">
            <Td className="text-right tabular text-muted">{s.row}</Td>
            <Td className="min-w-48">
              <span className="block font-semibold text-forest-900">{s.name}</span>
              <span className="block text-[0.85rem] text-muted tabular">
                SR No. {s.srNo}
                {s.rte ? " · RTE seat" : ""}
              </span>
            </Td>
            <Td className="whitespace-nowrap">{s.sectionLabel}</Td>
            <Td className="min-w-56">
              {kind === "changed" ? (
                <ul className="grid gap-0.5 text-[0.92rem]">
                  {s.changes.map((ch, i) => (
                    <li key={i}>{ch}</li>
                  ))}
                </ul>
              ) : (
                <span className="tabular">{s.rollNo ?? "—"}</span>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function StaffTable({ rows }: { rows: ImportPlan["staff"] }) {
  return (
    <Table caption="Staff in the file">
      <thead>
        <tr>
          <Th className="text-right">Row</Th>
          <Th>Name</Th>
          <Th>Portal access</Th>
          <Th>Status</Th>
          <Th>Details</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.row} className="align-top">
            <Td className="text-right tabular text-muted">{s.row}</Td>
            <Td className="min-w-48">
              <span className="block font-semibold text-forest-900">{s.name}</span>
              <span className="block text-[0.85rem] text-muted tabular">
                Employee No. {s.empNo} · {s.designation}
              </span>
            </Td>
            <Td className="whitespace-nowrap">{ACCESS[s.access]}</Td>
            <Td>
              {s.kind === "new" ? <Badge tone="green">New</Badge> : s.kind === "update" ? <Badge tone="amber">Changes</Badge> : <Badge tone="grey">Unchanged</Badge>}
            </Td>
            <Td className="min-w-56 text-[0.92rem]">
              {s.kind === "update" ? (
                <ul className="grid gap-0.5">
                  {s.changes.map((ch, i) => (
                    <li key={i}>{ch}</li>
                  ))}
                </ul>
              ) : (
                <>
                  {s.kind === "new" && s.changes.length
                    ? s.changes.map((ch, i) => (
                        <span key={i} className="block">
                          {ch}
                        </span>
                      ))
                    : s.classTeacherOf?.length
                      ? <span className="block">Class teacher of {s.classTeacherOf.join(", ")}</span>
                      : null}
                  {s.subjectNames.length ? <span className="block text-muted">Teaches {s.subjectNames.join(", ")}</span> : null}
                  {!s.changes.length && !s.classTeacherOf?.length && !s.subjectNames.length ? <span className="text-muted">—</span> : null}
                </>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/* ------------------------------------------------------------------ */
/* After the import                                                    */
/* ------------------------------------------------------------------ */

/** Slips for the people an import added: who still needs one (and may get one from this person), and how many have activated already. */
type ImportSlips = { queue: SlipQueue; students: number; staff: number; activated: number };

async function importSlips(ctx: OfficeContext, created: { studentIds: string[]; staffIds: string[] }): Promise<ImportSlips> {
  const [students, staffList] = await Promise.all([studentAccessPeople(ctx.schoolId, ctx.sessionId), staffAccessPeople(ctx.schoolId)]);
  const studentIds = new Set(created.studentIds);
  const staffIds = new Set(created.staffIds);
  const added = [...staffList.filter((p) => staffIds.has(p.id)), ...students.filter((p) => studentIds.has(p.id))];
  const queue = slipQueue(added, ctx.actor);
  return {
    queue,
    students: queue.people.filter((p) => p.kind === "student").length,
    staff: queue.people.filter((p) => p.kind === "staff").length,
    activated: added.filter((p) => p.current && p.signIn?.status === "active").length,
  };
}

/** "the 400 students and 12 staff", "the 1 student", "the 3 staff", "the 1 member of staff". */
function whoText(students: number, staff: number): string {
  const parts = [students ? plural(students, "student", "students") : null, staff ? (staff === 1 ? "1 member of staff" : `${n(staff)} staff`) : null].filter(Boolean);
  return `the ${parts.join(" and ")}`;
}

/** The last step on the result page: print the slips for everyone the import added, in one go. */
function ImportSlipsStep({ slips }: { slips: ImportSlips }) {
  const { queue, students, staff, activated } = slips;
  const order = staff && students ? "staff first by employee number, then students by class, section and roll number" : staff ? "in order of employee number" : "in order of class, section and roll number";
  const notes = [
    activated ? `${plural(activated, "person", "people")} this import added ${activated === 1 ? "has" : "have"} activated already.` : null,
    queue.adminOnly ? `Slips for the principal and office admins (${queue.adminOnly}) are printed by an AESRI administrator.` : null,
  ].filter(Boolean);
  if (queue.people.length > MAX_BULK_PRINT) {
    return (
      <p className="mt-2 text-[0.95rem] text-forest-900">
        {n(queue.people.length)} people this import added are waiting for a slip: more than the {n(MAX_BULK_PRINT)} that can be printed at once. Print them class by class
        on Slips &amp; sign-in, using the links below.
      </p>
    );
  }
  if (!queue.people.length) {
    return (
      <p className="mt-2 flex gap-2 text-[0.95rem] text-forest-900">
        <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-forest-700" aria-hidden />
        <span>
          {queue.adminOnly
            ? `Only the slips for the principal and office admins (${queue.adminOnly}) are still to print: an AESRI administrator prints those.`
            : activated
              ? "Everyone this import added who can sign in has activated their account."
              : "Nobody this import added needs a slip."}
        </span>
      </p>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3">
      <BulkPrintButton
        intent="import"
        total={queue.people.length}
        replaced={queue.replaced}
        label={`Print sign-in slips for ${whoText(students, staff)} this import added`}
        showCount={false}
        order={order}
        note={notes.join(" ") || undefined}
        variant="primary"
      />
    </div>
  );
}

function ImportedView({ result: r, finishedAt, batchId, slips }: { result: ImportResult; finishedAt: Date | null; batchId: string; slips: ImportSlips | null }) {
  const nextSteps = (
    <Card className="no-print">
      <CardTitle>Next steps</CardTitle>
      <ol className="grid gap-5">
        {r.studentsNew ? (
          <li className="flex gap-3">
            <ReceiptText className="mt-0.5 h-5 w-5 shrink-0 text-forest-700" aria-hidden />
            <div>
              <p className="font-semibold text-forest-900">1. Enter fees already paid on paper</p>
              <p className="text-[0.95rem] text-muted">
                Instalments that fell due before the portal started now show as unpaid. Enter what families paid on paper as opening balances, class by class, before families
                sign in — otherwise they see those fees as overdue.
              </p>
              <Link href="/office/fees/opening" className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline underline-offset-2">
                Opening balances
              </Link>
            </div>
          </li>
        ) : null}
        <li className="flex gap-3">
          <Layers className="mt-0.5 h-5 w-5 shrink-0 text-forest-700" aria-hidden />
          <div>
            <p className="font-semibold text-forest-900">{r.studentsNew ? "2. " : "1. "}Set class teachers and subject teachers</p>
            <p className="text-[0.95rem] text-muted">
              Check every section has a class teacher, which subjects each class is taught, and who teaches them.
              {r.subjectsAdded?.length ? ` Tick the classes that are taught the new ${r.subjectsAdded.length === 1 ? "subject" : "subjects"} (${r.subjectsAdded.join(", ")}).` : ""}
            </p>
            <Link href="/office/classes" className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline underline-offset-2">
              Classes &amp; subjects
            </Link>
          </div>
        </li>
        <li className="flex gap-3">
          <Printer className="mt-0.5 h-5 w-5 shrink-0 text-forest-700" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-forest-900">{r.studentsNew ? "3. " : "2. "}Print sign-in slips: staff first, then families</p>
            <p className="text-[0.95rem] text-muted">
              Each member of staff and each family needs a slip with their login ID and a one-time code before they can sign in. Slips for the principal and office admins
              are printed by the AESRI administrator.
            </p>
            {slips ? <ImportSlipsStep slips={slips} /> : null}
            {r.staffWithLogin && !slips ? (
              <p className="mt-2">
                <Link href="/office/access?tab=staff" className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-forest-800 underline underline-offset-2">
                  <KeyRound className="h-4 w-4" aria-hidden />
                  Slips for the {plural(r.staffWithLogin, "new member of staff", "new staff")} with a login
                </Link>
              </p>
            ) : null}
            {r.slipSections.length ? (
              <>
                {slips?.queue.people.length ? <p className="mt-4 text-[0.92rem] text-muted">Or print them class by class on Slips &amp; sign-in:</p> : null}
                <ul className="mt-2 flex flex-wrap gap-2" aria-label="Family slips, by class">
                  {r.slipSections.map((s) => (
                    <li key={s.id}>
                      <Link
                        href={`/office/access?section=${s.id}`}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-cream-50 px-4 text-[0.92rem] font-semibold text-forest-800 ring-1 ring-forest-900/15 hover:ring-forest-900/35"
                      >
                        {s.label}
                        <span className="font-normal text-muted">({plural(s.students, "new student", "new students")})</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {!r.slipSections.length && !r.staffWithLogin ? (
              <p className="mt-2">
                <Link href="/office/access" className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline underline-offset-2">
                  Slips &amp; sign-in
                </Link>
              </p>
            ) : null}
          </div>
        </li>
      </ol>
    </Card>
  );

  return (
    <>
      <div className="no-print mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Students added" value={n(r.studentsNew)} tone={r.studentsNew ? "green" : "default"} hint={`${n(r.studentsUpdated)} updated · ${n(r.studentsSame)} unchanged`} />
        <Stat label="Staff added" value={n(r.staffNew)} tone={r.staffNew ? "green" : "default"} hint={`${n(r.staffUpdated)} updated · ${n(r.staffSame)} unchanged`} />
        <Stat label="Sections created" value={n(r.sectionsCreated.length)} hint={r.sectionsCreated.length ? r.sectionsCreated.join(", ") : "None needed"} />
        <Stat
          label="Admission fees added"
          value={n(r.admissionFees)}
          hint={r.admissionFees ? "For new students admitted this session (waived for RTE seats)" : "Not added in this import"}
        />
      </div>
      {finishedAt ? <p className="no-print -mt-4 mb-6 text-[0.9rem] text-muted">Finished {formatDateTime(finishedAt)}.</p> : null}
      {r.subjectsAdded?.length ? (
        <p className="no-print -mt-2 mb-6 text-forest-900">
          <strong className="font-semibold">{plural(r.subjectsAdded.length, "subject was", "subjects were")} added to the school&rsquo;s list:</strong> {r.subjectsAdded.join(", ")}.
        </p>
      ) : null}

      {slips ? (
        // The printed slips appear above the steps; everything else on the page is left out of the print.
        <SlipsForm id="import-slips" action={printSlipsAction} messagePosition="none" aria-label="Print sign-in slips for this import">
          <input type="hidden" name="batch" value={batchId} />
          <SlipResult>{nextSteps}</SlipResult>
        </SlipsForm>
      ) : (
        nextSteps
      )}
      <ButtonLink href="/office/import" variant="secondary" className="no-print mt-6">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to Import from Excel
      </ButtonLink>
    </>
  );
}
