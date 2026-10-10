import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, LockOpen } from "lucide-react";
import { ActionForm } from "@/components/forms";
import { FilterBar, SearchField, SectionField } from "@/components/pickers";
import { Card, EmptyState, PageHeader, Select, TabLinks, Table, Td, Th } from "@/components/ui";
import { BulkPrintButton, ConfirmButton, FormButton, PrintSelectedControls, RowActionMessages, SelectAllBox, SlipResult, SlipsForm } from "@/components/access/client";
import { SignInStatus } from "@/components/access/status";
import { MAX_BULK_PRINT } from "@/components/access/slip-types";
import { normalizeLoginId } from "@/lib/ids";
import { officePage } from "@/lib/page";
import { ACCESS_LABELS, type Role } from "@/lib/roles";
import {
  countByStatus,
  isStatusFilter,
  narrowPeople,
  slipQueue,
  staffAccessPeople,
  statusGroup,
  studentAccessPeople,
  type AccessPerson,
  type StatusFilter,
} from "@/lib/queries/access";
import { listSections } from "@/lib/queries/school";
import { CODE_VALID_DAYS, mayPrintSlipFor } from "@/lib/services/accounts";
import { printSlipsAction, signInSwitchAction } from "./actions";

export const metadata: Metadata = { title: "Slips & sign-in" };

const MAX_ROWS = 300;
const SLIPS_FORM = "slips-form";
const ROW_FORM = "row-actions";

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "All",
  not_activated: "Not activated",
  active: "Active",
  turned_off: "Turned off",
};

type SP = { tab?: string; section?: string; status?: string; q?: string };

export default async function AccessPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await officePage();
  const sp = await searchParams;
  const tab: "students" | "staff" = sp.tab === "staff" ? "staff" : "students";
  const status: StatusFilter = isStatusFilter(sp.status) ? sp.status : "all";
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 60) : "";

  const sectionList = tab === "students" ? await listSections(ctx.schoolId, ctx.sessionId) : [];
  const section = sectionList.find((s) => s.id === sp.section) ?? null;
  const everyone = tab === "students" ? await studentAccessPeople(ctx.schoolId, ctx.sessionId) : await staffAccessPeople(ctx.schoolId);
  const narrowed = narrowPeople(everyone, { sectionId: section?.id, q });
  const counts = countByStatus(narrowed);
  const matching = status === "all" ? narrowed : narrowed.filter((p) => statusGroup(p) === status);
  const shown = matching.slice(0, MAX_ROWS);
  const hiddenLeft = q ? 0 : everyone.filter((p) => !p.current && (!section || p.sectionId === section.id) && !narrowed.includes(p)).length;

  const canTick = (p: AccessPerson) =>
    !!p.signIn &&
    p.current &&
    p.signIn.status !== "disabled" &&
    p.signIn.accountId !== ctx.actor.accountId &&
    mayPrintSlipFor(ctx.actor.role, p.signIn.role);
  // Arriving from another page with ?q=<login ID>: that one row is ticked, ready to print.
  const exact = q ? normalizeLoginId(q) : "";
  const preTicked = shown.length === 1 && exact && shown[0].loginId.toLowerCase() === exact && canTick(shown[0]) ? shown[0].id : null;

  const inSection = section ? narrowPeople(everyone, { sectionId: section.id }).filter((p) => p.current) : [];
  const classQueue = slipQueue(inSection, ctx.actor);
  const offInSection = inSection.filter((p) => p.signIn?.status !== "active" && p.signIn?.status !== "pending").length;
  const filtering = !!section || status !== "all" || !!q;
  const noun = tab === "students" ? { one: "student", many: "students" } : { one: "staff member", many: "staff" };
  // Everyone in the school (this tab) still waiting to activate whose slip this person may print, in printing order.
  const queue = slipQueue(everyone, ctx.actor);
  const currentHere = everyone.filter((p) => p.current && !(p.kind === "staff" && p.access === "none"));
  const offHere = currentHere.filter((p) => p.signIn?.status !== "active" && p.signIn?.status !== "pending").length;
  const adminOnlyNote = queue.adminOnly ? `Slips for the principal and office admins (${queue.adminOnly} waiting) are printed by an AESRI administrator.` : undefined;
  const tooMany = `${queue.people.length.toLocaleString("en-IN")} ${tab === "students" ? "students are" : "staff are"} waiting for a slip: more than the ${MAX_BULK_PRINT.toLocaleString("en-IN")} that can be printed at once. ${tab === "students" ? "Choose a class above to print class by class." : "Tick the people who need a slip in the table below."}`;
  const nobodyWaiting =
    tab === "students"
      ? currentHere.length
        ? `Every current student has activated${offHere ? `, apart from ${offHere === 1 ? "1 student" : `${offHere} students`} whose sign-in is turned off` : ""}.`
        : "There are no students yet."
      : currentHere.length
        ? queue.adminOnly
          ? `Everyone else with portal access has activated. ${adminOnlyNote}`
          : "Every member of staff with portal access has activated."
        : "There are no staff with portal access yet.";

  return (
    <>
      <div className="no-print">
        <PageHeader
          eyebrow="School office"
          title="Slips & sign-in"
          description="Print the slips families and staff use to activate their accounts, and see who has signed in. A forgotten password? Print a new slip: it replaces the old password."
        />
        <TabLinks
          current={tab}
          tabs={[
            { key: "students", href: "/office/access", label: "Students" },
            { key: "staff", href: "/office/access?tab=staff", label: "Staff" },
          ]}
        />
        <FilterBar action="/office/access" hidden={{ tab: tab === "staff" ? "staff" : undefined }}>
          {tab === "students" ? <SectionField sections={sectionList} value={section?.id} allowAll /> : null}
          <div className="grid gap-1.5">
            <label htmlFor="pick-status" className="text-[0.85rem] font-semibold text-forest-900">
              Sign-in
            </label>
            <Select id="pick-status" name="status" defaultValue={status} className="min-w-48">
              {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((k) => (
                <option key={k} value={k}>
                  {STATUS_LABELS[k]} ({counts[k]})
                </option>
              ))}
            </Select>
          </div>
          <SearchField value={q} label="Login ID or name" placeholder={tab === "students" ? "e.g. Arya7634 or Meena" : "e.g. AryaE3 or Sunita"} />
        </FilterBar>
      </div>

      <SlipsForm id={SLIPS_FORM} action={printSlipsAction} messagePosition="none" resetOnSuccess aria-label="Print slips" className="mb-8">
        {section ? <input type="hidden" name="section" value={section.id} /> : null}
        <SlipResult>
          <Card className="no-print">
            <h2 className="mb-1 font-display text-[1.35rem] text-forest-900">Print slips</h2>
            <p className="mb-4 max-w-3xl text-[0.95rem] text-forest-900/85">
              Each slip has the login ID and a one-time code that works once, for {CODE_VALID_DAYS} days. A new slip cancels any earlier slip for the same person. For someone who has
              already activated, it also resets their password{tab === "staff" ? " and authenticator app" : ""} and signs them out.
            </p>
            <PrintSelectedControls
              formId={SLIPS_FORM}
              shortcut={
                tab === "staff" ? (
                  queue.people.length > MAX_BULK_PRINT ? (
                    <span className="text-[0.92rem] text-muted">{tooMany}</span>
                  ) : queue.people.length ? (
                    <BulkPrintButton
                      intent="everyone-staff"
                      total={queue.people.length}
                      replaced={queue.replaced}
                      label="Print slips for all staff not yet activated"
                      order="in order of employee number"
                      note={adminOnlyNote}
                    />
                  ) : (
                    <span className="text-[0.92rem] text-muted">{nobodyWaiting}</span>
                  )
                ) : section ? (
                  classQueue.people.length ? (
                    <BulkPrintButton
                      intent="section"
                      total={classQueue.people.length}
                      replaced={classQueue.replaced}
                      label={`Print slips for everyone not yet activated in ${section.label}`}
                      order="in order of roll number"
                    />
                  ) : !inSection.length ? (
                    <span className="text-[0.92rem] text-muted">There are no students in {section.label} yet.</span>
                  ) : offInSection ? (
                    <span className="text-[0.92rem] text-muted">
                      Everyone in {section.label} has activated, apart from {offInSection === 1 ? "1 student" : `${offInSection} students`} whose sign-in is turned off.
                    </span>
                  ) : (
                    <span className="text-[0.92rem] text-muted">Everyone in {section.label} has activated.</span>
                  )
                ) : queue.people.length > MAX_BULK_PRINT ? (
                  <span className="text-[0.92rem] text-muted">{tooMany}</span>
                ) : queue.people.length ? (
                  <BulkPrintButton
                    intent="everyone-students"
                    total={queue.people.length}
                    replaced={queue.replaced}
                    label="Print slips for everyone not yet activated"
                    order="in order of class, section and roll number"
                    note="To print one class only, choose it above."
                  />
                ) : (
                  <span className="text-[0.92rem] text-muted">{nobodyWaiting}</span>
                )
              }
            />
          </Card>
        </SlipResult>
      </SlipsForm>

      <section aria-labelledby="people-title" className="no-print">
        <h2 id="people-title" className="mb-3 font-display text-[1.35rem] text-forest-900">
          {tab === "students" ? (section ? `Students in ${section.label}` : "Students") : "Staff"}
        </h2>
        <ActionForm id={ROW_FORM} action={signInSwitchAction} messagePosition="none" aria-label="Sign-in changes" className="mb-4 gap-0">
          <RowActionMessages />
        </ActionForm>
        {shown.length ? (
          <>
            <p className="mb-3 text-[0.9rem] text-muted" role="status">
              {filtering ? `${matching.length} of ${counts.all} ${counts.all === 1 ? noun.one : noun.many} shown.` : `${counts.all} ${counts.all === 1 ? noun.one : noun.many}.`}
              {matching.length > MAX_ROWS ? ` Showing the first ${MAX_ROWS}: choose a class or search to see the rest.` : ""}
              {hiddenLeft ? ` ${hiddenLeft} who ${hiddenLeft === 1 ? "has" : "have"} left the school ${hiddenLeft === 1 ? "is" : "are"} not listed; search for them by name or login ID.` : ""}
            </p>
            <Table caption={tab === "students" ? "Students and their sign-in" : "Staff and their sign-in"}>
              <thead>
                <tr>
                  <Th className="w-14 !pr-0">
                    <SelectAllBox formId={SLIPS_FORM} />
                  </Th>
                  <Th>Login ID</Th>
                  <Th>Name</Th>
                  <Th>{tab === "students" ? "Class" : "Designation"}</Th>
                  <Th>Sign-in</Th>
                  <Th className="relative">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <Row key={p.id} p={p} tickable={canTick(p)} preTicked={preTicked === p.id} own={p.signIn?.accountId === ctx.actor.accountId} actorRole={ctx.actor.role} />
                ))}
              </tbody>
            </Table>
          </>
        ) : (
          <EmptyState icon={<KeyRound className="h-5 w-5" aria-hidden />} title={filtering ? `No ${noun.many} match` : `No ${noun.many} yet`}>
            {filtering ? (
              <>
                Try another class, sign-in status or search, or{" "}
                <Link href={tab === "staff" ? "/office/access?tab=staff" : "/office/access"} className="font-semibold underline underline-offset-2">
                  clear the filters
                </Link>
                .
                {hiddenLeft ? ` ${hiddenLeft} who ${hiddenLeft === 1 ? "has" : "have"} left the school ${hiddenLeft === 1 ? "is" : "are"} not listed; search for them by name or login ID.` : ""}
              </>
            ) : tab === "students" ? (
              "Students appear here once they are added. Each student gets a login ID automatically."
            ) : (
              "Staff appear here once they are added with portal access."
            )}
          </EmptyState>
        )}
      </section>
    </>
  );
}

function Row({ p, tickable, preTicked, own, actorRole }: { p: AccessPerson; tickable: boolean; preTicked: boolean; own: boolean; actorRole: Role }) {
  // Staff whose portal access is "No login" have no sign-in to speak of (an old account stays turned off).
  const s = p.kind === "staff" && p.access === "none" ? null : p.signIn;
  const boxId = `pick-${p.id}`;
  return (
    <tr className="hover:bg-cream-200/30">
      <Td className="w-14 !pr-0">
        {tickable && s ? (
          <label htmlFor={boxId} className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
            <input
              id={boxId}
              type="checkbox"
              name="accountId"
              value={s.accountId}
              form={SLIPS_FORM}
              data-reset={s.hasPassword ? "1" : "0"}
              defaultChecked={preTicked}
              className="h-6 w-6 cursor-pointer accent-forest-700"
            />
            <span className="sr-only">
              Select {p.name} ({p.loginId})
            </span>
          </label>
        ) : null}
      </Td>
      <Td className="whitespace-nowrap font-semibold tabular text-forest-900">{p.loginId}</Td>
      <Td className="min-w-44">
        <Link
          href={p.kind === "student" ? `/office/students/${p.id}` : `/office/staff/${p.id}`}
          className="inline-flex min-h-6 items-center font-semibold text-forest-900 underline-offset-2 hover:underline"
        >
          {p.name}
        </Link>
        {p.kind === "student" ? <span className="block text-[0.85rem] text-muted tabular">SR {p.number}</span> : null}
      </Td>
      <Td className="min-w-32">
        {p.kind === "student" ? (
          (p.detail ?? <span className="text-muted">Not placed</span>)
        ) : (
          <>
            {p.detail ?? (p.access ? ACCESS_LABELS[p.access] : "—")}
            {p.access && p.detail && p.detail.toLowerCase() !== ACCESS_LABELS[p.access].toLowerCase() ? (
              <span className="block text-[0.85rem] text-muted">Portal access: {ACCESS_LABELS[p.access]}</span>
            ) : null}
          </>
        )}
      </Td>
      <Td className="min-w-56">
        <SignInStatus signIn={s} current={p.current} kind={p.kind} />
      </Td>
      <Td className="min-w-48">
        <RowActions p={p} signIn={s} own={own} actorRole={actorRole} />
      </Td>
    </tr>
  );
}

/** "Unlock" for a login ID locked after too many wrong tries (or who can unlock it instead). */
function UnlockButton({ p, s, actorRole }: { p: AccessPerson; s: NonNullable<AccessPerson["signIn"]>; actorRole: Role }) {
  if (!s.lock || s.status === "disabled") return null;
  if (!mayPrintSlipFor(actorRole, s.role)) return <span className="text-[0.88rem] text-muted">An AESRI administrator can unlock it.</span>;
  return (
    <FormButton form={ROW_FORM} name="switch" value={`unlock:${s.accountId}`}>
      <LockOpen className="h-4 w-4" aria-hidden />
      Unlock<span className="sr-only"> sign-in for {p.name}</span>
    </FormButton>
  );
}

function RowActions({ p, signIn: s, own, actorRole }: { p: AccessPerson; signIn: AccessPerson["signIn"]; own: boolean; actorRole: Role }) {
  if (own) {
    return (
      <span className="text-[0.88rem] text-muted">
        This is you.{" "}
        <Link href="/account" className="font-semibold text-forest-800 underline underline-offset-2">
          Change your password
        </Link>
      </span>
    );
  }
  if (p.kind === "staff") {
    return (
      <span className="grid justify-items-start gap-1.5 text-[0.88rem]">
        {s ? <UnlockButton p={p} s={s} actorRole={actorRole} /> : null}
        {s && s.role === "school_admin" && actorRole !== "super_admin" && s.status !== "disabled" ? (
          <span className="text-muted">Slips for the principal and office admins are printed by an AESRI administrator.</span>
        ) : null}
        <Link href={`/office/staff/${p.id}`} className="inline-flex min-h-6 items-center font-semibold text-forest-800 underline underline-offset-2">
          Change portal access on the staff page<span className="sr-only">: {p.name}</span>
        </Link>
      </span>
    );
  }
  if (!s) return null;
  if (s.status === "disabled") {
    if (!p.current) {
      return (
        <Link href={`/office/students/${p.id}`} className="inline-flex min-h-6 items-center text-[0.88rem] font-semibold text-forest-800 underline underline-offset-2">
          If they return, change their status on the student page<span className="sr-only">: {p.name}</span>
        </Link>
      );
    }
    return (
      <FormButton form={ROW_FORM} name="switch" value={`on:${s.accountId}`}>
        Turn on sign-in<span className="sr-only"> for {p.name}</span>
      </FormButton>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <UnlockButton p={p} s={s} actorRole={actorRole} />
      <ConfirmButton
        form={ROW_FORM}
        name="switch"
        value={`off:${s.accountId}`}
        question={`Turn off sign-in for ${p.name}?`}
        confirmLabel="Yes, turn off"
      >
        Turn off sign-in<span className="sr-only"> for {p.name}</span>
      </ConfirmButton>
    </span>
  );
}
