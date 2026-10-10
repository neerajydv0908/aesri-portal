import type { Metadata } from "next";
import { AlertTriangle, Phone, Users } from "lucide-react";
import { chooseSection, teacherPage } from "@/lib/page";
import { getSchool } from "@/lib/queries/school";
import { sectionRoster } from "@/lib/queries/records";
import { formatPercent } from "@/lib/services/attendance";
import { EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { FilterBar } from "@/components/pickers";
import { ChoiceField } from "@/components/records/list-parts";

export const metadata: Metadata = { title: "My students" };

export default async function TeachStudentsPage({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  const ctx = await teacherPage();
  const sp = await searchParams;
  const header = (
    <PageHeader
      eyebrow={ctx.isAdmin ? "Teaching" : `Session ${ctx.sessionId}`}
      title={ctx.isAdmin ? "Class lists" : "My students"}
      description={
        ctx.isAdmin
          ? "The students of each section, with their parents’ contact numbers and attendance this session."
          : "The students in the classes you teach. For your own class you also see the parents’ contact numbers and each student’s attendance."
      }
    />
  );
  if (!ctx.sections.length) {
    return (
      <>
        {header}
        <EmptyState icon={<Users className="h-5 w-5" aria-hidden />} title="No classes for you this session">
          You aren’t a class teacher and don’t teach a subject in any section this session. If that’s wrong, please tell the school office.
        </EmptyState>
      </>
    );
  }

  const section = chooseSection(ctx.sections, typeof sp.section === "string" ? sp.section : null)!;
  const isClassTeacher = ctx.classTeacherSections.some((s) => s.id === section.id);
  const [roster, school] = await Promise.all([sectionRoster(section.id, ctx.sessionId, isClassTeacher), getSchool(ctx.schoolId)]);
  const warnAt = school?.settings.attendanceWarnPercent ?? 75;
  const lowCount = roster.filter((r) => r.attendance?.percent !== null && r.attendance?.percent !== undefined && r.attendance.percent < warnAt).length;

  return (
    <>
      {header}
      {ctx.sections.length > 1 ? (
        <FilterBar>
          <ChoiceField
            name="section"
            label="Class"
            value={section.id}
            options={ctx.sections.map((s) => ({
              value: s.id,
              label: `${s.label}${s.stream ? ` (${s.stream})` : ""}${!ctx.isAdmin && ctx.classTeacherSections.some((c) => c.id === s.id) ? " · your class" : ""}`,
            }))}
          />
        </FilterBar>
      ) : null}

      <section aria-labelledby="roster-title">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="roster-title" className="font-display text-[1.35rem] text-forest-900">
            {section.longLabel}
          </h2>
          <p className="text-[0.9rem] text-muted">
            {roster.length} {roster.length === 1 ? "student" : "students"}
            {section.classTeacherName ? ` · Class teacher: ${section.classTeacherName}` : " · No class teacher yet"}
          </p>
        </div>
        {isClassTeacher && lowCount ? (
          <p className="mb-3 flex items-start gap-2 text-[0.92rem] text-forest-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-ochre-600" aria-hidden />
            {lowCount === 1 ? "1 student’s" : `${lowCount} students’`} attendance is below {warnAt}% this session.
          </p>
        ) : null}

        {roster.length ? (
          <Table caption={`Students of ${section.label}`}>
            <thead>
              <tr>
                <Th className="text-right">Roll no.</Th>
                <Th>Name</Th>
                <Th>SR no.</Th>
                {isClassTeacher ? (
                  <>
                    <Th>Father’s name</Th>
                    <Th>Parent’s mobile</Th>
                    <Th className="text-right">Attendance</Th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {roster.map((r) => {
                const low = r.attendance?.percent !== null && r.attendance?.percent !== undefined && r.attendance.percent < warnAt;
                return (
                  <tr key={r.id} className="align-top">
                    <Td className="text-right tabular">{r.rollNo ?? <span className="text-muted">—</span>}</Td>
                    <Td className="font-semibold text-forest-900">{r.name}</Td>
                    <Td className="tabular">{r.srNo}</Td>
                    {isClassTeacher ? (
                      <>
                        <Td>{r.contact?.fatherName ?? <span className="text-muted">—</span>}</Td>
                        <Td className="whitespace-nowrap">
                          {r.contact?.guardianMobile ? (
                            <a
                              href={`tel:+91${r.contact.guardianMobile}`}
                              className="inline-flex min-h-8 items-center gap-1.5 font-semibold text-forest-800 underline underline-offset-2"
                            >
                              <Phone className="h-3.5 w-3.5" aria-hidden />
                              <span className="tabular">{r.contact.guardianMobile}</span>
                              <span className="sr-only">(call {r.name}’s parent)</span>
                            </a>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </Td>
                        <Td className="whitespace-nowrap text-right">
                          <span className={low ? "inline-flex items-center gap-1.5 font-semibold text-clay-600" : "tabular"}>
                            {low ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : null}
                            <span className="tabular">{formatPercent(r.attendance?.percent)}</span>
                            {low ? <span className="sr-only">(below {warnAt}%)</span> : null}
                          </span>
                          {r.attendance?.days ? (
                            <span className="block text-[0.82rem] text-muted tabular">
                              {r.attendance.present + r.attendance.late} of {r.attendance.days} days
                            </span>
                          ) : (
                            <span className="block text-[0.82rem] text-muted">No register yet</span>
                          )}
                        </Td>
                      </>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <EmptyState icon={<Users className="h-5 w-5" aria-hidden />} title={`No students in ${section.label} yet`}>
            Once the office adds students to this class, they’ll appear here.
          </EmptyState>
        )}
        {!isClassTeacher && roster.length ? (
          <p className="mt-3 text-[0.88rem] text-muted">Parents’ contact numbers and attendance are shown to the class teacher of {section.label}.</p>
        ) : null}
      </section>
    </>
  );
}
