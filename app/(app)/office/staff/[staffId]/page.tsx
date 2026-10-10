import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, Phone } from "lucide-react";
import { officePage } from "@/lib/page";
import { ACCESS_LABELS, needsTwoFactor, roleForAccess } from "@/lib/roles";
import { formatDate, todayIST } from "@/lib/dates";
import { listSections, listSubjects } from "@/lib/queries/school";
import { staffRecord } from "@/lib/queries/records";
import { mayPrintSlipFor } from "@/lib/services/accounts";
import { accessCanTeach, ADMIN_ACCESS_TEXT, isAdminAccess, mayManageAdminAccess } from "@/lib/services/staff";
import { ActionForm } from "@/components/forms";
import { Flash } from "@/components/flash";
import { Card, CardTitle, Dl, PageHeader } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { StaffStatusBadge } from "@/components/records/badges";
import { FormDisclosure } from "@/components/records/disclosure";
import { CheckGroup, SelectField } from "@/components/records/fields";
import { listText, plural } from "@/components/records/form-state";
import { ClassTeacherNote } from "@/components/records/live";
import { SignInCard } from "@/components/records/sign-in";
import { ACCESS_HINTS, AccessChoice, DesignationList, StaffDetailFields } from "@/components/records/staff-fields";
import { accessAction, classTeacherAction, saveStaffDetailsAction, staffStatusAction, subjectsAction } from "./actions";

export const metadata: Metadata = { title: "Staff record" };

const dash = <span className="text-muted">—</span>;

export default async function StaffRecordPage({ params, searchParams }: { params: Promise<{ staffId: string }>; searchParams: Promise<{ done?: string }> }) {
  const { actor, schoolId, sessionId } = await officePage();
  const { staffId } = await params;
  const sp = await searchParams;
  const st = await staffRecord(schoolId, sessionId, staffId);
  if (!st) notFound();

  const self = actor.role === "school_admin" && !!actor.staffId && actor.staffId === st.id;
  // Principal / Office admin access, and marking such staff as left, are for AESRI administrators only.
  const adminLocked = !mayManageAdminAccess(actor.role);
  const lockedAdmin = adminLocked && isAdminAccess(st.access);
  const current = st.status === "active";
  const canTakeClass = current && accessCanTeach(st.access);
  const [sectionList, subjectList] = await Promise.all([canTakeClass ? listSections(schoolId, sessionId) : [], listSubjects(schoolId)]);
  const today = todayIST();
  const role = roleForAccess(st.access);
  const loginId = st.signIn?.loginId ?? null;
  const accessHref = loginId ? `/office/access?tab=staff&q=${encodeURIComponent(loginId)}` : "/office/access?tab=staff";
  // Same rule as the Slips & sign-in page: not your own slip, and principals' and office admins' slips come from an AESRI administrator.
  const ownAccount = !!st.signIn && st.signIn.accountId === actor.accountId;
  const mayPrint = !!role && mayPrintSlipFor(actor.role, role) && !ownAccount;
  const slipHref = loginId && role && current && mayPrint ? accessHref : null;
  const slipNote = ownAccount
    ? "This is your own account. To change your password, use “Password” under your name."
    : role && !mayPrintSlipFor(actor.role, role)
      ? "Slips for the principal and office admins are printed by the AESRI administrator."
      : null;
  const otherSections = sectionList.filter((s) => s.classTeacherId !== st.id);
  const teachingSections = new Set(st.teaching.map((t) => t.sectionId)).size;
  // What marking them as left takes off them: "be class teacher of V-B or teach subjects in 9 sections".
  const duties = [
    st.classTeacherOf.length ? `be class teacher of ${listText(st.classTeacherOf.map((c) => c.label))}` : null,
    teachingSections ? `teach subjects in ${plural(teachingSections, "section", "sections")}` : null,
  ].filter(Boolean);

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/office/staff" className="inline-flex min-h-6 items-center gap-1.5 hover:text-forest-900">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Staff
          </Link>
        }
        title={st.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="tabular">Emp. no. {st.empNo}</span>
            {st.designation ? (
              <>
                <span aria-hidden>·</span>
                <span>{st.designation}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span>Portal access: {ACCESS_LABELS[st.access]}</span>
            <StaffStatusBadge status={st.status} />
          </span>
        }
      />

      <Flash
        code={sp.done}
        messages={{
          created: (
            <>
              <strong className="font-semibold">{st.name} was added.</strong>{" "}
              {role && loginId ? (
                <>
                  Their login ID is <strong className="font-semibold tabular">{loginId}</strong>.{" "}
                  {slipHref ? (
                    <>
                      <Link href={slipHref} className="font-semibold underline underline-offset-2">
                        Print their activation slip
                      </Link>{" "}
                      so they can sign in.
                    </>
                  ) : (
                    "The AESRI administrator prints their activation slip."
                  )}
                  {needsTwoFactor(role) ? " The first time they sign in, they also set up an authenticator app on their phone." : ""}
                </>
              ) : (
                "They have no portal login."
              )}
            </>
          ),
        }}
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="grid min-w-0 gap-6">
          <Card>
            <CardTitle>Details</CardTitle>
            <Dl
              items={[
                { label: "Employee no.", value: <span className="tabular">{st.empNo}</span> },
                { label: "Designation", value: st.designation ?? dash },
                {
                  label: "Mobile",
                  value: st.mobile ? (
                    <a href={`tel:+91${st.mobile}`} className="inline-flex min-h-6 items-center gap-1.5 tabular underline-offset-2 hover:underline">
                      <Phone className="h-3.5 w-3.5 text-muted" aria-hidden />
                      {st.mobile}
                    </a>
                  ) : (
                    dash
                  ),
                },
                {
                  label: "Email",
                  value: st.email ? (
                    <a href={`mailto:${st.email}`} className="inline-flex min-h-6 items-center gap-1.5 break-all underline-offset-2 hover:underline">
                      <Mail className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                      {st.email}
                    </a>
                  ) : (
                    dash
                  ),
                },
                { label: "Date of joining", value: st.joinedOn ? formatDate(st.joinedOn) : dash },
              ]}
            />
            <div className="mt-6 border-t border-forest-900/10 pt-5">
              <ActionForm action={saveStaffDetailsAction.bind(null, st.id)} aria-label="Edit details">
                <FormDisclosure summary="Edit details">
                  <DesignationList />
                  <StaffDetailFields today={today} defaults={st} mobileRequired={!!role} />
                  <p className="text-[0.88rem] text-muted">
                    The employee no. ({st.empNo}) can’t be changed, because it is part of the login ID. If it is wrong, please ask the AESRI administrator.
                  </p>
                  <div>
                    <SubmitButton pendingLabel="Saving…">Save details</SubmitButton>
                  </div>
                </FormDisclosure>
              </ActionForm>
            </div>
          </Card>

          <Card>
            <CardTitle>Class teacher</CardTitle>
            <ActionForm action={classTeacherAction.bind(null, st.id)} aria-label="Class teacher">
              {st.classTeacherOf.length ? (
                <ul className="grid gap-2" aria-label="Class teacher of">
                  {st.classTeacherOf.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-cream-200/50 py-1.5 pl-4 pr-1.5">
                      <span className="font-semibold text-forest-900">Class teacher of {c.label}</span>
                      <SubmitButton name="remove" value={c.id} variant="ghost" size="sm" pendingLabel="Saving…">
                        Remove<span className="sr-only"> as class teacher of {c.label}</span>
                      </SubmitButton>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">Not a class teacher this session.</p>
              )}
              {canTakeClass ? (
                otherSections.length ? (
                  <div className="grid gap-3">
                    <SelectField name="sectionId" label={st.classTeacherOf.length ? "Also make them class teacher of" : "Make them class teacher of"} defaultValue="">
                      <option value="">Choose a section</option>
                      {otherSections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                          {s.stream ? ` (${s.stream})` : ""} — {s.classTeacherName ? `now ${s.classTeacherName}` : "no class teacher"}
                        </option>
                      ))}
                    </SelectField>
                    <ClassTeacherNote
                      field="sectionId"
                      person={st.name}
                      sections={Object.fromEntries(otherSections.map((s) => [s.id, { label: s.label, teacher: s.classTeacherName }]))}
                    />
                    <p className="text-[0.88rem] text-muted">A section has one class teacher, who takes its register and sees every remark about its students. Choosing a section replaces its present class teacher.</p>
                    <div>
                      <SubmitButton name="intent" value="add" variant="secondary" pendingLabel="Saving…">
                        Make class teacher
                      </SubmitButton>
                    </div>
                  </div>
                ) : null
              ) : (
                <p className="text-[0.88rem] text-muted">
                  {!current
                    ? "Staff who have left can’t be class teachers."
                    : `With ${ACCESS_LABELS[st.access]} access they can’t take a class register. To make them a class teacher, give them Teacher, Principal or Office admin access first.`}
                </p>
              )}
            </ActionForm>
          </Card>

          <Card>
            <CardTitle>Teaching this session</CardTitle>
            {st.teaching.length ? (
              <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2" aria-label="Subjects they teach, by class">
                {st.teaching.map((t) => (
                  <li key={`${t.sectionId}:${t.subjectId}`} className="text-forest-900">
                    <span className="font-semibold tabular">{t.sectionLabel}</span> · {t.subjectName}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">No subjects to teach this session yet.</p>
            )}
            <p className="mt-4 text-[0.88rem] text-muted">
              Who teaches each subject in each class is chosen on{" "}
              <Link href="/office/classes" className="font-semibold text-forest-800 underline underline-offset-4">
                Classes & subjects
              </Link>
              .
            </p>
          </Card>

          <Card>
            <CardTitle>Subjects taught</CardTitle>
            {subjectList.length ? (
              <ActionForm action={subjectsAction.bind(null, st.id)} aria-label="Subjects taught">
                <CheckGroup
                  name="subjects"
                  legend="Subjects they teach"
                  hint="Used to suggest teachers when classes are set up."
                  options={subjectList.map((s) => ({ value: s.id, label: s.name }))}
                  defaultValues={st.subjectIds}
                />
                <div>
                  <SubmitButton variant="secondary" pendingLabel="Saving…">
                    Save subjects
                  </SubmitButton>
                </div>
              </ActionForm>
            ) : (
              <p className="text-muted">
                No subjects are set up yet. Add them on{" "}
                <Link href="/office/classes" className="font-semibold text-forest-800 underline underline-offset-4">
                  Classes & subjects
                </Link>
                .
              </p>
            )}
          </Card>
        </div>

        <div className="grid min-w-0 gap-6">
          <SignInCard
            title="Sign-in"
            signIn={st.signIn}
            slipHref={slipHref}
            slipNote={slipNote}
            offNote={
              !current ? (
                "Turned off, because they have left the school."
              ) : !role ? (
                "Turned off, because their access is “No login”."
              ) : (
                <>
                  Turned off on{" "}
                  <Link href={accessHref} className="font-semibold text-forest-800 underline underline-offset-4">
                    Slips & sign-in
                  </Link>
                  , where it can be turned back on.
                </>
              )
            }
            noAccountNote={role ? "No sign-in account yet." : "No login: they are listed as staff but can’t sign in."}
          />

          <Card>
            <CardTitle>Portal access</CardTitle>
            <p className="text-forest-900">
              <strong className="font-semibold">{ACCESS_LABELS[st.access]}.</strong> {ACCESS_HINTS[st.access]}
            </p>
            {self ? (
              <p className="mt-3 text-[0.88rem] text-muted">You can’t change your own access. Please ask the AESRI administrator.</p>
            ) : lockedAdmin ? (
              <p className="mt-3 text-[0.88rem] text-muted">{ADMIN_ACCESS_TEXT.locked}</p>
            ) : (
              <ActionForm action={accessAction.bind(null, st.id)} className="mt-4 gap-4" aria-label="Portal access">
                <AccessChoice defaultValue={st.access} legend="Change their access" columns="grid-cols-1" adminLocked={adminLocked} />
                <p className="text-[0.88rem] text-muted">Changing their access signs them out. “No login” turns their sign-in off. Someone made Principal or Office admin needs a new sign-in slip from the AESRI administrator.</p>
                <div>
                  <ConfirmSubmit variant="primary" question="Change their access and sign them out?" confirmLabel="Yes, change access">
                    Change access
                  </ConfirmSubmit>
                </div>
              </ActionForm>
            )}
          </Card>

          <Card>
            <CardTitle>Status</CardTitle>
            <p className="flex flex-wrap items-center gap-2 text-forest-900">
              <StaffStatusBadge status={st.status} />
              {current ? "Working at the school." : "Has left the school."}
            </p>
            {self ? (
              <p className="mt-3 text-[0.88rem] text-muted">You can’t mark yourself as left. Please ask the AESRI administrator.</p>
            ) : lockedAdmin ? (
              <p className="mt-3 text-[0.88rem] text-muted">{current ? ADMIN_ACCESS_TEXT.lockedStatus : "Only the AESRI administrator can mark the principal or an office admin as current again."}</p>
            ) : (
              <ActionForm action={staffStatusAction.bind(null, st.id)} className="mt-4 gap-4" aria-label="Status">
                <input type="hidden" name="status" value={current ? "left" : "active"} />
                <p className="text-[0.88rem] text-muted">
                  {current
                    ? `If they have left the school, mark them as left: their sign-in is turned off${duties.length ? ` and they will no longer ${duties.join(" or ")} this session` : ""}. Their records are kept.`
                    : role
                      ? "Back at the school? Marking them as current turns their sign-in back on. Their classes need choosing again."
                      : "Back at the school? Mark them as current again."}
                </p>
                <div>
                  <ConfirmSubmit
                    key={st.status}
                    variant={current ? "danger" : "primary"}
                    question={current ? `Mark as left?${duties.length ? ` They will no longer ${duties.join(" or ")}.` : ""}` : "Mark as current again?"}
                    confirmLabel={current ? "Yes, mark as left" : "Yes, mark as current"}
                  >
                    {current ? "Mark as left" : "Mark as current again"}
                  </ConfirmSubmit>
                </div>
              </ActionForm>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
