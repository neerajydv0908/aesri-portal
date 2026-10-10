import type { Metadata } from "next";
import Link from "next/link";
import { FileSpreadsheet, Phone, UserPlus, Users } from "lucide-react";
import { officePage } from "@/lib/page";
import { OFFICE_ROLES, STUDENT_LOOKUP_ROLES } from "@/lib/roles";
import { getSchool, listSections } from "@/lib/queries/school";
import { isStudentStatus, listStudentRecords, type StudentStatusFilter } from "@/lib/queries/records";
import { ButtonLink, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { FilterBar, SectionField } from "@/components/pickers";
import { RteBadge, SignInBadge, StudentStatusBadge } from "@/components/records/badges";
import { ChoiceField, Pager, SearchBox } from "@/components/records/list-parts";

export const metadata: Metadata = { title: "Students" };

const PER_PAGE = 50;

const STATUS_CHOICES: { value: StudentStatusFilter; label: string }[] = [
  { value: "active", label: "Current" },
  { value: "left", label: "Left" },
  { value: "transferred", label: "Transferred" },
  { value: "passed_out", label: "Passed out" },
  { value: "all", label: "All" },
];

type SearchParams = Record<string, string | string[] | undefined>;
const one = (sp: SearchParams, key: string) => (typeof sp[key] === "string" ? (sp[key] as string) : "");

export default async function StudentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { actor, schoolId, sessionId } = await officePage(STUDENT_LOOKUP_ROLES);
  const sp = await searchParams;
  const isOffice = OFFICE_ROLES.includes(actor.role);
  const [school, sectionList] = await Promise.all([getSchool(schoolId), listSections(schoolId, sessionId)]);

  const section = sectionList.find((s) => s.id === one(sp, "section")) ?? null;
  const statusParam = one(sp, "status");
  const status: StudentStatusFilter = statusParam === "all" || isStudentStatus(statusParam) ? statusParam : "active";
  const q = one(sp, "q").trim().slice(0, 60);
  const requestedPage = Number.parseInt(one(sp, "page"), 10);
  const list = await listStudentRecords({
    schoolId,
    sessionId,
    loginPrefix: school?.loginPrefix ?? "",
    sectionId: section?.id ?? null,
    status,
    q,
    page: Number.isFinite(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 10_000) : 1,
    perPage: PER_PAGE,
  });
  const filtering = !!section || status !== "active" || !!q;

  const href = (page: number) => {
    const p = new URLSearchParams();
    if (section) p.set("section", section.id);
    if (status !== "active") p.set("status", status);
    if (q) p.set("q", q);
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return s ? `/office/students?${s}` : "/office/students";
  };
  return (
    <>
      <PageHeader
        eyebrow={`Records · Session ${sessionId}`}
        title="Students"
        description={
          isOffice
            ? "Every student of the school, with their class this session and their family’s sign-in. Open a student to change their details, class or status."
            : "Look up a student’s class and their family’s contact details. Only the school office can change records."
        }
        actions={
          isOffice ? (
            <>
              <ButtonLink href="/office/students/new">
                <UserPlus className="h-4 w-4" aria-hidden />
                Add a student
              </ButtonLink>
              <ButtonLink href="/office/import" variant="secondary">
                <FileSpreadsheet className="h-4 w-4" aria-hidden />
                Import from Excel
              </ButtonLink>
            </>
          ) : null
        }
      />

      {list.schoolTotal === 0 ? (
        <EmptyState
          icon={<Users className="h-5 w-5" aria-hidden />}
          title="No students yet"
          action={
            isOffice ? (
              <div className="flex flex-wrap justify-center gap-2.5">
                <ButtonLink href="/office/import">
                  <FileSpreadsheet className="h-4 w-4" aria-hidden />
                  Import from Excel
                </ButtonLink>
                <ButtonLink href="/office/students/new" variant="secondary">
                  <UserPlus className="h-4 w-4" aria-hidden />
                  Add a student
                </ButtonLink>
              </div>
            ) : null
          }
        >
          {isOffice
            ? "The quickest start is to import the whole school from the Excel sheet you already keep. You can also add students one at a time."
            : "The school office hasn’t added any students yet."}
        </EmptyState>
      ) : (
        <>
          <FilterBar>
            <SectionField sections={sectionList} value={section?.id} allowAll />
            <ChoiceField name="status" label="Status" value={status} options={STATUS_CHOICES} />
            <SearchBox value={q} placeholder="Name, SR no., login ID or mobile" />
          </FilterBar>

          {list.total ? (
            <>
              <p className="mb-3 text-[0.9rem] text-muted" role="status">
                {!filtering
                  ? `${list.total} current ${list.total === 1 ? "student" : "students"}.`
                  : list.total === list.schoolTotal
                    ? `All ${list.total} students, including any who have left.`
                    : `${list.total} of ${list.schoolTotal} ${list.schoolTotal === 1 ? "student" : "students"} ${list.total === 1 ? "matches" : "match"}.`}{" "}
                {filtering ? (
                  <Link href="/office/students" className="font-semibold text-forest-800 underline underline-offset-4">
                    Clear the filters
                  </Link>
                ) : null}
              </p>
              <Table caption={`Students${section ? ` in ${section.label}` : ""}, page ${list.page} of ${list.pages}`}>
                <thead>
                  <tr>
                    <Th>SR no.</Th>
                    <Th>Student</Th>
                    <Th>Class</Th>
                    <Th className="text-right">Roll no.</Th>
                    <Th>Father’s name</Th>
                    <Th>Parent’s mobile</Th>
                    <Th>Family sign-in</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.id} className="align-top hover:bg-cream-200/30">
                      <Td className="whitespace-nowrap tabular">{r.srNo}</Td>
                      <Td>
                        <Link
                          href={`/office/students/${r.id}`}
                          className="inline-flex min-h-6 items-center font-semibold text-forest-900 underline-offset-2 hover:underline"
                        >
                          {r.name}
                        </Link>
                        {r.rte || r.status !== "active" ? (
                          <span className="mt-1 flex flex-wrap gap-1.5">
                            {r.rte ? <RteBadge /> : null}
                            {r.status !== "active" ? <StudentStatusBadge status={r.status} /> : null}
                          </span>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {r.placement ? (
                          <>
                            {r.placement.label}
                            {r.placement.stream ? <span className="text-muted"> ({r.placement.stream})</span> : null}
                          </>
                        ) : (
                          <span className="text-muted">Not placed</span>
                        )}
                      </Td>
                      <Td className="text-right tabular">{r.placement?.rollNo ?? <span className="text-muted">—</span>}</Td>
                      <Td>{r.fatherName ?? <span className="text-muted">—</span>}</Td>
                      <Td className="whitespace-nowrap">
                        {r.guardianMobile ? (
                          <a href={`tel:+91${r.guardianMobile}`} className="inline-flex min-h-6 items-center gap-1.5 tabular text-forest-900 underline-offset-2 hover:underline">
                            <Phone className="h-3.5 w-3.5 text-muted" aria-hidden />
                            {r.guardianMobile}
                          </a>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <SignInBadge status={r.signIn} />
                        {r.loginId ? <span className="mt-1 block text-[0.85rem] text-muted tabular">{r.loginId}</span> : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pager page={list.page} pages={list.pages} total={list.total} perPage={PER_PAGE} href={href} noun="students" />
            </>
          ) : (
            <EmptyState icon={<Users className="h-5 w-5" aria-hidden />} title="No students match">
              Try another class, status or search, or{" "}
              <Link href="/office/students" className="font-semibold text-forest-800 underline underline-offset-4">
                clear the filters
              </Link>
              .{status === "active" ? " Students who have left are listed under the status “Left”, “Transferred” or “Passed out”." : ""}
            </EmptyState>
          )}
        </>
      )}
    </>
  );
}
