import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, MessageSquareText, Settings } from "lucide-react";
import { ActionForm } from "@/components/forms";
import { Flash } from "@/components/flash";
import { DateField, FilterBar, SearchField, SectionField } from "@/components/pickers";
import { MaskedMobile, SmsStatusBadge } from "@/components/sms/parts";
import { Alert, ButtonLink, EmptyState, PageHeader, Select, Stat, Table, Td, Th, buttonClasses } from "@/components/ui";
import { ConfirmSubmit, SubmitButton } from "@/components/ui/client";
import { addDays, formatDate, formatDateTime, isValidIsoDate, todayIST } from "@/lib/dates";
import { officePage } from "@/lib/page";
import { getSchool, listSections } from "@/lib/queries/school";
import {
  isSmsStatus,
  recentFailedCount,
  schoolSmsSettings,
  SMS_PAGE_SIZE,
  smsCounts,
  smsListPage,
  smsSetup,
  templatesMissing,
  type SmsListRow,
  type StatusCounts,
} from "@/lib/queries/sms";
import { RETRY_DAYS } from "@/lib/sms/outbox";
import { isSmsKind, KIND_LABELS, SMS_KINDS } from "@/lib/sms/settings";
import { SMS_LANG_NAMES, TEMPLATES, isTemplateKey } from "@/lib/sms/templates";
import { cancelSmsAction, retrySmsAction } from "./actions";
import { TestSmsCard } from "./test-form";

export const metadata: Metadata = { title: "Text messages" };

type SP = { from?: string; to?: string; kind?: string; status?: string; section?: string; q?: string; page?: string; done?: string };

const STATUS_WORDS: Record<string, string> = { sent: "Sent", queued: "Waiting to send", failed: "Failed", skipped: "Not sent", cancelled: "Cancelled" };

export default async function SmsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await officePage();
  const sp = await searchParams;
  const today = todayIST();
  let from = typeof sp.from === "string" && isValidIsoDate(sp.from) ? sp.from : addDays(today, -6);
  let to = typeof sp.to === "string" && isValidIsoDate(sp.to) ? sp.to : today;
  if (from > to) [from, to] = [to, from];
  const kind = isSmsKind(sp.kind) ? sp.kind : null;
  const status = isSmsStatus(sp.status) ? sp.status : null;
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 60) : "";
  const page = Math.min(10_000, Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1));
  const monthStart = `${today.slice(0, 7)}-01`;
  const [school, sections, settings, month, failedRecent] = await Promise.all([
    getSchool(ctx.schoolId),
    listSections(ctx.schoolId, ctx.sessionId),
    schoolSmsSettings(ctx.schoolId),
    smsCounts(ctx.schoolId, monthStart, addDays(today, 1)),
    recentFailedCount(ctx.schoolId, new Date(Date.now() - RETRY_DAYS * 86_400_000)),
  ]);
  const sectionId = typeof sp.section === "string" && sections.some((s) => s.id === sp.section) ? sp.section : null;
  const [list, missing] = await Promise.all([
    smsListPage({ schoolId: ctx.schoolId, sessionId: ctx.sessionId, from, to, kind, status, sectionId, q, page }),
    templatesMissing(ctx.schoolId, settings.lang),
  ]);
  const setup = smsSetup();
  const pages = Math.max(1, Math.ceil(list.total / SMS_PAGE_SIZE));
  const query = (p: number) => {
    const u = new URLSearchParams({ from, to });
    if (kind) u.set("kind", kind);
    if (status) u.set("status", status);
    if (sectionId) u.set("section", sectionId);
    if (q) u.set("q", q);
    if (p > 1) u.set("page", String(p));
    return u.toString();
  };
  const back = query(page);
  const monthKinds = SMS_KINDS.filter((k) => month.byKind.has(k));

  return (
    <>
      <PageHeader
        eyebrow="School office"
        title="Text messages"
        description={`Every text message (SMS) the portal sends to the families and staff of ${school?.name ?? "this school"}: what it said, to which number, and whether it went.`}
        actions={
          <ButtonLink href="/office/settings" variant="secondary">
            <Settings className="h-4 w-4" aria-hidden />
            Text message settings
          </ButtonLink>
        }
      />
      <Flash
        code={sp.done}
        messages={{
          retried: "The message will be tried again within a minute.",
          retried_all: "The failed messages will be tried again within a minute.",
          cancelled: "The message was cancelled. It won’t be sent.",
        }}
      />

      <div className="mb-6 grid gap-3">
        {setup.mode === "test" ? (
          <Alert tone="amber" title="Test mode: nothing is really sent">
            This server has no SMS company set up. Messages are written to the server’s log and shown here as “Sent (test mode)”; nobody’s phone gets them.
          </Alert>
        ) : setup.mode === "off" ? (
          <Alert tone="amber" title="Text messages aren’t set up yet">
            No SMS company is connected to the portal, so messages are recorded here as “Not sent”. The AESRI administrator sets this up (see docs/SMS.md).
          </Alert>
        ) : null}
        {!settings.enabled ? (
          <Alert tone="amber" title="Text messages are switched off">
            No messages are sent for this school. <Link href="/office/settings" className="font-semibold underline underline-offset-2">Switch them on in Settings</Link>.
          </Alert>
        ) : null}
        {missing.length ? (
          <Alert tone="amber" title={`${missing.length} ${missing.length === 1 ? "message wording has" : "message wordings have"} no template ID yet`}>
            {missing.map((k) => TEMPLATES[k].name).join(", ")} ({SMS_LANG_NAMES[settings.lang]}): these messages are recorded as “Not sent” until the AESRI administrator registers them and enters their {setup.providerLabel} template IDs.
          </Alert>
        ) : null}
        {failedRecent ? (
          <Alert tone="red" title={`${failedRecent} ${failedRecent === 1 ? "message" : "messages"} failed in the last ${RETRY_DAYS} days`}>
            <span className="block">The SMS company didn’t accept {failedRecent === 1 ? "it" : "them"}, even after trying again. Each one shows why below.</span>
            <ActionForm action={retrySmsAction} className="mt-3 gap-2">
              <input type="hidden" name="all" value="yes" />
              <input type="hidden" name="back" value={back} />
              <div>
                <SubmitButton variant="secondary" size="sm" pendingLabel="Trying again…">
                  Try all of them again
                </SubmitButton>
              </div>
            </ActionForm>
          </Alert>
        ) : null}
      </div>

      <section aria-labelledby="this-month" className="mb-8">
        <h2 id="this-month" className="mb-3 font-display text-[1.35rem] text-forest-900">
          This month
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Sent" value={month.total.sent} tone="green" />
          <Stat label="Waiting" value={month.total.queued} />
          <Stat label="Failed" value={month.total.failed} tone={month.total.failed ? "red" : "default"} />
          <Stat label="Not sent" value={month.total.skipped + month.total.cancelled} tone="grey" hint="Opted out, no mobile, switched off or not set up" />
        </div>
        {monthKinds.length ? (
          <Table caption="Text messages this month, by event" className="mt-4">
            <thead>
              <tr>
                <Th>Event</Th>
                <Th className="text-right">Sent</Th>
                <Th className="text-right">Waiting</Th>
                <Th className="text-right">Failed</Th>
                <Th className="text-right">Not sent</Th>
                <Th className="text-right">Cancelled</Th>
              </tr>
            </thead>
            <tbody>
              {monthKinds.map((k) => {
                const c = month.byKind.get(k) as StatusCounts;
                return (
                  <tr key={k}>
                    <Td className="font-semibold text-forest-900">{KIND_LABELS[k]}</Td>
                    <Td className="text-right tabular">{c.sent}</Td>
                    <Td className="text-right tabular">{c.queued}</Td>
                    <Td className="text-right tabular">{c.failed}</Td>
                    <Td className="text-right tabular">{c.skipped}</Td>
                    <Td className="text-right tabular">{c.cancelled}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : null}
      </section>

      <section aria-labelledby="messages">
        <h2 id="messages" className="mb-3 font-display text-[1.35rem] text-forest-900">
          Messages
        </h2>
        <FilterBar action="/office/sms">
          <DateField name="from" label="From" value={from} max={today} />
          <DateField name="to" label="To" value={to} max={today} />
          <div className="grid gap-1.5">
            <label htmlFor="pick-kind" className="text-[0.85rem] font-semibold text-forest-900">
              Event
            </label>
            <Select id="pick-kind" name="kind" defaultValue={kind ?? ""} className="min-w-48">
              <option value="">All events</option>
              {SMS_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="pick-status" className="text-[0.85rem] font-semibold text-forest-900">
              Status
            </label>
            <Select id="pick-status" name="status" defaultValue={status ?? ""} className="min-w-44">
              <option value="">Any status</option>
              {Object.entries(STATUS_WORDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          <SectionField sections={sections} value={sectionId} allowAll />
          <SearchField value={q} label="Search" placeholder="Name, SR no. or last digits of a mobile" />
        </FilterBar>

        <p className="mb-3 text-[0.92rem] text-muted" role="status">
          {list.total ? `${list.total} ${list.total === 1 ? "message" : "messages"}` : "No messages"} {from === to ? `on ${formatDate(from)}` : `from ${formatDate(from)} to ${formatDate(to)}`}
          {kind ? ` · ${KIND_LABELS[kind]}` : ""}
          {status ? ` · ${STATUS_WORDS[status]}` : ""}
          {sectionId ? ` · ${sections.find((s) => s.id === sectionId)?.label}` : ""}
          {q ? ` · “${q}”` : ""}.{list.total > SMS_PAGE_SIZE ? ` Showing ${(page - 1) * SMS_PAGE_SIZE + 1}–${Math.min(list.total, page * SMS_PAGE_SIZE)}, newest first.` : list.total ? " Newest first." : ""}
        </p>

        {list.rows.length ? (
          <>
            <Table caption="Text messages, newest first">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>To</Th>
                  <Th>Student or staff</Th>
                  <Th>Event</Th>
                  <Th>Status</Th>
                  <Th>Message</Th>
                  <Th className="relative">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => (
                  <MessageRow key={r.id} r={r} back={back} />
                ))}
              </tbody>
            </Table>
            {pages > 1 ? (
              <nav aria-label="Pages of messages" className="mt-5 flex flex-wrap items-center justify-between gap-3">
                {page > 1 ? (
                  <Link href={`/office/sms?${query(page - 1)}`} className={buttonClasses("secondary", "md")}>
                    <ChevronLeft className="h-4 w-4" aria-hidden />
                    Newer messages
                  </Link>
                ) : (
                  <span />
                )}
                <p className="text-[0.92rem] text-muted">
                  Page {Math.min(page, pages)} of {pages}
                </p>
                {page < pages ? (
                  <Link href={`/office/sms?${query(page + 1)}`} className={buttonClasses("secondary", "md")}>
                    Older messages
                    <ChevronRight className="h-4 w-4" aria-hidden />
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            ) : null}
          </>
        ) : (
          <EmptyState icon={<MessageSquareText className="h-5 w-5" aria-hidden />} title="No messages for these choices">
            Try a longer date range or another event, or{" "}
            <Link href="/office/sms" className="font-semibold underline underline-offset-2">
              show the last 7 days
            </Link>
            .
          </EmptyState>
        )}
      </section>

      <div className="mt-10 max-w-2xl">
        <TestSmsCard defaultLang={settings.lang} schoolName={school?.name} />
      </div>
    </>
  );
}

function MessageRow({ r, back }: { r: SmsListRow; back: string }) {
  const retryable = r.status === "failed" && r.createdAt.getTime() > Date.now() - RETRY_DAYS * 86_400_000;
  const template = isTemplateKey(r.template) ? TEMPLATES[r.template].name : r.template;
  return (
    <tr className="align-top">
      <Td className="min-w-36 text-[0.9rem] tabular">
        <time dateTime={r.createdAt.toISOString()} className="block whitespace-nowrap">
          {formatDateTime(r.createdAt)}
        </time>
        {r.status === "sent" && r.sentAt ? <span className="block whitespace-nowrap text-[0.82rem] text-muted">Sent {formatDateTime(r.sentAt).split(", ")[1]}</span> : null}
        {r.status === "queued" ? <span className="block whitespace-nowrap text-[0.82rem] text-muted">Due {formatDateTime(r.sendAfter)}</span> : null}
      </Td>
      <Td>
        <MaskedMobile mobile={r.toMobile} />
      </Td>
      <Td className="min-w-40">
        {r.studentId && r.studentName ? (
          <>
            <Link href={`/office/students/${r.studentId}`} className="font-semibold text-forest-800 underline-offset-2 hover:underline">
              {r.studentName}
            </Link>
            {r.studentSection ? <span className="block text-[0.85rem] text-muted">{r.studentSection}</span> : null}
          </>
        ) : r.staffName ? (
          <>
            <span className="font-semibold text-forest-900">{r.staffName}</span>
            <span className="block text-[0.85rem] text-muted">Staff</span>
          </>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
      <Td className="min-w-32 text-[0.92rem]">
        {(KIND_LABELS as Record<string, string>)[r.kind] ?? r.kind}
        {r.template === "payment_cancelled" ? <span className="block text-[0.82rem] text-muted">{template}</span> : null}
      </Td>
      <Td className="min-w-44">
        <SmsStatusBadge status={r.status} provider={r.provider} attempts={r.attempts} />
        {r.error ? <span className="mt-1 block max-w-[18rem] text-[0.85rem] leading-snug text-forest-900/85">{r.error}</span> : null}
      </Td>
      <Td className="min-w-72 max-w-[28rem] text-[0.9rem]">
        {r.body ? (
          <span lang={r.lang === "hi" ? "hi" : "en"} className="block break-words">
            {r.body}
          </span>
        ) : (
          <span className="text-muted">Cleared after 180 days</span>
        )}
      </Td>
      <Td className="min-w-32">
        {retryable ? (
          <ActionForm action={retrySmsAction} className="gap-2">
            <input type="hidden" name="id" value={r.id} />
            <input type="hidden" name="back" value={back} />
            <div>
              <SubmitButton variant="secondary" size="sm" pendingLabel="Trying…">
                Try again
              </SubmitButton>
            </div>
          </ActionForm>
        ) : r.status === "queued" ? (
          <ActionForm action={cancelSmsAction} className="gap-2">
            <input type="hidden" name="id" value={r.id} />
            <input type="hidden" name="back" value={back} />
            <div>
              <ConfirmSubmit question="Cancel this message?" confirmLabel="Yes, cancel it" cancelLabel="Keep it">
                Cancel<span className="sr-only"> the message{r.studentName ? ` about ${r.studentName}` : ""}</span>
              </ConfirmSubmit>
            </div>
          </ActionForm>
        ) : null}
      </Td>
    </tr>
  );
}
