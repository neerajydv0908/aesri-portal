import type { Metadata } from "next";
import Link from "next/link";
import { Banknote, BookOpenCheck, ChevronRight, ClipboardList, ReceiptText } from "lucide-react";
import { officePage } from "@/lib/page";
import { FEE_ROLES, OFFICE_ROLES } from "@/lib/roles";
import { getDb } from "@/lib/db/client";
import { listSections } from "@/lib/queries/school";
import { feeTotals, paymentsInSession, rupees, schoolFeeRows, type StudentFeeRow } from "@/lib/services/fees";
import { waitingClaimCount } from "@/lib/services/cash-claims";
import { formatDate, todayIST } from "@/lib/dates";
import { sectionLabel } from "@/lib/classes";
import { Alert, ButtonLink, EmptyState, Money, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { FilterBar, SearchField, SectionField } from "@/components/pickers";
import { StudentFeeBadge } from "@/components/fees/status";

export const metadata: Metadata = { title: "Fees" };

const MAX_ROWS = 400;

type SectionSummary = {
  id: string;
  label: string;
  stream: string | null;
  students: number;
  charged: number;
  paid: number;
  outstanding: number;
  overdue: number;
  overdueStudents: number;
};

function bySection(rows: StudentFeeRow[]): SectionSummary[] {
  const map = new Map<string, SectionSummary>();
  for (const r of rows) {
    const s = map.get(r.sectionId) ?? {
      id: r.sectionId,
      label: sectionLabel(r.className, r.sectionName),
      stream: r.stream,
      students: 0,
      charged: 0,
      paid: 0,
      outstanding: 0,
      overdue: 0,
      overdueStudents: 0,
    };
    s.students++;
    s.charged += r.charged;
    s.paid += r.paid;
    s.outstanding += r.outstanding;
    s.overdue += r.overdue;
    if (r.overdue > 0) s.overdueStudents++;
    map.set(r.sectionId, s);
  }
  return [...map.values()]; // rows arrive in class order
}

export default async function OfficeFeesPage({ searchParams }: { searchParams: Promise<{ section?: string; overdue?: string; q?: string }> }) {
  const { actor, schoolId, sessionId } = await officePage(FEE_ROLES);
  // Opening balances: the principal and office admins (and AESRI administrators) only.
  const canOpen = OFFICE_ROLES.includes(actor.role);
  const sp = await searchParams;
  const db = await getDb();
  const [sectionList, rows, totals, paymentCount, waitingCash] = await Promise.all([
    listSections(schoolId, sessionId),
    schoolFeeRows(db, schoolId, sessionId),
    feeTotals(db, schoolId, sessionId),
    paymentsInSession(db, schoolId, sessionId),
    waitingClaimCount(db, schoolId),
  ]);
  const today = todayIST();

  const section = sectionList.find((s) => s.id === sp.section) ?? null;
  const overdueOnly = sp.overdue === "1";
  const q = (sp.q ?? "").trim().slice(0, 60);
  const qLower = q.toLowerCase();
  const qDigits = /^\d+$/.test(q) ? String(Number(q)) : null;
  const filtered = rows.filter(
    (r) =>
      (!section || r.sectionId === section.id) &&
      (!overdueOnly || r.overdue > 0) &&
      (!q || r.name.toLowerCase().includes(qLower) || (qDigits !== null && r.srNo.startsWith(qDigits))),
  );
  const shown = filtered.slice(0, MAX_ROWS);
  const overdueStudents = rows.filter((r) => r.overdue > 0).length;
  const owingStudents = rows.filter((r) => r.outstanding > 0).length;
  const sections = bySection(rows);
  const filtering = !!section || overdueOnly || !!q;

  return (
    <>
      <PageHeader
        eyebrow={`Fees · Session ${sessionId}`}
        title="Fees"
        description="What each family has been charged and has paid this session. Open a student to record a payment or print a receipt."
        actions={
          <>
            {canOpen ? (
              <ButtonLink href="/office/fees/approvals" variant={waitingCash ? "primary" : "secondary"}>
                <Banknote className="h-4 w-4" aria-hidden />
                Cash to approve
                {waitingCash ? (
                  <span className="ml-0.5 inline-grid h-6 min-w-6 place-items-center rounded-full bg-alert-600 px-1.5 text-[0.78rem] font-bold text-cream-50 ring-2 ring-cream-50">
                    {waitingCash}
                  </span>
                ) : null}
              </ButtonLink>
            ) : null}
            <ButtonLink href="/office/fees/collections" variant={waitingCash && canOpen ? "secondary" : "primary"}>
              <ReceiptText className="h-4 w-4" aria-hidden />
              Collections
            </ButtonLink>
            {canOpen ? (
              <ButtonLink href="/office/fees/opening" variant="secondary">
                <ClipboardList className="h-4 w-4" aria-hidden />
                Opening balances
              </ButtonLink>
            ) : null}
            <ButtonLink href="/office/fees/plan" variant="secondary">
              <BookOpenCheck className="h-4 w-4" aria-hidden />
              Fee plan
            </ButtonLink>
          </>
        }
      />

      {waitingCash ? (
        <Alert tone="red" title={`${waitingCash} cash ${waitingCash === 1 ? "payment is" : "payments are"} waiting for approval`} className="mb-6">
          {canOpen ? (
            <>
              {waitingCash === 1 ? "A family has recorded a cash payment" : "Families have recorded cash payments"} on the portal. Check{" "}
              {waitingCash === 1 ? "it" : "each one"} against the cash the school received, then approve or decline on{" "}
              <Link href="/office/fees/approvals" className="font-semibold underline underline-offset-2">
                Cash to approve
              </Link>
              .
            </>
          ) : (
            "Families recorded cash payments on the portal; the principal or an office admin approves them. Don’t record the same cash again for those students."
          )}
        </Alert>
      ) : null}

      {paymentCount === 0 ? (
        <Alert tone="amber" title="Start here: bring the paper records up to date" className="mb-6">
          {canOpen ? (
            <>
              Families have already paid part of this session&rsquo;s fees on paper. Before families look at their dues, record those payments class by class on{" "}
              <Link href="/office/fees/opening" className="font-semibold underline underline-offset-2">
                Opening balances
              </Link>
              . If the instalment split in the{" "}
              <Link href="/office/fees/plan" className="font-semibold underline underline-offset-2">
                fee plan
              </Link>{" "}
              needs changing, do that first.
            </>
          ) : (
            <>
              Families have already paid part of this session&rsquo;s fees on paper. The principal or office admin records those payments class by class as opening
              balances before families look at their dues.
            </>
          )}
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Charged this session" value={<Money paise={totals.charged} />} hint={`${rows.length} ${rows.length === 1 ? "student" : "students"} enrolled`} />
        <Stat
          label="Collected"
          value={<Money paise={totals.collected} />}
          hint={`${rupees(totals.collectedToday)} received today${totals.refundedToday ? `, ${rupees(totals.refundedToday)} refunded today` : ""}${totals.refunded ? `; less ${rupees(totals.refunded)} refunded this session` : ""}`}
          href="/office/fees/collections"
          tone="green"
        />
        <Stat
          label="Outstanding"
          value={<Money paise={totals.outstanding} />}
          hint={`${owingStudents} ${owingStudents === 1 ? "student" : "students"} still owe fees`}
          tone={totals.outstanding ? "amber" : "default"}
        />
        <Stat
          label="Overdue"
          value={<Money paise={totals.overdue} />}
          hint={`${overdueStudents} ${overdueStudents === 1 ? "student" : "students"} past the due date`}
          tone={totals.overdue ? "red" : "default"}
          href={totals.overdue ? "/office/fees?overdue=1#students" : undefined}
        />
      </div>

      <section className="mt-10" aria-labelledby="by-class">
        <h2 id="by-class" className="mb-4 font-display text-[1.35rem] text-forest-900">
          By class
        </h2>
        {sections.length ? (
          <Table caption="Fees by class and section for this session">
            <thead>
              <tr>
                <Th>Class</Th>
                <Th className="text-right">Students</Th>
                <Th className="text-right">Charged</Th>
                <Th className="text-right">Collected</Th>
                <Th className="text-right">Outstanding</Th>
                <Th className="text-right">Overdue</Th>
              </tr>
            </thead>
            <tbody>
              {sections.map((s) => (
                <tr key={s.id}>
                  <Td>
                    <Link
                      href={`/office/fees?section=${s.id}#students`}
                      className="inline-flex min-h-8 items-center font-semibold text-forest-800 underline-offset-2 hover:underline"
                    >
                      {s.label}
                      {s.stream ? ` (${s.stream})` : ""}
                    </Link>
                  </Td>
                  <Td className="text-right tabular">{s.students}</Td>
                  <Td className="text-right">
                    <Money paise={s.charged} />
                  </Td>
                  <Td className="text-right">
                    <Money paise={s.paid} />
                  </Td>
                  <Td className="text-right">
                    <Money paise={s.outstanding} />
                  </Td>
                  <Td className="text-right">
                    {s.overdue ? (
                      <span className="font-semibold text-clay-600">
                        <Money paise={s.overdue} />{" "}
                        <span className="text-[0.85rem] font-normal text-muted">
                          ({s.overdueStudents} {s.overdueStudents === 1 ? "student" : "students"})
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No students yet">Add students and place them in classes; their fee lines are created automatically from the fee plan.</EmptyState>
        )}
      </section>

      <section className="mt-10 scroll-mt-24" id="students" aria-labelledby="students-title">
        <h2 id="students-title" className="mb-4 font-display text-[1.35rem] text-forest-900">
          Students and dues
        </h2>
        <FilterBar action="/office/fees#students">
          <SectionField sections={sectionList} value={section?.id} allowAll />
          <SearchField value={q} label="Name or SR No." placeholder="e.g. Meena or 7634" />
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[0.95rem] font-semibold text-forest-900">
            <input type="checkbox" name="overdue" value="1" defaultChecked={overdueOnly} className="h-6 w-6 cursor-pointer accent-forest-700" />
            Overdue only
          </label>
        </FilterBar>

        {shown.length ? (
          <>
            <p className="mb-3 text-[0.9rem] text-muted" role="status">
              {filtering
                ? `${filtered.length} of ${rows.length} ${rows.length === 1 ? "student" : "students"} ${filtered.length === 1 ? "matches" : "match"}.`
                : `${rows.length} ${rows.length === 1 ? "student" : "students"}.`}{" "}
              Balances are as of {formatDate(today)}.
              {filtered.length > MAX_ROWS ? ` Showing the first ${MAX_ROWS}; choose a class to see the rest.` : ""}
            </p>
            <Table caption="Students with what they owe this session">
              <thead>
                <tr>
                  <Th>Student</Th>
                  <Th>Class</Th>
                  <Th className="text-right">Charged</Th>
                  <Th className="text-right">Paid</Th>
                  <Th className="text-right">Balance</Th>
                  <Th className="text-right">Overdue</Th>
                  <Th>Status</Th>
                  <Th>
                    <span className="sr-only">Open</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.studentId} className="hover:bg-cream-200/30">
                    <Td>
                      <Link
                        href={`/office/fees/students/${r.studentId}`}
                        className="inline-flex min-h-6 items-center font-semibold text-forest-900 underline-offset-2 hover:underline"
                      >
                        {r.name}
                      </Link>
                      <span className="block text-[0.85rem] text-muted tabular">
                        SR {r.srNo}
                        {r.status !== "active" ? ` · ${r.status.replace("_", " ")}` : ""}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap">{sectionLabel(r.className, r.sectionName)}</Td>
                    <Td className="text-right">
                      <Money paise={r.charged} />
                    </Td>
                    <Td className="text-right">
                      <Money paise={r.paid} />
                    </Td>
                    <Td className="text-right font-semibold">
                      <Money paise={r.outstanding} />
                    </Td>
                    <Td className="text-right">{r.overdue ? <Money paise={r.overdue} className="font-semibold text-clay-600" /> : <span className="text-muted">—</span>}</Td>
                    <Td>
                      <StudentFeeBadge rte={r.rte} lines={r.lines} outstanding={r.outstanding} overdue={r.overdue} dueNow={r.dueNow} />
                    </Td>
                    <Td className="text-right">
                      <Link
                        href={`/office/fees/students/${r.studentId}`}
                        aria-label={`Fees for ${r.name}`}
                        className="inline-grid h-11 w-11 place-items-center rounded-full text-forest-800 hover:bg-forest-900/[0.06]"
                      >
                        <ChevronRight className="h-5 w-5" aria-hidden />
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        ) : (
          <EmptyState title={filtering ? "No students match" : "No students yet"}>
            {filtering ? (
              <>
                Try another class or name, or{" "}
                <Link href="/office/fees#students" className="font-semibold underline">
                  clear the filters
                </Link>
                .
              </>
            ) : (
              "Students appear here once they are placed in a class for this session."
            )}
          </EmptyState>
        )}
      </section>
    </>
  );
}
