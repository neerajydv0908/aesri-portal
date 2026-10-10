import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Phone } from "lucide-react";
import { officePage } from "@/lib/page";
import { OFFICE_ROLES, STUDENT_LOOKUP_ROLES } from "@/lib/roles";
import { getDb } from "@/lib/db/client";
import { classLabel } from "@/lib/classes";
import { formatDate, todayIST } from "@/lib/dates";
import { getSchool, listSections } from "@/lib/queries/school";
import { sameRollNo, studentRecord } from "@/lib/queries/records";
import { attendanceSummary, formatPercent } from "@/lib/services/attendance";
import { latestPublishedResult } from "@/lib/services/exams";
import { currentPlan, familyFeeSummary, hasAdmissionCharge, rupees } from "@/lib/services/fees";
import { examsWithMarks, resultMismatches } from "@/lib/services/students";
import { ActionForm } from "@/components/forms";
import { Flash } from "@/components/flash";
import { Alert, Card, CardTitle, Dl, Money, PageHeader, Stat } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { RteBadge, STUDENT_STATUS_LABELS, StudentStatusBadge } from "@/components/records/badges";
import { FormDisclosure } from "@/components/records/disclosure";
import { SelectField, TextField } from "@/components/records/fields";
import { listText } from "@/components/records/form-state";
import { SignInCard } from "@/components/records/sign-in";
import { FamilyFields, StudentPersonFields } from "@/components/records/student-fields";
import { currentAgainAction, placeAction, rteAction, saveDetailsAction, statusAction } from "./actions";
import { schoolSmsSettings, studentSmsHistory, studentSmsInfo } from "@/lib/queries/sms";
import { StudentSmsCard } from "./sms-card";

export const metadata: Metadata = { title: "Student record" };

const GENDER: Record<string, string> = { F: "Girl", M: "Boy", O: "Other" };
const dash = <span className="text-muted">—</span>;

export default async function StudentRecordPage({ params, searchParams }: { params: Promise<{ studentId: string }>; searchParams: Promise<{ done?: string }> }) {
  const { actor, schoolId, sessionId } = await officePage(STUDENT_LOOKUP_ROLES);
  const { studentId } = await params;
  const sp = await searchParams;
  const s = await studentRecord(schoolId, sessionId, studentId);
  if (!s) notFound();

  const isOffice = OFFICE_ROLES.includes(actor.role);
  const current = s.status === "active";
  const today = todayIST();
  const db = await getDb();
  const p = s.placement;
  const [school, fees, att, result, sectionList, sharedRoll, admissionCharged, plan, smsInfo, smsSettings, smsHistory] = await Promise.all([
    getSchool(schoolId),
    familyFeeSummary(s.id, sessionId),
    isOffice ? attendanceSummary(s.id, sessionId) : null,
    isOffice ? latestPublishedResult(s.id, sessionId) : null,
    isOffice && current ? listSections(schoolId, sessionId) : [],
    p?.rollNo && current ? sameRollNo(db, p.sectionId, p.rollNo, s.id) : [],
    sp.done === "created" ? hasAdmissionCharge(db, s.id) : false,
    sp.done === "created" ? currentPlan(db, schoolId) : null,
    isOffice ? studentSmsInfo(schoolId, s.id) : null,
    isOffice ? schoolSmsSettings(schoolId) : null,
    isOffice ? studentSmsHistory(schoolId, s.id, 10) : [],
  ]);
  const loginId = s.signIn?.loginId ?? null;
  const slipHref = loginId ? `/office/access?q=${encodeURIComponent(loginId)}` : null;
  const warnAt = school?.settings.attendanceWarnPercent ?? 75;
  const admissionFee = plan?.oneTime.find((o) => o.key === "admission");
  const rollNote = sharedRoll.length && p ? `Roll no. ${p.rollNo} in ${p.label} is also given to ${listText(sharedRoll.map((o) => o.name))} — please check.` : null;
  // Exam results are published per section: once the student has marks, moves are limited (placeStudent refuses the rest).
  const withMarks = isOffice && current && p ? await examsWithMarks(db, schoolId, sessionId, s.id) : [];
  const sameClass = p ? sectionList.filter((sec) => sec.classId === p.classId && sec.id !== p.sectionId) : [];
  const blockedMoves = p ? sameClass.map((sec) => ({ sec, clashes: resultMismatches(withMarks, p.sectionId, sec.id) })).filter((b) => b.clashes.length) : [];
  const moveHint =
    p && withMarks.length
      ? `Has marks in ${listText(withMarks.map((e) => e.name))} this session, so ${
          sameClass.length ? `can move only to another section of ${classLabel(p.className, p.stream)}` : "the class can’t be changed"
        }${blockedMoves.length ? ` — not to ${listText(blockedMoves.map((b) => b.sec.label))} for now` : ""}.`
      : undefined;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/office/students" className="inline-flex min-h-6 items-center gap-1.5 hover:text-forest-900">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Students
          </Link>
        }
        title={s.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="tabular">SR no. {s.srNo}</span>
            {loginId ? (
              <>
                <span aria-hidden>·</span>
                <span className="tabular">Login ID {loginId}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span>{p ? `${classLabel(p.className, p.stream)} – section ${p.sectionName}` : "Not placed in a class this session"}</span>
            {p?.rollNo ? (
              <>
                <span aria-hidden>·</span>
                <span className="tabular">Roll no. {p.rollNo}</span>
              </>
            ) : null}
            <StudentStatusBadge status={s.status} />
            {s.rte ? <RteBadge /> : null}
          </span>
        }
      />

      <Flash
        code={sp.done}
        messages={{
          created: (
            <>
              <strong className="font-semibold">{s.name} was added.</strong> The family’s login ID is <strong className="font-semibold tabular">{loginId}</strong>.{" "}
              {slipHref ? (
                <>
                  <Link href={slipHref} className="font-semibold underline underline-offset-2">
                    Print their activation slip
                  </Link>{" "}
                  so they can sign in.
                </>
              ) : null}
              {admissionCharged && admissionFee ? ` The admission fee (${rupees(admissionFee.amount)}) is on their fee lines.` : ""}
              {rollNote ? ` ${rollNote}` : ""}
            </>
          ),
          current: (
            <>
              <strong className="font-semibold">{s.name} is a current student again.</strong>{" "}
              {s.signIn?.status === "active"
                ? "The family can sign in with their password again."
                : s.signIn?.status === "pending"
                  ? "Print an activation slip so the family can sign in."
                  : ""}
              {!p ? " Next, place the student in a class for this session." : ""}
            </>
          ),
        }}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Stat
          label="Fees due now"
          value={<Money paise={fees.dueNow} />}
          tone={fees.overdue ? "red" : fees.dueNow ? "amber" : "default"}
          hint={
            s.rte
              ? "RTE seat: no fees are charged."
              : `${fees.overdue ? `${rupees(fees.overdue)} overdue` : "Nothing overdue"} · ${fees.nextDue ? `next ${rupees(fees.nextDue.amount)} on ${formatDate(fees.nextDue.dueOn)}` : `${rupees(fees.paidThisSession)} paid this session`}`
          }
          href={`/office/fees/students/${s.id}`}
        />
        {att ? (
          <Stat
            label="Attendance this session"
            value={formatPercent(att.percent)}
            tone={att.percent !== null && att.percent < warnAt ? "amber" : "default"}
            hint={
              att.days
                ? `Present ${att.present + att.late} of ${att.days} days${att.absent ? ` · ${att.absent} absent` : ""}${att.percent !== null && att.percent < warnAt ? ` · below ${warnAt}%` : ""}`
                : "No register taken yet"
            }
          />
        ) : null}
        {isOffice ? (
          <Stat
            label="Latest result"
            value={result?.outcome === "absent" ? "Absent" : result?.percent !== null && result?.percent !== undefined ? formatPercent(result.percent) : "—"}
            hint={
              result
                ? `${result.examName} · ${
                    result.outcome === "absent"
                      ? "absent from every paper"
                      : result.percent === null
                        ? "no marks recorded"
                        : result.passedAll
                          ? "passed every subject"
                          : "below the pass mark in a subject"
                  }`
                : "No result published this session yet"
            }
          />
        ) : null}
      </div>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="grid min-w-0 gap-6">
          <Card>
            <CardTitle>Details</CardTitle>
            <Dl
              items={[
                // The accounts role only needs what fee work needs: not the date of birth or gender.
                ...(isOffice
                  ? [
                      { label: "Gender", value: s.gender ? (GENDER[s.gender] ?? s.gender) : dash },
                      { label: "Date of birth", value: s.dob ? formatDate(s.dob) : dash },
                    ]
                  : []),
                { label: "Admission date", value: s.admittedOn ? formatDate(s.admittedOn) : dash },
                { label: "Father’s name", value: s.fatherName ?? dash },
                { label: "Mother’s name", value: s.motherName ?? dash },
                { label: "Guardian’s name", value: s.guardianName ?? dash },
                {
                  label: "Parent’s mobile",
                  value: s.guardianMobile ? (
                    <a href={`tel:+91${s.guardianMobile}`} className="inline-flex min-h-6 items-center gap-1.5 tabular underline-offset-2 hover:underline">
                      <Phone className="h-3.5 w-3.5 text-muted" aria-hidden />
                      {s.guardianMobile}
                    </a>
                  ) : (
                    dash
                  ),
                },
                {
                  label: "Second mobile",
                  value: s.mobile2 ? (
                    <a href={`tel:+91${s.mobile2}`} className="inline-flex min-h-6 items-center gap-1.5 tabular underline-offset-2 hover:underline">
                      <Phone className="h-3.5 w-3.5 text-muted" aria-hidden />
                      {s.mobile2}
                    </a>
                  ) : (
                    dash
                  ),
                },
                { label: "Village or address", value: s.address ?? dash },
                { label: "RTE seat", value: s.rte ? "Yes" : "No" },
              ]}
            />
            {isOffice ? (
              <div className="mt-6 border-t border-forest-900/10 pt-5">
                <ActionForm action={saveDetailsAction.bind(null, s.id)} aria-label="Edit details">
                  <FormDisclosure summary="Edit details">
                    <StudentPersonFields today={today} defaults={s} />
                    <FamilyFields defaults={s} />
                    <p className="text-[0.88rem] text-muted">
                      The SR no. ({s.srNo}) can’t be changed, because it is the family’s login ID. If it is wrong, please ask the AESRI administrator.
                    </p>
                    <div>
                      <SubmitButton pendingLabel="Saving…">Save details</SubmitButton>
                    </div>
                  </FormDisclosure>
                </ActionForm>
              </div>
            ) : null}
          </Card>

          {isOffice ? (
            <Card>
              <CardTitle>Class this session</CardTitle>
              <p className="mb-4 text-forest-900">
                {p ? (
                  <>
                    {classLabel(p.className, p.stream)}, section {p.sectionName}
                    {p.rollNo ? `, roll no. ${p.rollNo}` : ", no roll no. yet"}.
                  </>
                ) : (
                  `Not placed in a class for the ${sessionId} session.`
                )}
              </p>
              {rollNote ? (
                <Alert tone="amber" className="mb-4">
                  {rollNote}
                </Alert>
              ) : null}
              {current ? (
                <ActionForm action={placeAction.bind(null, s.id)} aria-label="Class and section">
                  <div className="grid gap-5 sm:grid-cols-2">
                    <SelectField name="sectionId" label="Class and section" required defaultValue={p?.sectionId ?? ""} hint={moveHint}>
                      {p ? null : <option value="">Choose a class</option>}
                      {sectionList.map((sec) => (
                        <option key={sec.id} value={sec.id}>
                          {sec.label}
                          {sec.stream ? ` (${sec.stream})` : ""}
                        </option>
                      ))}
                    </SelectField>
                    <TextField
                      name="rollNo"
                      label="Roll no."
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={3}
                      defaultValue={p?.rollNo ?? ""}
                      inputClassName="tabular"
                      hint="Leave empty if not given yet."
                    />
                  </div>
                  {blockedMoves.length && p ? (
                    <Alert tone="amber" title={`Not to ${listText(blockedMoves.map((b) => b.sec.label))} for now`}>
                      <ul className="grid gap-1">
                        {blockedMoves.map(({ sec, clashes }) => (
                          <li key={sec.id}>
                            {clashes
                              .map((e) =>
                                e.publishedIn.has(sec.id)
                                  ? `${e.name} results are published for ${sec.label} but not for ${p.label}: first publish ${p.label}’s or reopen ${sec.label}’s.`
                                  : `${e.name} results are published for ${p.label} but not for ${sec.label}: first publish ${sec.label}’s or reopen ${p.label}’s.`,
                              )
                              .join(" ")}
                          </li>
                        ))}
                      </ul>
                    </Alert>
                  ) : null}
                  <p className="text-[0.88rem] text-muted">
                    Moving to another class changes this session’s fee instalments to that class’s fee. Receipts stay as they are; if more has already been paid on an
                    instalment than the new fee, the move is refused until that payment is corrected on the fee page.
                  </p>
                  <p className="text-[0.88rem] text-muted">
                    Exam results are published section by section, and a student’s marks go with them. So once a student has marks this session, the class can’t be
                    changed, and a move to another section is refused while an exam is published in one of the two sections but not the other.
                  </p>
                  <div>
                    <SubmitButton pendingLabel="Saving…">{p ? "Save class" : "Place in class"}</SubmitButton>
                  </div>
                </ActionForm>
              ) : (
                <p className="text-[0.92rem] text-muted">Only a current student can be moved to another class.</p>
              )}
            </Card>
          ) : null}
        </div>

        <div className="grid min-w-0 gap-6">
          <SignInCard
            title="Family sign-in"
            signIn={s.signIn}
            slipHref={isOffice ? slipHref : null}
            offNote={
              current ? (
                isOffice && slipHref ? (
                  <>
                    Turned off on{" "}
                    <Link href={slipHref} className="font-semibold text-forest-800 underline underline-offset-4">
                      Slips & sign-in
                    </Link>
                    , where it can be turned back on.
                  </>
                ) : (
                  "Turned off by the school office."
                )
              ) : (
                "Turned off, because the student is no longer at the school. It works again if the student is marked as current."
              )
            }
            noAccountNote="This student has no sign-in account yet."
          />

          {isOffice && smsInfo && smsSettings ? <StudentSmsCard studentId={s.id} srNo={s.srNo} info={smsInfo} settings={smsSettings} history={smsHistory} current={current} /> : null}

          {isOffice ? (
            <Card>
              <CardTitle>RTE seat</CardTitle>
              <p className="text-forest-900">
                {s.rte ? "Yes: admitted on a seat reserved under the Right to Education Act. No fees are charged." : "No: fees are charged as in the fee plan."}
              </p>
              {current ? (
                <ActionForm action={rteAction.bind(null, s.id)} className="mt-4 gap-4" aria-label="RTE seat">
                  <input type="hidden" name="rte" value={s.rte ? "no" : "yes"} />
                  <p className="text-[0.88rem] text-muted">
                    {s.rte
                      ? "Removing it makes this session’s fee lines that were waived for the RTE seat due again."
                      : "Recording it waives this session’s unpaid fee lines. Money already paid stays on record; any refund is handled by the office."}
                  </p>
                  <div>
                    <ConfirmSubmit
                      key={s.rte ? "remove" : "record"}
                      question={s.rte ? "Charge this session’s fees again?" : "Waive this session’s unpaid fees?"}
                      confirmLabel={s.rte ? "Yes, remove the RTE seat" : "Yes, record the RTE seat"}
                    >
                      {s.rte ? "Remove the RTE seat" : "Record as an RTE seat"}
                    </ConfirmSubmit>
                  </div>
                </ActionForm>
              ) : (
                <p className="mt-2 text-[0.92rem] text-muted">It can be changed while the student is current.</p>
              )}
            </Card>
          ) : null}

          {isOffice ? (
            <Card>
              <CardTitle>Status</CardTitle>
              <p className="flex flex-wrap items-center gap-2 text-forest-900">
                <StudentStatusBadge status={s.status} />
                {current ? "Studying at the school." : s.leftOn ? `Since ${formatDate(s.leftOn)}.` : null}
              </p>
              <ActionForm action={statusAction.bind(null, s.id)} className="mt-4 gap-4" aria-label="Status">
                {current ? (
                  <>
                    <p className="text-[0.88rem] text-muted">
                      If the student has left the school, record it here. The family’s sign-in is turned off straight away; their records are kept.
                    </p>
                    <SelectField name="status" label="New status" required defaultValue="left">
                      <option value="left">Left</option>
                      <option value="transferred">Transferred</option>
                      <option value="passed_out">Passed out</option>
                    </SelectField>
                    <TextField name="leftOn" label="Date" type="date" required defaultValue={today} max={today} min={s.admittedOn ?? "1990-01-01"} />
                    <div>
                      <ConfirmSubmit key="leave" question="Mark as no longer at the school and turn off the family’s sign-in?" confirmLabel="Yes, save the status">
                        Save status
                      </ConfirmSubmit>
                    </div>
                  </>
                ) : (
                  <>
                    <SelectField name="status" label="Status" required defaultValue={s.status}>
                      <option value="left">{STUDENT_STATUS_LABELS.left}</option>
                      <option value="transferred">{STUDENT_STATUS_LABELS.transferred}</option>
                      <option value="passed_out">{STUDENT_STATUS_LABELS.passed_out}</option>
                    </SelectField>
                    <TextField name="leftOn" label="Date" type="date" required defaultValue={s.leftOn} max={today} min={s.admittedOn ?? "1990-01-01"} />
                    <div>
                      <SubmitButton key="correct" variant="secondary" pendingLabel="Saving…">
                        Correct the status
                      </SubmitButton>
                    </div>
                  </>
                )}
              </ActionForm>
              {!current ? (
                <ActionForm action={currentAgainAction.bind(null, s.id)} className="mt-5 gap-3 border-t border-forest-900/10 pt-5" aria-label="Mark as current">
                  <p className="text-[0.88rem] text-muted">Back at the school? Marking the student as current turns the family’s sign-in back on.</p>
                  <div>
                    <ConfirmSubmit variant="primary" question="Mark as current and turn the family’s sign-in back on?" confirmLabel="Yes, mark as current">
                      Mark as current again
                    </ConfirmSubmit>
                  </div>
                </ActionForm>
              ) : null}
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
