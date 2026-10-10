/** Home for a family: the child's day-to-day at a glance, in English or Hindi. */
import Link from "next/link";
import type { ReactNode } from "react";
import { CalendarCheck2, ChevronRight, GraduationCap, Megaphone, MessageSquareText, NotebookPen, Wallet } from "lucide-react";
import { familyPage } from "@/lib/page";
import { classLabel, classLabelHi } from "@/lib/classes";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import { attendanceSummary, formatPercent } from "@/lib/services/attendance";
import { latestPublishedResult } from "@/lib/services/exams";
import { examNameHi } from "@/components/exams/rules";
import { familyFeeSummary, rupees } from "@/lib/services/fees";
import { homeworkDueForFamily } from "@/lib/services/homework";
import { activeNoticesForFamily, familyNoticeText } from "@/lib/services/notices";
import { familyTexts } from "@/lib/translate";
import { FamilyText } from "@/components/translate/family-text";
import { TranslationSummary } from "@/components/translate/translated-note";
import { recentRemarksCount } from "@/lib/services/remarks";
import { getSchool } from "@/lib/queries/school";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { eyebrowFor } from "@/components/fees/text";

function HomeCard({ icon, title, href, linkText, children, className }: { icon: ReactNode; title: string; href: string; linkText: string; children: ReactNode; className?: string }) {
  return (
    <Card as="article" className={`flex flex-col ${className ?? ""}`}>
      <h2 className="flex items-center gap-2.5 font-display text-[1.3rem] leading-tight text-forest-900">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sage-100 text-forest-700">{icon}</span>
        {title}
      </h2>
      <div className="mt-4 flex-1">{children}</div>
      <Link href={href} className="mt-4 inline-flex min-h-11 items-center gap-1 self-start font-semibold text-forest-800 underline-offset-4 hover:underline">
        {linkText}
        <ChevronRight className="h-4 w-4" aria-hidden />
      </Link>
    </Card>
  );
}

export async function FamilyHome({ welcome }: { welcome: boolean }) {
  const ctx = await familyPage();
  const { t, lang } = ctx;
  const today = todayIST();
  const sectionId = ctx.placement?.sectionId ?? null;
  const [attendance, fees, hw, result, notices, remarks, school] = await Promise.all([
    attendanceSummary(ctx.studentId, ctx.sessionId, { to: today }),
    familyFeeSummary(ctx.studentId, ctx.sessionId),
    homeworkDueForFamily(ctx.studentId, sectionId, today, { recentDays: 0, limit: 20 }),
    latestPublishedResult(ctx.studentId, ctx.sessionId),
    activeNoticesForFamily(ctx.studentId, ctx.schoolId, sectionId, today),
    recentRemarksCount({ familyOf: ctx.studentId }, { schoolId: ctx.schoolId, since: addDays(today, -30) }),
    getSchool(ctx.schoolId),
  ]);
  const warn = school?.settings.attendanceWarnPercent ?? 75;
  const p = ctx.placement;
  const classText = p ? (lang === "hi" ? classLabelHi(p.className, p.stream, p.sectionName) : classLabel(p.className, p.stream, p.sectionName)) : null;
  const schoolName = lang === "hi" ? ctx.school.nameHi : ctx.school.name;
  const upcoming = hw.upcoming.slice(0, 4);
  const shownNotices = notices.slice(0, 3);
  // What teachers and the office wrote, in Hindi for families who chose it (only what Home shows: notices' titles, not their text).
  const examNameKnown = result ? examNameHi(result.examName) !== result.examName.trim() : true;
  const say = await familyTexts(lang, [
    ...upcoming.flatMap((h) => [h.title, h.subjectNameHi ? null : h.subjectName]),
    ...shownNotices.map((n) => (n.titleHi?.trim() ? null : n.titleEn)),
    result && !examNameKnown ? result.examName : null,
  ]);
  const examName = result ? (lang !== "hi" ? result.examName : examNameKnown ? examNameHi(result.examName) : (say(result.examName)?.text ?? result.examName)) : "";
  const attended = attendance.present + attendance.late;
  const eyebrow = eyebrowFor(lang);

  return (
    <>
      <PageHeader
        eyebrow={<span className={lang === "hi" ? "text-[0.95rem]" : undefined}>{schoolName}</span>}
        title={ctx.student.name}
        description={
          classText ? (
            <>
              {classText}
              {p?.rollNo ? ` · ${t(`Roll No. ${p.rollNo}`, `रोल नंबर ${p.rollNo}`)}` : ""} · {t(`Session ${ctx.sessionId}`, `सत्र ${ctx.sessionId}`)}
            </>
          ) : (
            t("Not placed in a class for this session yet.", "इस सत्र के लिए अभी किसी कक्षा में नाम दर्ज नहीं।")
          )
        }
      />

      <TranslationSummary say={say} />

      {welcome ? (
        <Alert tone="green" title={t("Welcome! Your account is ready.", "स्वागत है! आपका खाता तैयार है।")} className="mb-6">
          {t(
            "Here you can see your child’s attendance, homework, results, fees and the school’s notices. Keep your password to yourself. If you forget it, the school office can give you a new slip.",
            "यहाँ आप अपने बच्चे की उपस्थिति, गृहकार्य, परिणाम, फ़ीस और विद्यालय की सूचनाएँ देख सकते हैं। अपना पासवर्ड किसी को न बताएँ। भूल जाने पर विद्यालय कार्यालय से नई पर्ची ले सकते हैं।",
          )}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <HomeCard icon={<CalendarCheck2 className="h-5 w-5" aria-hidden />} title={t("Attendance", "उपस्थिति")} href="/my/attendance" linkText={t("See attendance", "उपस्थिति देखें")}>
          <p className={eyebrow}>{t("This session", "इस सत्र में")}</p>
          <p className={`mt-2 font-display text-[2.3rem] leading-none tabular ${attendance.percent !== null && attendance.percent < warn ? "text-clay-600" : "text-forest-800"}`}>
            {formatPercent(attendance.percent)}
          </p>
          <p className="mt-2 text-forest-900">
            {attendance.days
              ? t(`Present on ${attended} of ${attendance.days} school days.`, `${attendance.days} में से ${attended} दिन उपस्थित।`)
              : t("No registers taken yet this session.", "इस सत्र में अभी हाज़िरी दर्ज नहीं हुई।")}
          </p>
          {attendance.absent || attendance.leave ? (
            <p className="text-[0.92rem] text-muted">
              {t(`Absent ${attendance.absent} · on leave ${attendance.leave}`, `अनुपस्थित ${attendance.absent} · अवकाश ${attendance.leave}`)}
            </p>
          ) : null}
        </HomeCard>

        <HomeCard icon={<Wallet className="h-5 w-5" aria-hidden />} title={t("Fees", "फ़ीस")} href="/my/fees" linkText={t("See fees and pay", "फ़ीस देखें और जमा करें")}>
          {fees.waitingCash > 0 ? (
            <p className="mb-3 text-[0.92rem] font-semibold text-ochre-600">
              {t(`${rupees(fees.waitingCash)} you recorded in cash is waiting for the school's approval.`, `आपके दर्ज किए ${rupees(fees.waitingCash)} नकद विद्यालय की स्वीकृति की प्रतीक्षा में हैं।`)}
            </p>
          ) : null}
          {ctx.student.rte ? (
            <p className="text-forest-900">
              <Badge tone="green">{t("RTE seat", "RTE सीट")}</Badge>{" "}
              {t("Your child studies on a seat under the RTE Act. No fees are charged.", "आपका बच्चा RTE अधिनियम की सीट पर पढ़ता है। कोई फ़ीस नहीं ली जाती।")}
            </p>
          ) : fees.dueNow > 0 ? (
            <>
              <p className={eyebrow}>{t("Due now", "अभी देय")}</p>
              <p className={`mt-2 font-display text-[2.3rem] leading-none tabular ${fees.overdue ? "text-clay-600" : "text-forest-900"}`}>{rupees(fees.dueNow)}</p>
              <p className={`mt-2 ${fees.overdue ? "font-semibold text-clay-600" : "text-forest-900"}`}>
                {fees.overdue ? t("The due date has passed. Please pay soon.", "देय तिथि बीत चुकी है। कृपया जल्दी जमा करें।") : t("Due today.", "आज देय है।")}
              </p>
            </>
          ) : fees.nextDue ? (
            <>
              <p className={eyebrow}>{t("Nothing due right now", "अभी कुछ देय नहीं")}</p>
              <p className="mt-2 text-forest-900">
                {t(`Next: ${rupees(fees.nextDue.amount)} by ${formatDate(fees.nextDue.dueOn)}`, `अगली किस्त: ${rupees(fees.nextDue.amount)}, ${formatDate(fees.nextDue.dueOn, "hi")} तक`)}
              </p>
              <p className="text-[0.92rem] text-muted">{lang === "hi" ? fees.nextDue.labelHi : fees.nextDue.label}</p>
            </>
          ) : (
            <p className="text-forest-900">
              {fees.paidThisSession
                ? t("All fees for this session are paid. Thank you.", "इस सत्र की सभी फ़ीस जमा हो गई है। धन्यवाद।")
                : t("No fees to show for this session yet.", "इस सत्र की फ़ीस अभी दिखाने के लिए नहीं है।")}
            </p>
          )}
        </HomeCard>

        <HomeCard icon={<NotebookPen className="h-5 w-5" aria-hidden />} title={t("Homework", "गृहकार्य")} href="/my/homework" linkText={t("All homework", "सारा गृहकार्य")}>
          {upcoming.length ? (
            <ul className="grid gap-3">
              {upcoming.map((h) => (
                <li key={h.id}>
                  <p className="text-[0.88rem] font-semibold text-muted">
                    {lang === "hi" ? (h.subjectNameHi ?? say(h.subjectName)?.text ?? "सामान्य") : (h.subjectName ?? "General")} ·{" "}
                    {h.dueOn === today
                      ? t("due today", "आज जमा करना है")
                      : h.dueOn === addDays(today, 1)
                        ? t("due tomorrow", "कल जमा करना है")
                        : t(`due ${formatDate(h.dueOn)}`, `${formatDate(h.dueOn, "hi")} तक जमा करना है`)}
                  </p>
                  <FamilyText value={say(h.title)} as="p" notes="compact" className="text-forest-900" />
                </li>
              ))}
              {hw.upcoming.length > upcoming.length ? (
                <li className="text-[0.92rem] text-muted">{t(`and ${hw.upcoming.length - upcoming.length} more`, `और ${hw.upcoming.length - upcoming.length} गृहकार्य`)}</li>
              ) : null}
            </ul>
          ) : (
            <p className="text-forest-900">{t("Nothing due right now.", "अभी कुछ जमा नहीं करना है।")}</p>
          )}
        </HomeCard>

        <HomeCard icon={<GraduationCap className="h-5 w-5" aria-hidden />} title={t("Results", "परिणाम")} href="/my/results" linkText={t("See results", "परिणाम देखें")}>
          {result ? (
            <>
              {/* The exam's name as on the Results page and the report card. */}
              <p className={eyebrow}>{t(`Latest: ${examName}`, `नवीनतम: ${examName}`)}</p>
              {result.outcome === "absent" ? (
                <>
                  <p className="mt-2 font-display text-[2.3rem] leading-none text-ochre-600">{t("Absent", "अनुपस्थित")}</p>
                  <p className="mt-2 text-forest-900">{t("Absent in every subject.", "सभी विषयों में अनुपस्थित।")}</p>
                </>
              ) : (
                <>
                  <p className="mt-2 font-display text-[2.3rem] leading-none tabular text-forest-900">{formatPercent(result.percent)}</p>
                  <p className="mt-2 text-forest-900">
                    {result.passedAll ? t("Passed all subjects.", "सभी विषयों में उत्तीर्ण।") : t("See the marks for each subject.", "हर विषय के अंक देखें।")}
                  </p>
                </>
              )}
            </>
          ) : (
            <p className="text-forest-900">{t("No results published yet this session.", "इस सत्र का कोई परिणाम अभी घोषित नहीं हुआ।")}</p>
          )}
        </HomeCard>

        <HomeCard icon={<Megaphone className="h-5 w-5" aria-hidden />} title={t("Notices", "सूचनाएँ")} href="/my/notices" linkText={t("All notices", "सभी सूचनाएँ")}>
          {notices.length ? (
            <ul className="grid gap-3">
              {shownNotices.map((n) => {
                const text = familyNoticeText(n, lang, say);
                return (
                  <li key={n.id}>
                    <p className="text-[0.88rem] text-muted">
                      {formatDate(n.publishOn, lang)} ·{" "}
                      {n.audience === "section" ? t("your child’s class", "आपके बच्चे की कक्षा") : n.audience === "students" ? t("for your child", "आपके बच्चे के लिए") : t("from the school", "विद्यालय की ओर से")}
                    </p>
                    <FamilyText value={text.title} as="p" notes="compact" className="font-semibold text-forest-900" />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-forest-900">{t("No notices right now.", "अभी कोई सूचना नहीं।")}</p>
          )}
        </HomeCard>

        <HomeCard icon={<MessageSquareText className="h-5 w-5" aria-hidden />} title={t("Teacher remarks", "शिक्षक टिप्पणियाँ")} href="/my/remarks" linkText={t("Read remarks", "टिप्पणियाँ पढ़ें")}>
          {remarks.total ? (
            <>
              <p className="text-forest-900">
                {t(
                  `${remarks.total} ${remarks.total === 1 ? "remark" : "remarks"} from teachers in the last 30 days.`,
                  `पिछले 30 दिनों में शिक्षकों की ${remarks.total} ${remarks.total === 1 ? "टिप्पणी" : "टिप्पणियाँ"}।`,
                )}
              </p>
              <p className="text-[0.92rem] text-muted">
                {t(`${remarks.appreciation} appreciation · ${remarks.concern} concern`, `${remarks.appreciation} सराहना · ${remarks.concern} चिंता`)}
              </p>
            </>
          ) : (
            <p className="text-forest-900">{t("No new remarks in the last 30 days.", "पिछले 30 दिनों में कोई नई टिप्पणी नहीं।")}</p>
          )}
        </HomeCard>
      </div>
    </>
  );
}
