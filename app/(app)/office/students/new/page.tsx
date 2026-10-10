import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { officePage } from "@/lib/page";
import { getDb } from "@/lib/db/client";
import { getSchool, listSections } from "@/lib/queries/school";
import { currentPlan, rupees } from "@/lib/services/fees";
import { sessionBounds } from "@/lib/services/attendance";
import { todayIST } from "@/lib/dates";
import { ActionForm } from "@/components/forms";
import { Alert, ButtonLink, Card, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { CheckField, SelectField, TextField } from "@/components/records/fields";
import { AdmissionFeeChoice, LoginIdPreview } from "@/components/records/live";
import { FamilyFields, FormGroup, StudentPersonFields } from "@/components/records/student-fields";
import { createStudentAction } from "./actions";

export const metadata: Metadata = { title: "Add a student" };

export default async function NewStudentPage() {
  const { schoolId, sessionId } = await officePage();
  const db = await getDb();
  const [school, sectionList, plan, bounds] = await Promise.all([getSchool(schoolId), listSections(schoolId, sessionId), currentPlan(db, schoolId), sessionBounds(sessionId)]);
  const prefix = school?.loginPrefix ?? "";
  const fee = plan?.oneTime.find((o) => o.key === "admission") ?? null;
  const today = todayIST();
  const admittedDefault = today >= bounds.startsOn && today <= bounds.endsOn ? today : null;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/office/students" className="inline-flex min-h-6 items-center gap-1.5 hover:text-forest-900">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Students
          </Link>
        }
        title="Add a student"
        description={
          <>
            For a new admission. Boxes marked <span className="text-clay-600">*</span> are needed. To add many students at once,{" "}
            <Link href="/office/import" className="font-semibold text-forest-800 underline underline-offset-4">
              import them from Excel
            </Link>
            .
          </>
        }
      />

      {!sectionList.length ? (
        <Alert tone="amber" title={`No classes are set up for the ${sessionId} session yet`} className="max-w-3xl">
          A student is added straight into a class and section.{" "}
          <Link href="/office/classes" className="font-semibold underline underline-offset-2">
            Set up the classes
          </Link>{" "}
          first, then come back here.
        </Alert>
      ) : (
        <Card className="max-w-3xl">
          <ActionForm action={createStudentAction} aria-label="Add a student">
            <FormGroup title="Student" divider={false}>
              <StudentPersonFields
                today={today}
                defaults={{ admittedOn: admittedDefault }}
                before={
                  <TextField
                    name="srNo"
                    label="SR no."
                    required
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={9}
                    inputClassName="tabular sm:max-w-[calc(50%-0.625rem)]"
                    hint={
                      <>
                        The number in the school’s admission register (digits only).{" "}
                        <LoginIdPreview prefix={prefix} field="srNo" who="The family’s" example={`${prefix}7634`} />
                      </>
                    }
                  />
                }
              />
            </FormGroup>

            <FormGroup title={`Class for ${sessionId}`}>
              <div className="grid gap-5 sm:grid-cols-2">
                <SelectField name="sectionId" label="Class and section" required defaultValue="">
                  <option value="">Choose a class</option>
                  {sectionList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                      {s.stream ? ` (${s.stream})` : ""}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  name="rollNo"
                  label="Roll no."
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={3}
                  inputClassName="tabular"
                  hint="Optional. You can give it later."
                />
              </div>
            </FormGroup>

            <FormGroup title="Family">
              <FamilyFields defaults={{}} />
            </FormGroup>

            <FormGroup title="Fees">
              <CheckField
                name="rte"
                label="RTE seat"
                hint="Admitted on a seat reserved under the Right to Education Act. No fees are charged."
              />
              {fee ? (
                <AdmissionFeeChoice
                  label={`Add the admission fee (${rupees(fee.amount)}${fee.refundable ? "" : ", non-refundable"})`}
                  hint="For a student admitted in this session. Not charged for an RTE seat."
                  defaultChecked={!!admittedDefault}
                  sessionStart={bounds.startsOn}
                  sessionEnd={bounds.endsOn}
                />
              ) : null}
              <p className="text-[0.9rem] text-muted">This session’s fee instalments for the class are added automatically from the fee plan.</p>
            </FormGroup>

            <div className="flex flex-wrap items-center gap-3 border-t border-forest-900/10 pt-5">
              <SubmitButton pendingLabel="Adding…">Add student</SubmitButton>
              <ButtonLink href="/office/students" variant="ghost">
                Cancel
              </ButtonLink>
            </div>
          </ActionForm>
        </Card>
      )}

      <p className="mt-6 flex max-w-3xl items-start gap-2 text-[0.9rem] text-muted">
        <Printer className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        After adding, print the family’s activation slip so they can sign in.
      </p>
    </>
  );
}
