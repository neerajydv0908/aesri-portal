import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Lock } from "lucide-react";
import { officePage } from "@/lib/page";
import { FEE_ROLES, OFFICE_ROLES } from "@/lib/roles";
import { getDb } from "@/lib/db/client";
import { classLabel } from "@/lib/classes";
import { formatDate } from "@/lib/dates";
import { currentPlan, dueDateFor, paymentsInSession, sessionDates, splitAnnual } from "@/lib/services/fees";
import { ActionForm, FieldError } from "@/components/forms";
import { Alert, Card, CardTitle, EmptyState, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ConfirmSubmit } from "@/components/ui/client";
import { RememberedInput } from "@/components/fees/client";
import { changeSplitAction } from "./actions";

export const metadata: Metadata = { title: "Fee plan" };

function classList(names: string[]): string {
  return names.map((n) => classLabel(n).replace("Class ", "")).join(", ");
}

export default async function FeePlanPage() {
  const { actor, schoolId, sessionId } = await officePage(FEE_ROLES);
  const db = await getDb();
  const [plan, paymentCount, session] = await Promise.all([currentPlan(db, schoolId), paymentsInSession(db, schoolId, sessionId), sessionDates(db, sessionId)]);
  const isAdmin = OFFICE_ROLES.includes(actor.role);

  const header = (
    <PageHeader
      eyebrow={
        <Link href="/office/fees" className="inline-flex min-h-6 items-center gap-1.5 hover:text-forest-900">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Fees
        </Link>
      }
      title="Fee plan"
      description={`The fees charged in session ${sessionId}: the annual fee each student pays, by class, when it is due, and the one-time admission fee.`}
    />
  );
  if (!plan) {
    return (
      <>
        {header}
        <EmptyState title="No fee plan">This school has no approved fee plan in the portal yet. Ask the AESRI administrator.</EmptyState>
      </>
    );
  }
  const percents = plan.instalments.map((i) => i.percent);
  const locked = paymentCount > 0;

  return (
    <>
      {header}

      <Alert tone="blue" title="Amounts mirror the approved fee structure" className="mb-8">
        These figures are the same as the fee structure published on the school&rsquo;s website (fee plan version {plan.version}, from session {plan.appliesFrom}
        {plan.approvalRef ? `, approval ${plan.approvalRef}` : ""}). Under the Rajasthan Schools (Regulation of Fee) Act only the approved fees may be charged, so amounts
        can&rsquo;t be edited or added here. Students on RTE seats are charged nothing.
      </Alert>

      <section aria-labelledby="bands-title" className="mb-10">
        <h2 id="bands-title" className="mb-2 font-display text-[1.35rem] text-forest-900">
          Annual fee per student, by class
        </h2>
        <p className="mb-4 max-w-3xl text-[0.95rem] text-forest-900/85">
          Each student in these classes pays this amount per year, in the instalments shown. A group such as &ldquo;LKG &ndash; Class V&rdquo; means every class in it has the
          same fee, not one fee shared between the classes. Fee lines and receipts name the student&rsquo;s own class, for example &ldquo;Term I &mdash; Class II&rdquo;.
        </p>
        <Table caption="Annual fee per student for each group of classes, and how it is split into instalments">
          <thead>
            <tr>
              <Th>Classes</Th>
              <Th className="text-right">Annual fee per student</Th>
              {plan.instalments.map((i) => (
                <Th key={i.id} className="text-right">
                  {i.label} ({i.percent}%)
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plan.bands.map((b) => {
              const parts = splitAnnual(b.annualAmount, percents);
              return (
                <tr key={b.id}>
                  <Td>
                    <span className="font-semibold text-forest-900">{b.label}</span>
                    <span lang="hi" className="block text-[0.88rem] text-muted">
                      {b.labelHi}
                    </span>
                    {b.classNames.length > 1 ? <span className="block text-[0.82rem] text-muted">Same fee in each class: {classList(b.classNames)}</span> : null}
                  </Td>
                  <Td className="text-right font-semibold">
                    <Money paise={b.annualAmount} />
                  </Td>
                  {parts.map((p, idx) => (
                    <Td key={plan.instalments[idx].id} className="text-right">
                      <Money paise={p} />
                    </Td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </Table>
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <Card>
          <CardTitle action={locked ? <Lock className="h-5 w-5 text-muted" aria-label="Locked" /> : null}>Instalments</CardTitle>
          {isAdmin && !locked ? (
            <ActionForm action={changeSplitAction}>
              <p className="text-[0.95rem] text-muted">
                The split and due dates are placeholders until the school confirms them: check them before any payment is recorded, because they lock after that. Percentages must
                add up to 100. Saving recreates every student&rsquo;s instalment lines (waivers made by hand are kept).
              </p>
              <div className="grid gap-4">
                {plan.instalments.map((i) => (
                  <fieldset key={i.id} className="grid gap-3 rounded-2xl bg-cream-100/70 p-4 ring-1 ring-forest-900/10 sm:grid-cols-[minmax(0,1fr)_7rem_11rem] sm:items-end">
                    <legend className="sr-only">{i.label}</legend>
                    <div>
                      <p className="font-semibold text-forest-900">{i.label}</p>
                      <p lang="hi" className="text-[0.88rem] text-muted">
                        {i.labelHi}
                      </p>
                    </div>
                    <div className="grid gap-1.5">
                      <label htmlFor={`pct-${i.id}`} className="text-[0.85rem] font-semibold text-forest-900">
                        Percent
                      </label>
                      <RememberedInput
                        id={`pct-${i.id}`}
                        name={`percent:${i.id}`}
                        inputMode="numeric"
                        defaultValue={String(i.percent)}
                        className="tabular"
                        aria-describedby={`percent:${i.id}-error`}
                      />
                      <FieldError name={`percent:${i.id}`} />
                    </div>
                    <div className="grid gap-1.5">
                      <label htmlFor={`due-${i.id}`} className="text-[0.85rem] font-semibold text-forest-900">
                        Due date
                      </label>
                      <RememberedInput
                        id={`due-${i.id}`}
                        name={`due:${i.id}`}
                        type="date"
                        defaultValue={dueDateFor(sessionId, i.dueMonthDay)}
                        min={session?.startsOn}
                        max={session?.endsOn}
                        aria-describedby={`due:${i.id}-error`}
                      />
                      <FieldError name={`due:${i.id}`} />
                    </div>
                  </fieldset>
                ))}
              </div>
              <div>
                <ConfirmSubmit variant="primary" size="md" question="Recreate every student's instalment lines?" confirmLabel="Yes, save">
                  Save instalments
                </ConfirmSubmit>
              </div>
            </ActionForm>
          ) : (
            <>
              <ul className="divide-y divide-forest-900/10 border-y border-forest-900/10">
                {plan.instalments.map((i) => (
                  <li key={i.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3.5">
                    <div>
                      <p className="font-semibold text-forest-900">{i.label}</p>
                      <p lang="hi" className="text-[0.88rem] text-muted">
                        {i.labelHi}
                      </p>
                    </div>
                    <p className="text-right font-display text-[1.4rem] leading-none text-forest-900 tabular">{i.percent}%</p>
                    <p className="col-span-2 text-[0.92rem] text-forest-900">
                      Due by <span className="font-semibold tabular">{formatDate(dueDateFor(sessionId, i.dueMonthDay), "en", { long: true })}</span>
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-[0.9rem] text-muted">
                {locked
                  ? `Locked for ${sessionId}: ${paymentCount} ${paymentCount === 1 ? "payment has" : "payments have"} been recorded, so the instalments can no longer change this session.`
                  : "Only the principal or the office administrator can change the split and due dates, and only before any payment is recorded."}
              </p>
            </>
          )}
        </Card>

        <Card>
          <CardTitle>One-time fee</CardTitle>
          {plan.oneTime.length ? (
            <ul className="grid gap-4">
              {plan.oneTime.map((o) => (
                <li key={o.id}>
                  <p className="font-semibold text-forest-900">{o.label}</p>
                  <p lang="hi" className="text-[0.88rem] text-muted">
                    {o.labelHi}
                  </p>
                  <p className="mt-2 font-display text-[1.8rem] leading-none text-forest-900">
                    <Money paise={o.amount} />
                  </p>
                  <p className="mt-2 text-[0.9rem] text-muted">
                    {o.refundable ? "Refundable." : "Non-refundable."} Charged once, to students admitted during the session. An administrator adds it from the student&rsquo;s fee
                    page.
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">None.</p>
          )}
          <p className="mt-5 border-t border-forest-900/10 pt-4 text-[0.85rem] text-muted">
            Session {sessionId} runs {session ? `${formatDate(session.startsOn)} – ${formatDate(session.endsOn)}` : ""}. No other fee heads can be charged.
          </p>
        </Card>
      </div>
    </>
  );
}
