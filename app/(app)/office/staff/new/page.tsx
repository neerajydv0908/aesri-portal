import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { officePage } from "@/lib/page";
import { getSchool, listSubjects } from "@/lib/queries/school";
import { mayManageAdminAccess } from "@/lib/services/staff";
import { todayIST } from "@/lib/dates";
import { ActionForm } from "@/components/forms";
import { ButtonLink, Card, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { CheckGroup, TextField } from "@/components/records/fields";
import { LoginIdPreview } from "@/components/records/live";
import { AccessChoice, DesignationList, StaffDetailFields } from "@/components/records/staff-fields";
import { FormGroup } from "@/components/records/student-fields";
import { createStaffAction } from "./actions";

export const metadata: Metadata = { title: "Add a staff member" };

export default async function NewStaffPage() {
  const { actor, schoolId } = await officePage();
  const [school, subjectList] = await Promise.all([getSchool(schoolId), listSubjects(schoolId)]);
  const prefix = `${school?.loginPrefix ?? ""}E`;
  const today = todayIST();
  // Principals and office admins are added by an AESRI administrator (see lib/services/staff.ts).
  const adminLocked = !mayManageAdminAccess(actor.role);

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/office/staff" className="inline-flex min-h-6 items-center gap-1.5 hover:text-forest-900">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Staff
          </Link>
        }
        title="Add a staff member"
        description={
          <>
            Boxes marked <span className="text-clay-600">*</span> are needed. To add the whole staff list at once,{" "}
            <Link href="/office/import" className="font-semibold text-forest-800 underline underline-offset-4">
              import it from Excel
            </Link>
            .
          </>
        }
      />
      <Card className="max-w-3xl">
        <ActionForm action={createStaffAction} aria-label="Add a staff member">
          <DesignationList />
          <FormGroup title="Staff member" divider={false}>
            <TextField
              name="empNo"
              label="Employee no."
              required
              inputMode="numeric"
              autoComplete="off"
              maxLength={9}
              inputClassName="tabular sm:max-w-[calc(50%-0.625rem)]"
              hint={
                <>
                  Digits only, from the staff register. <LoginIdPreview prefix={prefix} field="empNo" who="Their" example={`${prefix}12`} />
                </>
              }
            />
            <StaffDetailFields defaults={{}} today={today} mobileRequired="depends" />
          </FormGroup>

          <FormGroup title="Portal access">
            <AccessChoice defaultValue="teacher" legend="What can they do in the portal?" adminLocked={adminLocked} />
          </FormGroup>

          <FormGroup title="Subjects taught">
            {subjectList.length ? (
              <CheckGroup
                name="subjects"
                legend="Subjects they teach"
                hint="Used to suggest teachers when classes are set up. Which classes they teach is chosen on Classes & subjects."
                options={subjectList.map((s) => ({ value: s.id, label: s.name }))}
                defaultValues={[]}
              />
            ) : (
              <p className="text-[0.92rem] text-muted">
                No subjects are set up yet. Add them on{" "}
                <Link href="/office/classes" className="font-semibold text-forest-800 underline underline-offset-4">
                  Classes & subjects
                </Link>
                , then tick the ones this person teaches on their record.
              </p>
            )}
          </FormGroup>

          <div className="flex flex-wrap items-center gap-3 border-t border-forest-900/10 pt-5">
            <SubmitButton pendingLabel="Adding…">Add staff member</SubmitButton>
            <ButtonLink href="/office/staff" variant="ghost">
              Cancel
            </ButtonLink>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
