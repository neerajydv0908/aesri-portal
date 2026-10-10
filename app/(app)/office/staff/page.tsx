import type { Metadata } from "next";
import Link from "next/link";
import { FileSpreadsheet, IdCard, UserPlus } from "lucide-react";
import { officePage } from "@/lib/page";
import { ACCESS_LABELS, type StaffAccess } from "@/lib/roles";
import { listStaffRecords, type StaffStatusFilter } from "@/lib/queries/records";
import { isStaffAccess } from "@/lib/services/staff";
import { ButtonLink, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { FilterBar } from "@/components/pickers";
import { SignInBadge, StaffStatusBadge } from "@/components/records/badges";
import { ChoiceField } from "@/components/records/list-parts";
import { ACCESS_ORDER } from "@/components/records/staff-fields";

export const metadata: Metadata = { title: "Staff" };

const STATUS_CHOICES: { value: StaffStatusFilter; label: string }[] = [
  { value: "active", label: "Current" },
  { value: "left", label: "Left" },
  { value: "all", label: "All" },
];

type SearchParams = Record<string, string | string[] | undefined>;
const one = (sp: SearchParams, key: string) => (typeof sp[key] === "string" ? (sp[key] as string) : "");

export default async function StaffPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { schoolId, sessionId } = await officePage();
  const sp = await searchParams;
  const statusParam = one(sp, "status");
  const status: StaffStatusFilter = statusParam === "left" || statusParam === "all" ? statusParam : "active";
  const accessParam = one(sp, "access");
  const access: StaffAccess | "all" = isStaffAccess(accessParam) ? accessParam : "all";
  const filtering = status !== "active" || access !== "all";
  const rows = await listStaffRecords(schoolId, sessionId, { status, access });
  const anyStaff = rows.length > 0 || (filtering && (await listStaffRecords(schoolId, sessionId, { status: "all", access: "all" })).length > 0);

  return (
    <>
      <PageHeader
        eyebrow={`Records · Session ${sessionId}`}
        title="Staff"
        description="Everyone who works at the school, what they can do in the portal, and their classes this session. Open a staff member to change their details, access or classes."
        actions={
          <>
            <ButtonLink href="/office/staff/new">
              <UserPlus className="h-4 w-4" aria-hidden />
              Add a staff member
            </ButtonLink>
            <ButtonLink href="/office/import" variant="secondary">
              <FileSpreadsheet className="h-4 w-4" aria-hidden />
              Import from Excel
            </ButtonLink>
          </>
        }
      />

      {!anyStaff ? (
        <EmptyState
          icon={<IdCard className="h-5 w-5" aria-hidden />}
          title="No staff yet"
          action={
            <div className="flex flex-wrap justify-center gap-2.5">
              <ButtonLink href="/office/import">
                <FileSpreadsheet className="h-4 w-4" aria-hidden />
                Import from Excel
              </ButtonLink>
              <ButtonLink href="/office/staff/new" variant="secondary">
                <UserPlus className="h-4 w-4" aria-hidden />
                Add a staff member
              </ButtonLink>
            </div>
          }
        >
          Import the staff list from the school’s Excel sheet, or add people one at a time. Teachers can sign in once their activation slip is printed.
        </EmptyState>
      ) : (
        <>
          <FilterBar>
            <ChoiceField name="status" label="Status" value={status} options={STATUS_CHOICES} />
            <ChoiceField
              name="access"
              label="Portal access"
              value={access}
              options={[{ value: "all", label: "Any access" }, ...ACCESS_ORDER.map((a) => ({ value: a, label: ACCESS_LABELS[a] }))]}
            />
          </FilterBar>

          {rows.length ? (
            <>
              <p className="mb-3 text-[0.9rem] text-muted" role="status">
                {rows.length} {rows.length === 1 ? "person" : "people"}
                {filtering ? " match." : " working at the school now."}{" "}
                {filtering ? (
                  <Link href="/office/staff" className="font-semibold text-forest-800 underline underline-offset-4">
                    Clear the filters
                  </Link>
                ) : null}
              </p>
              <Table caption="Staff with their portal access and classes">
                <thead>
                  <tr>
                    <Th className="whitespace-nowrap">Emp. no.</Th>
                    <Th>Name</Th>
                    <Th>Designation</Th>
                    <Th>Portal access</Th>
                    <Th>Sign-in</Th>
                    <Th className="whitespace-nowrap">Class teacher of</Th>
                    <Th>Subjects taught</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="align-top hover:bg-cream-200/30">
                      <Td className="whitespace-nowrap tabular">{r.empNo}</Td>
                      <Td>
                        <Link href={`/office/staff/${r.id}`} className="inline-flex min-h-6 items-center font-semibold text-forest-900 underline-offset-2 hover:underline">
                          {r.name}
                        </Link>
                        {r.status !== "active" ? (
                          <span className="mt-1 flex">
                            <StaffStatusBadge status={r.status} />
                          </span>
                        ) : null}
                      </Td>
                      <Td>{r.designation ?? <span className="text-muted">—</span>}</Td>
                      <Td className="whitespace-nowrap">{ACCESS_LABELS[r.access]}</Td>
                      <Td className="whitespace-nowrap">
                        <SignInBadge status={r.signIn} />
                        {r.loginId ? <span className="mt-1 block text-[0.85rem] text-muted tabular">{r.loginId}</span> : null}
                      </Td>
                      <Td className="whitespace-nowrap">{r.classTeacherOf.length ? r.classTeacherOf.map((c) => c.label).join(", ") : <span className="text-muted">—</span>}</Td>
                      <Td className="min-w-52 text-[0.9rem]">{r.subjects.length ? r.subjects.join(", ") : <span className="text-muted">—</span>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          ) : (
            <EmptyState icon={<IdCard className="h-5 w-5" aria-hidden />} title="No staff match">
              Try another status or access, or{" "}
              <Link href="/office/staff" className="font-semibold text-forest-800 underline underline-offset-4">
                clear the filters
              </Link>
              .
            </EmptyState>
          )}
        </>
      )}
    </>
  );
}
