import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MessageSquareText, Pencil, Users } from "lucide-react";
import { ButtonLink, Card, CardTitle, EmptyState, Field, PageHeader, Select, TabLinks } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { ActionForm, FieldError } from "@/components/forms";
import { FilterBar, SectionField } from "@/components/pickers";
import { Flash, RemarkKindBadge, VisibilityBadge } from "@/components/daily/badges";
import { formatDate, todayIST } from "@/lib/dates";
import { teacherPage } from "@/lib/page";
import { sectionStudents } from "@/lib/queries/school";
import { listRemarks, recentRemarksCount, remarkCategoryLabel, staffRemarkReader, type RemarkKind } from "@/lib/services/remarks";
import { schoolSmsSettings } from "@/lib/queries/sms";
import { delayAfterSave, remarkDelaySeconds, smsMode } from "@/lib/sms/config";
import { eventOn } from "@/lib/sms/settings";
import { createRemarkAction, deleteRemarkAction } from "./actions";
import { RemarkFields } from "./fields";

export const metadata: Metadata = { title: "Remarks" };

export default async function TeachRemarksPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; student?: string; kind?: string; done?: string }>;
}) {
  const ctx = await teacherPage();
  const sp = await searchParams;
  const list = ctx.sections;
  const header = (
    <PageHeader
      eyebrow="Teaching"
      title="Remarks"
      description={
        ctx.isAdmin
          ? "Note what a student did well as readily as a concern. Families see the remarks you choose to show them."
          : "Note what a student did well as readily as a concern. Families see the remarks you choose to show them. Class teachers see every remark about their class; in other classes you see the remarks you wrote."
      }
    />
  );
  if (!list.length) {
    return (
      <>
        {header}
        <EmptyState icon={<Users className="h-5 w-5" aria-hidden />} title="No classes this session">
          You can record remarks about students in the classes you teach. If that’s wrong, please tell the school office.
        </EmptyState>
      </>
    );
  }
  const section = typeof sp.section === "string" && sp.section ? list.find((s) => s.id === sp.section) : list[0];
  if (!section) notFound();
  const kind: RemarkKind | undefined = sp.kind === "appreciation" || sp.kind === "concern" ? sp.kind : undefined;

  // Class teachers (and admins) see every remark about the section's students; a subject teacher only their own.
  const seesAll = ctx.isAdmin || ctx.classTeacherSections.some((s) => s.id === section.id);
  const reader = staffRemarkReader(ctx);
  const roll = await sectionStudents(section.id);
  const ids = roll.map((s) => s.id);
  const today = todayIST();
  const [rows, month] = await Promise.all([
    listRemarks(reader, { schoolId: ctx.schoolId, studentIds: ids, sessionId: ctx.sessionId, kind, limit: 60 }),
    recentRemarksCount(reader, { schoolId: ctx.schoolId, studentIds: ids, since: `${today.slice(0, 7)}-01` }),
  ]);
  const preselect = typeof sp.student === "string" && ids.includes(sp.student) ? sp.student : "";
  const smsNote =
    eventOn(await schoolSmsSettings(ctx.schoolId), "remark") && smsMode() !== "off"
      ? `The family also gets a text message (SMS) ${delayAfterSave(remarkDelaySeconds())}, saying there is a new note of appreciation or concern to read on the portal — never the note itself.`
      : null;
  const base = `/teach/remarks?section=${section.id}`;
  const classTeacher = section.classTeacherName ? `the class teacher (${section.classTeacherName})` : "the class teacher";

  return (
    <>
      {header}
      <Flash
        code={sp.done}
        messages={{
          updated: "The remark was updated.",
          shared: "The remark was updated and shared with the family. They will also get a text message saying there is a new note (not what it says).",
          unchanged: "Nothing had changed.",
          deleted: "The remark was deleted.",
        }}
      />
      {list.length > 1 ? (
        <FilterBar>
          <SectionField sections={list} value={section.id} />
        </FilterBar>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card>
          <CardTitle>Record a remark</CardTitle>
          {roll.length ? (
            <ActionForm action={createRemarkAction} resetOnSuccess>
              <input type="hidden" name="section" value={section.id} />
              <Field label="Student" htmlFor="student" required>
                <Select id="student" name="student" required defaultValue={preselect} aria-describedby="student-error">
                  <option value="" disabled>
                    Choose a student of {section.label}…
                  </option>
                  {roll.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.rollNo ? `${s.rollNo}. ` : ""}
                      {s.name}
                    </option>
                  ))}
                </Select>
                <FieldError name="student" />
              </Field>
              <RemarkFields smsNote={smsNote} />
              <div>
                <SubmitButton pendingLabel="Saving…">Save remark</SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <p className="text-muted">There are no students in {section.label} yet.</p>
          )}
        </Card>

        <section aria-labelledby="recent-remarks">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <h2 id="recent-remarks" className="font-display text-[1.35rem] text-forest-900">
              {seesAll ? `Recent remarks in ${section.label}` : `Your remarks in ${section.label}`}
            </h2>
            <p className="text-[0.9rem] text-muted">
              {seesAll ? "This month" : "Yours this month"}: {month.appreciation} {month.appreciation === 1 ? "appreciation" : "appreciations"}, {month.concern}{" "}
              {month.concern === 1 ? "concern" : "concerns"}
            </p>
          </div>
          {seesAll ? null : (
            <p className="mb-4 text-[0.92rem] text-muted">
              You see the remarks you have written about students of {section.label}. Only {classTeacher} and the school office see every remark about this class.
            </p>
          )}
          <TabLinks
            current={kind ?? "all"}
            tabs={[
              { key: "all", href: base, label: "All" },
              { key: "appreciation", href: `${base}&kind=appreciation`, label: "Appreciations" },
              { key: "concern", href: `${base}&kind=concern`, label: "Concerns" },
            ]}
          />
          {rows.length ? (
            <ul className="grid gap-3">
              {rows.map((r) => {
                // Class teachers and admins manage every remark about their class; others only their own (the list holds nothing else).
                const mayChange = seesAll || r.recordedBy === ctx.actor.accountId;
                return (
                  <li key={r.id} className="card p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <RemarkKindBadge kind={r.kind} />
                      <span className="text-[0.88rem] font-semibold text-muted">{remarkCategoryLabel(r.category)}</span>
                      <VisibilityBadge visible={r.visibleToGuardian} />
                    </div>
                    <p className="mt-2 font-semibold text-forest-900">
                      {r.studentName}
                      {r.rollNo ? <span className="font-normal text-muted"> · roll {r.rollNo}</span> : null}
                    </p>
                    <p className="mt-1 whitespace-pre-line text-forest-900">{r.note}</p>
                    {r.actionTaken ? (
                      <p className="mt-2 whitespace-pre-line text-[0.95rem] text-forest-900">
                        <span className="font-semibold">Action taken: </span>
                        {r.actionTaken}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[0.85rem] text-muted">
                        {r.recordedByPerson ? `${r.recordedByPerson.name} · ` : ""}
                        {formatDate(r.recordedOn, "en", { weekday: true })}
                      </p>
                      {mayChange ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <ButtonLink href={`/teach/remarks/${r.id}`} variant="ghost" size="sm">
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                            Edit<span className="sr-only"> remark about {r.studentName}</span>
                          </ButtonLink>
                          <ActionForm action={deleteRemarkAction} className="gap-2">
                            <input type="hidden" name="id" value={r.id} />
                            <div>
                              <ConfirmSubmit question="Delete this remark?" confirmLabel="Yes, delete">
                                Delete<span className="sr-only"> remark about {r.studentName}</span>
                              </ConfirmSubmit>
                            </div>
                          </ActionForm>
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon={<MessageSquareText className="h-5 w-5" aria-hidden />} title="No remarks yet">
              {seesAll
                ? kind === "appreciation"
                  ? `No appreciations for ${section.label} yet.`
                  : kind === "concern"
                    ? `No concerns recorded for ${section.label}.`
                    : `Remarks about students of ${section.label} will appear here.`
                : kind === "appreciation"
                  ? `You haven’t written any appreciations for ${section.label} yet.`
                  : kind === "concern"
                    ? `You haven’t recorded any concerns for ${section.label}.`
                    : `Remarks you write about students of ${section.label} will appear here.`}
            </EmptyState>
          )}
        </section>
      </div>
    </>
  );
}
