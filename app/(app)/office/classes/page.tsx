import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleAlert, CircleCheck, Layers } from "lucide-react";
import { officePage } from "@/lib/page";
import { classDetail, classesOverview, isUuid, subjectList, type ClassSummary } from "@/lib/services/classes";
import { EmptyState, PageHeader, Select, TabLinks, Table, Td, Th } from "@/components/ui";
import { FilterBar } from "@/components/pickers";
import { Flash } from "@/components/flash";
import { ClassDetailView } from "./class-detail";
import { SubjectListView } from "./subject-list";

export const metadata: Metadata = { title: "Classes & subjects" };

type SP = { class?: string; view?: string; done?: string };

export default async function ClassesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await officePage();
  const sp = await searchParams;
  const view = sp.view === "subjects" ? "subjects" : "classes";
  const requested = view === "classes" && typeof sp.class === "string" && sp.class ? sp.class : null;
  // Another school's class (or anything that isn't a class) is simply not found.
  const [overview, detail, subjects] = await Promise.all([
    classesOverview(ctx.schoolId, ctx.sessionId),
    requested ? classDetail(ctx.schoolId, ctx.sessionId, requested) : Promise.resolve(null),
    view === "subjects" ? subjectList(ctx.schoolId) : Promise.resolve(null),
  ]);
  if (requested && (!isUuid(requested) || !detail)) notFound();

  return (
    <>
      <PageHeader
        eyebrow={`School office · Session ${ctx.sessionId}`}
        title="Classes & subjects"
        description="Sections and class teachers for this session, the subjects each class is taught, and who teaches them."
      />
      <Flash
        code={sp.done}
        messages={{
          "section-removed": "The section was removed.",
          "subject-removed": "The subject was removed from the school's list.",
        }}
      />
      <TabLinks
        current={view}
        tabs={[
          { key: "classes", href: "/office/classes", label: "Classes" },
          { key: "subjects", href: "/office/classes?view=subjects", label: "School subjects" },
        ]}
      />

      {view === "subjects" ? (
        <SubjectListView subjects={subjects ?? []} />
      ) : (
        <>
          {overview.length ? (
            <FilterBar submitLabel="Open">
              <div className="grid gap-1.5">
                <label htmlFor="pick-class" className="text-[0.85rem] font-semibold text-forest-900">
                  Class
                </label>
                <Select id="pick-class" name="class" defaultValue={detail?.cls.id ?? ""} className="min-w-52">
                  {!detail ? <option value="">Choose a class…</option> : null}
                  {overview.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </div>
            </FilterBar>
          ) : null}
          {detail ? <ClassDetailView detail={detail} /> : null}
          <section aria-labelledby="all-classes" className={detail ? "mt-12" : undefined}>
            <h2 id="all-classes" className="mb-1 font-display text-[1.35rem] text-forest-900">
              All classes
            </h2>
            <p className="mb-4 text-[0.95rem] text-muted">{detail ? "Open another class to set it up." : "Open a class to set its sections, class teachers, subjects and subject teachers."}</p>
            {overview.length ? (
              <SummaryTable rows={overview} current={detail?.cls.id ?? null} />
            ) : (
              <EmptyState icon={<Layers className="h-5 w-5" aria-hidden />} title="No classes yet">
                The school&rsquo;s classes are added when the portal is set up. Please ask the AESRI administrator.
              </EmptyState>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Progress({ done, of, none }: { done: number; of: number; none: string }) {
  if (!of) return <span className="text-muted">{none}</span>;
  const complete = done >= of;
  return (
    <span className={`inline-flex items-center gap-1.5 tabular ${complete ? "text-forest-800" : "font-semibold text-ochre-600"}`}>
      {complete ? <CircleCheck className="h-4 w-4 shrink-0" aria-hidden /> : <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />}
      {done} of {of}
      <span className="sr-only">{complete ? " (complete)" : " (some missing)"}</span>
    </span>
  );
}

function SummaryTable({ rows, current }: { rows: ClassSummary[]; current: string | null }) {
  return (
    <Table caption="Every class this session: sections, class teachers, subjects and subject teachers">
      <thead>
        <tr>
          <Th>Class</Th>
          <Th>Sections</Th>
          <Th>Class teachers</Th>
          <Th className="text-right">Subjects</Th>
          <Th>Subject teachers</Th>
          <Th className="text-right">Students</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id} className={c.id === current ? "bg-sage-50" : undefined}>
            <Td className="whitespace-nowrap">
              <Link
                href={`/office/classes?class=${c.id}`}
                aria-current={c.id === current ? "page" : undefined}
                className="inline-flex min-h-8 items-center font-semibold text-forest-800 underline-offset-2 hover:underline"
              >
                {c.label}
              </Link>
            </Td>
            <Td className="text-[0.92rem]">{c.sections.length ? c.sections.map((s) => s.name).join(", ") : <span className="text-muted">None</span>}</Td>
            <Td>
              <Progress done={c.classTeachersSet} of={c.sections.length} none="—" />
            </Td>
            <Td className="text-right tabular">{c.subjects || <span className="text-muted">None</span>}</Td>
            <Td>
              <Progress done={c.assignmentsSet} of={c.assignmentsNeeded} none={c.subjects ? "—" : "No subjects yet"} />
            </Td>
            <Td className="text-right tabular">{c.students}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
