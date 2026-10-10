/** Home for the accountant: the session's fee position, the fee pages, and the office's notices to staff. */
import Link from "next/link";
import { BookOpenCheck, ChevronRight, Megaphone, ReceiptText, Users, Wallet } from "lucide-react";
import { officePage } from "@/lib/page";
import { FEE_ROLES } from "@/lib/roles";
import { formatDate, todayIST } from "@/lib/dates";
import { getSchool } from "@/lib/queries/school";
import { rupees, schoolFeeTotals } from "@/lib/services/fees";
import { activeNoticesForStaff, noticeCategoryLabel } from "@/lib/services/notices";
import { Alert, Badge, Card, CardTitle, Money, PageHeader, Stat } from "@/components/ui";

const LINKS = [
  { href: "/office/fees", title: "Fees", text: "Students and what they owe; record a payment or print a receipt.", icon: Wallet },
  { href: "/office/fees/collections", title: "Collections", text: "Receipts by day or month, and the download for the books.", icon: ReceiptText },
  { href: "/office/fees/plan", title: "Fee plan", text: "The approved fees and instalment dates.", icon: BookOpenCheck },
  { href: "/office/students", title: "Students", text: "Look up a student’s class and contact details.", icon: Users },
];

export async function AccountsHome({ welcome }: { welcome: boolean }) {
  const ctx = await officePage(FEE_ROLES);
  const today = todayIST();
  const [school, fees, notices] = await Promise.all([getSchool(ctx.schoolId), schoolFeeTotals(ctx.schoolId, ctx.sessionId), activeNoticesForStaff(ctx.schoolId, today)]);
  return (
    <>
      <PageHeader eyebrow={`Accounts · Session ${ctx.sessionId}`} title={school?.name ?? "Accounts"} description={formatDate(today, "en", { weekday: true, long: true })} />
      {welcome ? (
        <Alert tone="green" title="Welcome! Your account is ready." className="mb-6">
          Your authenticator app is set up: you&rsquo;ll need a code from it each time you sign in. Keep your password to yourself.
        </Alert>
      ) : null}
      <section aria-labelledby="fees-now" className="mb-8">
        <h2 id="fees-now" className="sr-only">
          Fees this session
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Collected today"
            value={<Money paise={fees.collectedToday} />}
            hint={fees.refundedToday ? `Counter and online; ${rupees(fees.refundedToday)} refunded today` : "Counter and online, not opening balances"}
            href="/office/fees/collections"
          />
          <Stat
            label="Collected this session"
            value={<Money paise={fees.collected} />}
            tone="green"
            hint={fees.refunded ? `Including fees paid before the portal, less ${rupees(fees.refunded)} refunded` : "Including fees paid before the portal"}
          />
          <Stat label="Still to pay" value={<Money paise={fees.outstanding} />} tone={fees.outstanding ? "amber" : "default"} hint="Including instalments not yet due" />
          <Stat
            label="Overdue"
            value={<Money paise={fees.overdue} />}
            tone={fees.overdue ? "red" : "default"}
            hint="Past the due date"
            href={fees.overdue ? "/office/fees?overdue=1#students" : undefined}
          />
        </div>
      </section>
      <nav aria-label="Fee pages">
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="card flex min-h-20 items-center gap-4 p-5 transition-shadow hover:shadow-[0_0_0_1px_rgba(19,39,28,0.18),0_24px_40px_-30px_rgba(19,39,28,0.55)]">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sage-100 text-forest-700">
                  <l.icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-forest-900">{l.title}</span>
                  <span className="block text-[0.9rem] text-muted">{l.text}</span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-forest-800" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <Card className="mt-8">
        <CardTitle>
          <span className="flex items-center gap-2.5">
            <Megaphone className="h-5 w-5 text-forest-700" aria-hidden />
            Notices from the office
          </span>
        </CardTitle>
        <p className="-mt-2 mb-4 text-[0.9rem] text-muted">Notices for the whole school and for staff that are showing today, newest first.</p>
        {notices.length ? (
          <ul className="grid gap-5">
            {notices.map((n) => (
              <li key={n.id} className="border-t border-forest-900/10 pt-4 first:border-t-0 first:pt-0">
                <p className="flex flex-wrap items-center gap-2 text-[0.85rem] text-muted">
                  <Badge tone={n.audience === "staff" ? "amber" : "blue"}>{n.audience === "staff" ? "Staff only" : "Whole school"}</Badge>
                  <span>{noticeCategoryLabel(n.category)}</span>
                  <span aria-hidden>·</span>
                  <span>{formatDate(n.publishOn)}</span>
                </p>
                <h3 className="mt-1.5 font-sans text-[1.05rem] font-bold tracking-normal text-forest-900">{n.titleEn}</h3>
                <p className="mt-1 whitespace-pre-line text-forest-900">{n.bodyEn}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-forest-900">No notices from the office today.</p>
        )}
      </Card>
    </>
  );
}
