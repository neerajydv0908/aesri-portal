import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, HandHelping, ShieldCheck } from "lucide-react";
import { Card, CardTitle, EmptyState, PageHeader, TabLinks } from "@/components/ui";
import { FilterBar, SectionField } from "@/components/pickers";
import { EstimatePercent, SupportBadge, SupportIcon } from "@/components/support/badge";
import { EstimatesNotice } from "@/components/support/estimates-status";
import { teacherPage } from "@/lib/page";
import { canManageSection } from "@/lib/auth/dal";
import { todayIST } from "@/lib/dates";
import { staffRemarkReader } from "@/lib/services/remarks";
import { schoolSupportRule, schoolThresholds, sectionFigures } from "@/lib/queries/student-figures";
import { sectionEstimates, supportContext } from "@/lib/studai/estimates";
import { COLOURS, COLOUR_WORDS, SUPPORT_INFO, isSupportColour, notCovered, ruleSentences, supportStatus, type SupportColour } from "@/lib/support/rules";

export const metadata: Metadata = { title: "Needs support" };

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * Teachers only: which students may need support now — Stud-AI's estimate
 * for every subject, and attendance with teachers' concerns — with every
 * reason shown. Class teachers see their own sections; admins any section
 * of the school. Never shown to families or students.
 */
export default async function SupportPage({ searchParams }: { searchParams: Search }) {
  const ctx = await teacherPage();
  const sp = await searchParams;
  const allowed = ctx.isAdmin ? ctx.sections : ctx.classTeacherSections;
  const header = (
    <PageHeader
      eyebrow="Teaching"
      title="Needs support"
      description="Which students may need a hand now: Stud-AI’s estimate for every subject, and attendance together with teachers’ concerns. For teachers only — families and students never see it."
      className="pb-6"
    />
  );
  if (!allowed.length) {
    return (
      <>
        {header}
        <EmptyState icon={<HandHelping className="h-5 w-5" aria-hidden />} title="This view is for class teachers">
          You aren&rsquo;t the class teacher of a section this session. If that&rsquo;s wrong, please tell the school office.
        </EmptyState>
      </>
    );
  }
  const requested = one(sp.section);
  const section = requested ? allowed.find((s) => s.id === requested) : (allowed.find((s) => s.studentCount > 0) ?? allowed[0]);
  if (!section || !(await canManageSection(ctx.actor, section.id, "class_teacher"))) notFound();
  const filter: SupportColour | null = isSupportColour(one(sp.colour)) ? (one(sp.colour) as SupportColour) : null;

  const [thresholds, rule] = await Promise.all([schoolThresholds(ctx.schoolId), schoolSupportRule(ctx.schoolId)]);
  const today = todayIST();
  const [{ students, figures }, estimates] = await Promise.all([
    sectionFigures(ctx, section, { today, reader: staffRemarkReader(ctx), passPercent: thresholds.passPercent, concernDays: rule.concernDays }),
    sectionEstimates(ctx, section, { today }),
  ]);
  const list = students
    .map((s) => {
      const est = estimates.byStudent.get(s.id) ?? { subjects: [], inputs: [], outdated: false };
      return { ...s, est, status: supportStatus(figures.get(s.id)!, est.subjects, rule, thresholds.passPercent, supportContext(est, estimates.status, estimates.trained)) };
    })
    .sort(
      (a, b) =>
        COLOURS.indexOf(a.status.colour) - COLOURS.indexOf(b.status.colour) ||
        (a.rollNo ?? 999) - (b.rollNo ?? 999) ||
        a.name.localeCompare(b.name),
    );
  const counts = Object.fromEntries(COLOURS.map((c) => [c, list.filter((s) => s.status.colour === c).length])) as Record<SupportColour, number>;
  const shown = filter ? list.filter((s) => s.status.colour === filter) : list;
  const base = `/teach/support?section=${section.id}`;
  const rules = ruleSentences(rule, thresholds.passPercent);

  return (
    <>
      {header}
      {allowed.length > 1 ? (
        <FilterBar>
          <SectionField sections={allowed} value={section.id} />
        </FilterBar>
      ) : null}

      <EstimatesNotice status={estimates.status} className="mb-5" />
      <p className="-mt-2 mb-5 text-[0.92rem] text-muted">
        <a href="#how-colours" className="inline-flex min-h-6 items-center font-semibold text-forest-800 underline underline-offset-2">
          How the colours are decided
        </a>{" "}
        — the same rule for every student. Students needing support are shown first.
      </p>
      <div className="grid grid-cols-1 items-start gap-6 2xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="support-list" className="min-w-0">
          <h2 id="support-list" className="mb-3 font-display text-[1.45rem] text-forest-900">
            {section.longLabel}
          </h2>
          <TabLinks
            current={filter ?? "all"}
            tabs={[
              { key: "all", href: base, label: `All (${list.length})` },
              ...COLOURS.map((c) => ({ key: c, href: `${base}&colour=${c}`, label: `${COLOUR_WORDS[c]} (${counts[c]})` })),
            ]}
          />
          {!students.length ? (
            <EmptyState title="No students in this class">Students appear here once the office places them in {section.label}.</EmptyState>
          ) : !shown.length ? (
            <EmptyState title={`Nobody in “${COLOUR_WORDS[filter!]}”`}>No student of {section.label} is in this group at the moment.</EmptyState>
          ) : (
            <ul className="grid gap-3">
              {shown.map((s) => (
                <li key={s.id} className="card p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-forest-900">
                        {s.rollNo ? <span className="tabular text-muted">{s.rollNo}. </span> : null}
                        {s.name}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <SupportBadge colour={s.status.colour} />
                        {s.est.outdated ? <span className="text-[0.82rem] font-semibold text-ochre-600">Estimates out of date</span> : null}
                      </div>
                    </div>
                    <Link
                      href={`/teach/support/${s.id}`}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[0.92rem] font-semibold text-forest-800 ring-1 ring-forest-900/15 hover:ring-forest-900/35"
                    >
                      Details and reasons
                      <span className="sr-only"> for {s.name}</span>
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </Link>
                  </div>
                  {s.status.reasons.length || s.status.review.length ? (
                    <ul className="mt-3 grid gap-1 text-[0.93rem]">
                      {s.status.reasons.map((r) => (
                        <li key={`r:${r}`} className="flex items-start gap-2">
                          <SupportIcon colour="red" className="mt-1 h-3.5 w-3.5 shrink-0 text-clay-600" />
                          <span>
                            <span className="sr-only">Needs support: </span>
                            {r}
                          </span>
                        </li>
                      ))}
                      {s.status.review.map((r) => (
                        <li key={`v:${r}`} className="flex items-start gap-2">
                          <SupportIcon colour="amber" className="mt-1 h-3.5 w-3.5 shrink-0 text-ochre-600" />
                          <span>
                            <span className="sr-only">Review needed: </span>
                            {r}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : s.status.colour === "grey" ? (
                    <p className="mt-2 text-[0.92rem] text-muted">{s.status.greyWhy}</p>
                  ) : null}
                  {s.est.subjects.length ? (
                    <p className="mt-2 text-[0.88rem] text-forest-900/90">
                      <span className="font-semibold">Stud-AI, risk of not passing:</span>{" "}
                      {[...s.est.subjects]
                        .filter((e) => !notCovered(e) || s.status.misnamed.some((m) => m.subjectId === e.subjectId))
                        .sort((a, b) => a.subjectName.localeCompare(b.subjectName))
                        .map((e, i) => (
                          <span key={e.subjectId}>
                            {i ? ", " : ""}
                            {e.subjectName}{" "}
                            <EstimatePercent percent={e.percent} knownSubject={e.knownSubject} unsure={s.status.misnamed.some((m) => m.subjectId === e.subjectId)} />
                          </span>
                        ))}
                      {s.status.notCovered.length ? (
                        <span className="text-muted">
                          {s.est.subjects.length > s.status.notCovered.length ? "; " : ""}not enough data as of now for {s.status.notCovered.join(", ")}
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                  {s.status.strengths.length ? (
                    <p className="mt-2 text-[0.88rem] text-forest-900/85">
                      <span className="font-semibold">Going well:</span> {s.status.strengths.join("; ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <Card as="section" className="scroll-mt-24 !p-5 sm:!p-6">
          <div id="how-colours" className="scroll-mt-24" />
          <CardTitle>How the colours are decided</CardTitle>
          <p className="text-[0.92rem] text-forest-900/90">The school&rsquo;s rule (Settings), the same for every student.</p>
          <dl className="mt-4 grid gap-4 text-[0.9rem]">
            {COLOURS.map((c) => (
              <div key={c}>
                <dt>
                  <SupportBadge colour={c} />
                </dt>
                <dd className="mt-1.5">
                  {rules[c].length > 1 ? <p className="text-muted">Either of these:</p> : null}
                  <ul className={rules[c].length > 1 ? "mt-0.5 list-disc pl-5" : ""}>
                    {rules[c].map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-[0.85rem] text-muted">
            Stud-AI estimates each subject from this session&rsquo;s test marks, homework done in that subject and attendance, using patterns from past students. Attendance
            counts once {SUPPORT_INFO.minAttendanceDays} register days are recorded.
          </p>
          <p className="mt-3 text-[0.85rem] text-muted">
            Subjects Stud-AI wasn&rsquo;t trained on (for example Hindi or EVS) show &ldquo;Not enough data as of now&rdquo; and don&rsquo;t change the colour on their
            own. Their marks still count: in any subject, a most recent exam mark below the pass mark, or an absence from that exam, means &ldquo;Review needed&rdquo;,
            never &ldquo;On track&rdquo;.
          </p>
          <p className="mt-3 flex items-start gap-2 text-[0.85rem] text-forest-900/85">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-forest-700" aria-hidden />
            An estimate is a prompt to help early, not a judgement of the child, and it can be wrong. Never shown to families or students, and never used for marks,
            promotion or admission.
          </p>
        </Card>
      </div>
    </>
  );
}
