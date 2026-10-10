/** Home for the school office (principal, office admin) and AESRI administrators. */
import Link from "next/link";
import { BookOpen, BookOpenCheck, Building2, ChevronRight, CircleCheck, Circle, FileSpreadsheet, KeyRound, Layers, Megaphone, ReceiptText, ScrollText, Wallet } from "lucide-react";
import { officePage } from "@/lib/page";
import { formatDate, formatDateTime, todayIST } from "@/lib/dates";
import { getSchool } from "@/lib/queries/school";
import { officeOverview, recentActivity } from "@/lib/queries/home";
import { marksEntryProgress } from "@/lib/services/exams";
import { rupees, schoolFeeTotals } from "@/lib/services/fees";
import { waitingClaimCount } from "@/lib/services/cash-claims";
import { getDb } from "@/lib/db/client";
import { formatPercent } from "@/components/exams/rules";
import { Alert, Card, CardTitle, Money, PageHeader, Stat } from "@/components/ui";

const n = (x: number) => x.toLocaleString("en-IN");
const plural = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`;

type ExamProgress = { examId: string; examName: string; entered: number; expected: number; sections: number; published: number };

export async function OfficeHome({ welcome }: { welcome: boolean }) {
  const ctx = await officePage();
  const today = todayIST();
  const [school, o, fees, progress, activity, cashToApprove] = await Promise.all([
    getSchool(ctx.schoolId),
    officeOverview(ctx.schoolId, ctx.sessionId, today),
    schoolFeeTotals(ctx.schoolId, ctx.sessionId),
    marksEntryProgress(ctx.schoolId, ctx.sessionId),
    recentActivity(ctx.schoolId, 8),
    getDb().then((db) => waitingClaimCount(db, ctx.schoolId)),
  ]);

  const exams = new Map<string, ExamProgress>();
  for (const r of progress) {
    const e = exams.get(r.examId) ?? { examId: r.examId, examName: r.examName, entered: 0, expected: 0, sections: 0, published: 0 };
    e.entered += r.entered;
    e.expected += r.expected;
    e.sections++;
    if (r.status === "published") e.published++;
    exams.set(r.examId, e);
  }
  const openExams = [...exams.values()].filter((e) => e.published < e.sections);

  // Day one, in order. A step counts as done only when it really is (see OfficeOverview.setup).
  const s = o.setup;
  const hasStudents = o.students > 0;
  const aesri = ctx.actor.role === "super_admin";
  const slipStaff = s.slips.staff + (aesri ? s.slips.adminStaff : 0);
  const steps: { key: string; done: boolean; title: string; text: string; href: string; icon: typeof Layers }[] = [
    {
      key: "subjects",
      done: s.subjects > 0 && s.classesWithoutSubjects === 0,
      title: "Add subjects",
      text: !s.subjects
        ? "Add the subjects the school teaches on Classes & subjects, and tick them for each class. (Subjects named in the Excel file’s “Subjects taught” column are added too.)"
        : `${plural(s.classesWithoutSubjects, "class with students has", "classes with students have")} no subjects yet: tick their subjects on Classes & subjects. (Nursery, LKG and UKG may have none.)`,
      href: s.subjects ? "/office/classes" : "/office/classes?view=subjects",
      icon: BookOpen,
    },
    {
      key: "import",
      done: hasStudents && s.teachers > 0,
      title: "Import students and staff",
      text: "Fill in the Excel template from the SR register and the staff register, and upload it.",
      href: "/office/import",
      icon: FileSpreadsheet,
    },
    {
      key: "opening",
      done: hasStudents && s.opening.done >= s.opening.of,
      title: "Enter fees already paid on paper",
      text: hasStudents
        ? `Done for ${n(s.opening.done)} of ${plural(s.opening.of, "class", "classes")} with fees (opening balances saved, or marked as nothing paid on paper). Do every class before families sign in: until then they see fees paid on paper as overdue.`
        : "After the import, enter what families paid on paper before the portal, class by class, so they don’t see those fees as overdue.",
      href: "/office/fees/opening",
      icon: ReceiptText,
    },
    {
      key: "teachers",
      // Subject teachers can only be chosen once each class's subjects are ticked (step 1).
      done: hasStudents && s.sectionsWithoutClassTeacher === 0 && s.subjectTeachersMissing === 0 && s.subjects > 0 && s.classesWithoutSubjects === 0,
      title: "Set class teachers and subject teachers",
      text:
        hasStudents && (s.sectionsWithoutClassTeacher || s.subjectTeachersMissing || s.classesWithoutSubjects)
          ? [
              s.sectionsWithoutClassTeacher ? `${plural(s.sectionsWithoutClassTeacher, "section has", "sections have")} no class teacher` : null,
              s.subjectTeachersMissing ? `${plural(s.subjectTeachersMissing, "subject in a section has", "subjects in sections have")} no teacher yet` : null,
              s.classesWithoutSubjects ? "subject teachers can be chosen once each class’s subjects are ticked (step 1)" : null,
            ]
              .filter(Boolean)
              .join("; ")
              .replace(/^./, (c) => c.toUpperCase()) + "."
          : "Choose each section’s class teacher, and who teaches each subject in it.",
      href: "/office/classes",
      icon: Layers,
    },
    {
      key: "slips",
      done: hasStudents && slipStaff === 0 && s.slips.families === 0 && s.slips.adminStaff === 0,
      title: "Print sign-in slips: staff first, then families",
      text: hasStudents
        ? [
            slipStaff || s.slips.families
              ? `Still to print: ${[slipStaff ? plural(slipStaff, "member of staff", "staff") : null, s.slips.families ? plural(s.slips.families, "family", "families") : null].filter(Boolean).join(" and ")}.`
              : null,
            !aesri && s.slips.adminStaff
              ? `The AESRI administrator prints the slips for the principal and office admins (${plural(s.slips.adminStaff, "person is", "people are")} waiting).`
              : null,
            "Done when everyone who signs in has activated or has a slip that still works.",
          ]
            .filter(Boolean)
            .join(" ")
        : "Each member of staff and each family gets a slip with their login ID and a one-time code. Print them once the fees are up to date.",
      href: slipStaff ? "/office/access?tab=staff" : "/office/access",
      icon: KeyRound,
    },
  ];
  const setupDone = steps.every((x) => x.done);

  return (
    <>
      <PageHeader eyebrow={`School office · Session ${ctx.sessionId}`} title={school?.name ?? "School office"} description={formatDate(today, "en", { weekday: true, long: true })} />

      {welcome ? (
        <Alert tone="green" title="Welcome! Your account is ready." className="mb-6">
          Your authenticator app is set up: you&rsquo;ll need a code from it each time you sign in. Keep your password to yourself.
        </Alert>
      ) : null}

      {cashToApprove ? (
        <Link
          href="/office/fees/approvals"
          className="card mb-6 flex min-h-16 items-center gap-4 p-5 ring-2 ring-alert-600/70 transition-shadow hover:shadow-[0_0_0_1px_rgba(19,39,28,0.18),0_24px_40px_-30px_rgba(19,39,28,0.55)]"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-alert-600 text-[1rem] font-bold text-cream-50" aria-hidden>
            {cashToApprove > 99 ? "99+" : cashToApprove}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-forest-900">
              {cashToApprove} cash {cashToApprove === 1 ? "payment" : "payments"} to approve
            </span>
            <span className="block text-[0.9rem] text-muted">Recorded by families on the portal. Check them against the cash received, then approve or decline.</span>
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-forest-800" aria-hidden />
        </Link>
      ) : null}

      {ctx.actor.role === "super_admin" ? (
        <Link
          href="/aesri"
          className="card mb-6 flex min-h-16 items-center gap-4 p-5 transition-shadow hover:shadow-[0_0_0_1px_rgba(19,39,28,0.18),0_24px_40px_-30px_rgba(19,39,28,0.55)]"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sage-100 text-forest-700">
            <Building2 className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-forest-900">Both schools at a glance</span>
            <span className="block text-[0.9rem] text-muted">AESRI overview. You are working in {school?.name ?? "this school"}; switch school at the top of the page.</span>
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-forest-800" aria-hidden />
        </Link>
      ) : null}

      {!setupDone ? (
        <Card className="mb-6">
          <CardTitle>Getting started</CardTitle>
          <ol className="grid gap-3">
            {steps.map((step, i) => (
              <li key={step.key}>
                <Link href={step.href} className="flex min-h-14 items-start gap-3 rounded-2xl px-2 py-2 hover:bg-cream-200/50">
                  {step.done ? (
                    <CircleCheck className="mt-0.5 h-6 w-6 shrink-0 text-forest-700" aria-hidden />
                  ) : (
                    <Circle className="mt-0.5 h-6 w-6 shrink-0 text-ochre-600" aria-hidden />
                  )}
                  <span className="min-w-0">
                    <span className="block font-semibold text-forest-800 underline-offset-2 hover:underline">
                      {i + 1}. {step.title}
                      <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
                    </span>
                    <span className="block text-[0.92rem] text-muted">{step.done ? "Done." : step.text}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      <section aria-labelledby="today" className="mb-8">
        <h2 id="today" className="sr-only">
          The school today
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Students"
            value={n(o.students)}
            hint={o.studentsUnplaced ? `${plural(o.studentsUnplaced, "more is", "more are")} not placed in a class yet` : "Studying now, in a class this session"}
            href="/office/students"
          />
          <Stat label="Staff" value={n(o.staff)} hint={`${n(o.staffWithLogin)} can sign in`} href="/office/staff" />
          <Stat
            label="Family sign-ins"
            value={
              <>
                {n(o.familiesActive)}
                <span className="text-[1.2rem] text-muted"> of {n(o.students)}</span>
              </>
            }
            hint="Families who have activated their login"
            href="/office/access"
          />
          <Stat
            label="Registers today"
            value={
              <>
                {n(o.registers.taken)}
                <span className="text-[1.2rem] text-muted"> of {n(o.registers.of)}</span>
              </>
            }
            tone={o.registers.of && o.registers.taken >= o.registers.of ? "green" : "default"}
            hint={o.registers.of ? (o.registers.taken >= o.registers.of ? "All taken" : `${n(o.registers.of - o.registers.taken)} still to take`) : "No classes with students yet"}
            href="/office/attendance"
          />
        </div>
      </section>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle action={<CardLink href="/office/fees" label="Fees" />}>
            <span className="flex items-center gap-2.5">
              <Wallet className="h-5 w-5 text-forest-700" aria-hidden />
              Fees
            </span>
          </CardTitle>
          <dl className="grid grid-cols-3 gap-4">
            <div>
              <dt className="text-[0.85rem] text-muted">Collected today</dt>
              <dd className="mt-1 font-display text-[1.45rem] leading-tight text-forest-900">
                <Money paise={fees.collectedToday} />
              </dd>
            </div>
            <div>
              <dt className="text-[0.85rem] text-muted">This session</dt>
              <dd className="mt-1 font-display text-[1.45rem] leading-tight text-forest-700">
                <Money paise={fees.collected} />
              </dd>
            </div>
            <div>
              <dt className="text-[0.85rem] text-muted">Overdue</dt>
              <dd className={`mt-1 font-display text-[1.45rem] leading-tight ${fees.overdue ? "text-clay-600" : "text-forest-900"}`}>
                <Money paise={fees.overdue} />
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[0.88rem] text-muted">
            {rupees(fees.outstanding)} still to be paid this session, including instalments not yet due.
            {fees.refunded ? ` This session’s figure is after ${rupees(fees.refunded)} refunded${fees.refundedToday ? ` (${rupees(fees.refundedToday)} today)` : ""}.` : ""}
          </p>
        </Card>

        <Card>
          <CardTitle action={<CardLink href="/office/exams" label="Exams & results" />}>
            <span className="flex items-center gap-2.5">
              <BookOpenCheck className="h-5 w-5 text-forest-700" aria-hidden />
              Marks entry
            </span>
          </CardTitle>
          {openExams.length ? (
            <ul className="grid gap-3">
              {openExams.map((e) => (
                <li key={e.examId}>
                  <Link href={`/office/exams/${e.examId}`} className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 rounded-xl px-2 py-1 hover:bg-cream-200/50">
                    <span className="font-semibold text-forest-800 underline-offset-2 hover:underline">{e.examName}</span>
                    <span className="text-[0.9rem] text-muted tabular">
                      {e.expected ? formatPercent(Math.round((e.entered * 1000) / e.expected)) : "—"} entered · {e.published} of {plural(e.sections, "section", "sections")} published
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-forest-900">{exams.size ? "Every exam's results are published." : "No exams with papers this session yet."}</p>
          )}
        </Card>

        <Card>
          <CardTitle action={<CardLink href="/office/notices?status=draft" label="Notices" />}>
            <span className="flex items-center gap-2.5">
              <Megaphone className="h-5 w-5 text-forest-700" aria-hidden />
              Notices waiting
            </span>
          </CardTitle>
          <p className="text-forest-900">
            {o.noticesWaiting
              ? `${plural(o.noticesWaiting, "notice is", "notices are")} saved as a draft and not published yet.`
              : "No drafts waiting to be published."}
          </p>
        </Card>

        <Card>
          <CardTitle action={<CardLink href="/office/log" label="Activity log" />}>
            <span className="flex items-center gap-2.5">
              <ScrollText className="h-5 w-5 text-forest-700" aria-hidden />
              Recent activity
            </span>
          </CardTitle>
          {activity.length ? (
            <ul className="grid gap-3">
              {activity.map((a, i) => (
                <li key={i}>
                  <p className="font-semibold text-forest-900">{a.text}</p>
                  <p className="text-[0.88rem] text-muted">
                    {a.several ? "Several people" : (a.by?.name ?? a.byLogin ?? "The portal")} · {formatDateTime(a.at)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-forest-900">Nothing yet.</p>
          )}
        </Card>
      </div>
    </>
  );
}

function CardLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex min-h-11 shrink-0 items-center gap-1 text-[0.92rem] font-semibold text-forest-800 underline-offset-4 hover:underline">
      Open<span className="sr-only"> {label}</span>
      <ChevronRight className="h-4 w-4" aria-hidden />
    </Link>
  );
}
