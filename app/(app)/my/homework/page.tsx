import type { Metadata } from "next";
import { NotebookPen } from "lucide-react";
import { Alert, Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { HomeworkCheckBadge } from "@/components/daily/badges";
import { classLabel, classLabelHi } from "@/lib/classes";
import { addDays, formatDate, todayIST } from "@/lib/dates";
import type { Lang } from "@/lib/i18n";
import { getLang } from "@/lib/i18n/server";
import { familyPage } from "@/lib/page";
import { GENERAL_SUBJECT, homeworkDueForFamily, type FamilyHomework } from "@/lib/services/homework";
import { familyTexts, type FamilyTextLookup } from "@/lib/translate";
import { FamilyText } from "@/components/translate/family-text";
import { TranslatedNote, TranslationSummary } from "@/components/translate/translated-note";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "गृहकार्य" : "Homework" };
}

export default async function MyHomeworkPage() {
  const ctx = await familyPage();
  const { t, lang } = ctx;
  const today = todayIST();
  const p = ctx.placement;
  const { upcoming, recent } = await homeworkDueForFamily(ctx.studentId, p?.sectionId ?? null, today);
  // What the teachers wrote, in Hindi for families who chose it.
  const say = await familyTexts(
    lang,
    [...upcoming, ...recent].flatMap((h) => [h.title, h.details, h.subjectNameHi ? null : h.subjectName]),
  );
  const classText = p ? (lang === "hi" ? classLabelHi(p.className, p.stream, p.sectionName) : classLabel(p.className, p.stream, p.sectionName)) : null;

  return (
    <>
      <PageHeader
        eyebrow={classText ? `${ctx.student.name} · ${classText}` : ctx.student.name}
        title={t("Homework", "गृहकार्य")}
        description={t(
          "Homework set for your child’s class, and whether your child did it once the teacher has checked.",
          "आपके बच्चे की कक्षा को दिया गया गृहकार्य, और शिक्षक के जाँचने के बाद — बच्चे ने उसे किया या नहीं।",
        )}
      />
      <TranslationSummary say={say} />
      {!p ? (
        <Alert tone="blue">
          {t("Your child hasn’t been placed in a class for this session yet.", "इस सत्र के लिए अभी आपके बच्चे को किसी कक्षा में नहीं जोड़ा गया है।")}
        </Alert>
      ) : (
        <>
          <section aria-labelledby="hw-upcoming">
            <h2 id="hw-upcoming" className="mb-3 font-display text-[1.45rem] text-forest-900">
              {t("To do", "करना है")}
            </h2>
            {upcoming.length ? (
              <ul className="grid gap-3">
                {upcoming.map((hw) => (
                  <HomeworkCard key={hw.id} hw={hw} today={today} lang={lang} t={t} say={say} />
                ))}
              </ul>
            ) : (
              <EmptyState icon={<NotebookPen className="h-5 w-5" aria-hidden />} title={t("Nothing due right now", "अभी कुछ जमा नहीं करना है")}>
                {t("New homework from the teachers will appear here.", "शिक्षकों का नया गृहकार्य यहाँ दिखेगा।")}
              </EmptyState>
            )}
          </section>
          <section aria-labelledby="hw-recent" className="mt-10">
            <h2 id="hw-recent" className="mb-1 font-display text-[1.45rem] text-forest-900">
              {t("Recent homework", "हाल का गृहकार्य")}
            </h2>
            <p className="mb-3 text-muted">{t("Due in the last two weeks.", "पिछले दो सप्ताह में जमा होने वाला।")}</p>
            {recent.length ? (
              <ul className="grid gap-3">
                {recent.map((hw) => (
                  <HomeworkCard key={hw.id} hw={hw} today={today} lang={lang} t={t} say={say} />
                ))}
              </ul>
            ) : (
              <p className="text-muted">{t("No homework was due in the last two weeks.", "पिछले दो सप्ताह में कोई गृहकार्य जमा नहीं होना था।")}</p>
            )}
          </section>
        </>
      )}
    </>
  );
}

function HomeworkCard({ hw, today, lang, t, say }: { hw: FamilyHomework; today: string; lang: Lang; t: (en: string, hi: string) => string; say: FamilyTextLookup }) {
  const subject = hw.subjectName ? (lang === "hi" ? (hw.subjectNameHi ?? say(hw.subjectName)?.text ?? hw.subjectName) : hw.subjectName) : GENERAL_SUBJECT[lang];
  const title = say(hw.title);
  const details = say(hw.details);
  const due =
    hw.dueOn === today ? (
      <Badge tone="amber">{t("Due today", "आज जमा करना है")}</Badge>
    ) : hw.dueOn === addDays(today, 1) ? (
      <Badge tone="blue">{t("Due tomorrow", "कल जमा करना है")}</Badge>
    ) : null;
  return (
    <li>
      <Card as="article" className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[0.9rem] font-bold text-forest-700">{subject}</p>
          <HomeworkCheckBadge status={hw.status} lang={lang} />
        </div>
        <FamilyText value={title} as="h3" notes={false} className="mt-1.5 font-sans text-[1.08rem] font-bold tracking-normal text-forest-900" />
        <FamilyText value={details} as="p" notes={false} className="mt-1 text-forest-900" />
        <TranslatedNote values={[title, details]} />
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.9rem] text-muted">
          <span>
            {t("Due:", "जमा करने की तारीख:")} <span className="font-semibold text-forest-900">{formatDate(hw.dueOn, lang, { weekday: true })}</span>
          </span>
          {due}
          <span>{t(`Set on ${formatDate(hw.assignedOn)}`, `${formatDate(hw.assignedOn, "hi")} को दिया गया`)}</span>
        </p>
      </Card>
    </li>
  );
}
