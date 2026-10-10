import type { Metadata } from "next";
import Link from "next/link";
import { LockOpen, ShieldCheck, ShieldOff } from "lucide-react";
import { Badge, Card, CardTitle, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { SubmitButton } from "@/components/ui/client";
import { ConfirmButton, FormButton, SlipResult, SlipsForm } from "@/components/access/client";
import { TextField } from "@/components/access/fields";
import { LockNote, SignInBadge, SignInStatus, shortDateTime, signInDetail } from "@/components/access/status";
import { getDb } from "@/lib/db/client";
import { schools } from "@/lib/db/schema";
import { requireActor } from "@/lib/auth/dal";
import { displayLoginId } from "@/lib/ids";
import { ACCESS_LABELS } from "@/lib/roles";
import { schoolOfficeStaff, signInFor } from "@/lib/queries/access";
import { listAesriAdmins } from "@/lib/services/accounts";
import { openStaffAction } from "../actions";
import { addAdminAction, adminAccountAction } from "./actions";

export const metadata: Metadata = { title: "School administrators" };

const ADMIN_FORM = "admin-accounts";

export default async function AdminsPage() {
  const actor = await requireActor(["super_admin"]);
  const db = await getDb();
  const [admins, office, schoolList] = await Promise.all([listAesriAdmins(db), schoolOfficeStaff(), db.select().from(schools).orderBy(schools.id)]);
  const signIns = await signInFor(admins.map((a) => a.id));

  return (
    <>
      <div className="no-print">
        <PageHeader
          eyebrow="AESRI"
          title="School administrators"
          description="AESRI administrators can work in both schools. Each school’s principal, office admins and accountants are listed below."
        />
      </div>

      <section aria-labelledby="aesri-admins" className="mb-10 print:m-0">
        <h2 id="aesri-admins" className="no-print mb-3 font-display text-[1.35rem] text-forest-900">
          AESRI administrators
        </h2>
        <SlipsForm id={ADMIN_FORM} action={adminAccountAction} messagePosition="none" aria-label="Changes to administrator accounts" className="mb-4 gap-4 print:m-0">
          <SlipResult />
        </SlipsForm>
        <div className="no-print">
          <Table caption="AESRI administrator accounts">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Login ID</Th>
                <Th>Status</Th>
                <Th>Authenticator app</Th>
                <Th>Last sign-in</Th>
                <Th className="relative">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => {
                const s = signIns.get(a.id) ?? null;
                const own = a.id === actor.accountId;
                const name = a.name ?? displayLoginId(a.loginId);
                return (
                  <tr key={`${a.id}-${a.status}`} className="align-top">
                    <Td className="min-w-44 font-semibold text-forest-900">{name}</Td>
                    <Td className="whitespace-nowrap tabular">{displayLoginId(a.loginId)}</Td>
                    <Td className="min-w-48">
                      <span className="grid justify-items-start gap-1">
                        <SignInBadge signIn={s} />
                        {a.status !== "active" ? <span className="text-[0.85rem] leading-snug text-muted">{signInDetail(s, { kind: "admin" })}</span> : null}
                        {s?.lock ? <LockNote lock={s.lock} /> : null}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {a.totpEnabled ? (
                        <Badge tone="green">
                          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                          On
                        </Badge>
                      ) : (
                        <Badge tone="grey">
                          <ShieldOff className="h-3.5 w-3.5" aria-hidden />
                          Not set up
                        </Badge>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-[0.92rem]">{a.lastLoginAt ? shortDateTime(a.lastLoginAt) : <span className="text-muted">Never</span>}</Td>
                    <Td className="min-w-64">
                      {own ? (
                        <span className="text-[0.88rem] text-muted">
                          This is you.{" "}
                          <Link href="/account" className="font-semibold text-forest-800 underline underline-offset-2">
                            Change your password
                          </Link>
                        </span>
                      ) : (
                        <span className="flex flex-wrap gap-2">
                          {s?.lock && a.status !== "disabled" ? (
                            <FormButton form={ADMIN_FORM} name="intent" value={`unlock:${a.id}`}>
                              <LockOpen className="h-4 w-4" aria-hidden />
                              Unlock<span className="sr-only"> sign-in for {name}</span>
                            </FormButton>
                          ) : null}
                          {a.status !== "disabled" ? (
                            <ConfirmButton
                              form={ADMIN_FORM}
                              name="intent"
                              value={`slip:${a.id}`}
                              variant={a.status === "active" ? "danger" : "primary"}
                              question={a.status === "active" ? `Reset ${name}’s password and authenticator app?` : `Print a new slip for ${name}?`}
                              confirmLabel={a.status === "active" ? "Yes, reset and print" : "Yes, print"}
                            >
                              New slip<span className="sr-only"> for {name}</span>
                            </ConfirmButton>
                          ) : null}
                          {a.status === "disabled" ? (
                            <FormButton form={ADMIN_FORM} name="intent" value={`on:${a.id}`}>
                              Turn on<span className="sr-only"> sign-in for {name}</span>
                            </FormButton>
                          ) : (
                            <ConfirmButton form={ADMIN_FORM} name="intent" value={`off:${a.id}`} question={`Turn off sign-in for ${name}?`} confirmLabel="Yes, turn off">
                              Turn off<span className="sr-only"> sign-in for {name}</span>
                            </ConfirmButton>
                          )}
                        </span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      </section>

      <Card className="mb-10 print:m-0 print:rounded-none print:bg-transparent print:p-0">
        <CardTitle className="no-print">Add an AESRI administrator</CardTitle>
        <SlipsForm action={addAdminAction} resetOnSuccess messagePosition="none" aria-label="Add an AESRI administrator" className="gap-5">
          <SlipResult>
            <div className="no-print grid gap-5">
              <p className="max-w-3xl text-[0.95rem] text-forest-900/85">
                They can see and change everything in both schools, so add only people AESRI has appointed. You print their slip here; they activate their account with it and
                then set up an authenticator app on their phone.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  name="loginId"
                  label="Login ID"
                  required
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={40}
                  placeholder="aesri.meena"
                  hint="Lower-case letters, numbers and dots, like aesri.meena. It can’t be changed later."
                />
                <TextField name="name" label="Full name" required autoComplete="off" maxLength={80} hint="As it should appear in the portal and the activity log." />
              </div>
              <div>
                <SubmitButton pendingLabel="Adding…">Add and print their slip</SubmitButton>
              </div>
            </div>
          </SlipResult>
        </SlipsForm>
      </Card>

      <section aria-labelledby="school-admins" className="no-print">
        <h2 id="school-admins" className="mb-1 font-display text-[1.35rem] text-forest-900">
          Principals, office admins and accountants
        </h2>
        <p className="mb-5 max-w-3xl text-[0.95rem] text-muted">
          Their portal access is set on each school’s staff page. To print a new slip for a principal or office admin, or to unlock their sign-in, work in their school
          and use Slips &amp; sign-in.
        </p>
        <div className="grid gap-8">
          {schoolList.map((school) => {
            const people = office.filter((o) => o.schoolId === school.id);
            return (
              <div key={school.id} className="min-w-0">
                <h3 className="mb-3 font-sans text-[1.05rem] font-bold tracking-normal text-forest-900">{school.name}</h3>
                {people.length ? (
                  <Table caption={`Office staff with portal access at ${school.name}`}>
                    <thead>
                      <tr>
                        <Th>Name</Th>
                        <Th>Portal access</Th>
                        <Th>Login ID</Th>
                        <Th>Sign-in</Th>
                        <Th className="relative">
                          <span className="sr-only">Open</span>
                        </Th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map((p) => (
                        <tr key={p.id} className="align-top">
                          <Td className="min-w-44">
                            <span className="font-semibold text-forest-900">{p.name}</span>
                            {p.designation ? <span className="block text-[0.85rem] text-muted">{p.designation}</span> : null}
                          </Td>
                          <Td>{ACCESS_LABELS[p.access]}</Td>
                          <Td className="whitespace-nowrap tabular">{p.signIn?.loginId ?? "—"}</Td>
                          <Td className="min-w-56">
                            <SignInStatus signIn={p.signIn} kind="staff" />
                          </Td>
                          <Td>
                            <form action={openStaffAction}>
                              <input type="hidden" name="staff" value={p.id} />
                              <SubmitButton variant="secondary" size="sm" pendingLabel="Opening…" className="whitespace-nowrap">
                                Open staff record<span className="sr-only">: {p.name}</span>
                              </SubmitButton>
                            </form>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <EmptyState icon={<ShieldCheck className="h-5 w-5" aria-hidden />} title="No office staff with portal access">
                    Give a staff member “Principal”, “Office admin” or “Accounts” access on the school’s staff page.
                  </EmptyState>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
