import type { Metadata } from "next";
import { Megaphone } from "lucide-react";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatDate, todayIST } from "@/lib/dates";
import { getLang } from "@/lib/i18n/server";
import { familyPage } from "@/lib/page";
import { activeNoticesForFamily, familyNoticeText, noticeCategoryLabel, noticeTextsToTranslate } from "@/lib/services/notices";
import { familyTexts } from "@/lib/translate";
import { FamilyText } from "@/components/translate/family-text";
import { TranslatedNote, TranslationSummary } from "@/components/translate/translated-note";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "सूचनाएँ" : "Notices" };
}

export default async function MyNoticesPage() {
  const ctx = await familyPage();
  const { t, lang } = ctx;
  const today = todayIST();
  const rows = await activeNoticesForFamily(ctx.studentId, ctx.schoolId, ctx.placement?.sectionId ?? null, today);
  // Notices written only in English, in Hindi for families who chose it.
  const say = await familyTexts(lang, noticeTextsToTranslate(rows));
  const schoolName = lang === "hi" ? ctx.school.nameHi : ctx.school.name;

  return (
    <>
      <PageHeader
        eyebrow={schoolName}
        title={t("Notices", "सूचनाएँ")}
        description={t("Notices from the school and from your child’s class teacher.", "विद्यालय और आपके बच्चे के कक्षा अध्यापक की सूचनाएँ।")}
      />
      <TranslationSummary say={say} />
      {rows.length ? (
        <ul className="grid gap-4">
          {rows.map((n) => {
            const text = familyNoticeText(n, lang, say);
            return (
              <li key={n.id}>
                <Card as="article" className="p-5 sm:p-6">
                  <div className="flex flex-wrap items-center gap-2">
                    {n.audience === "section" ? (
                      <Badge tone="green">{t("For your child’s class", "आपके बच्चे की कक्षा के लिए")}</Badge>
                    ) : n.audience === "students" ? (
                      <Badge tone="green">{t("For your child", "आपके बच्चे के लिए")}</Badge>
                    ) : (
                      <Badge tone="blue">{t("From the school", "विद्यालय की ओर से")}</Badge>
                    )}
                    <span className="text-[0.9rem] font-semibold text-muted">{noticeCategoryLabel(n.category, lang)}</span>
                    {n.version > 1 ? <span className="text-[0.85rem] font-semibold text-ochre-600">{t("Updated", "संशोधित")}</span> : null}
                  </div>
                  <FamilyText value={text.title} as="h2" notes={false} className="mt-2 text-[1.3rem] leading-snug text-forest-900" />
                  <FamilyText value={text.body} as="p" notes={false} className="mt-2 text-[1.02rem] text-forest-900" />
                  <TranslatedNote values={[text.title, text.body]} />
                  <p className="mt-3 text-[0.88rem] text-muted">
                    {formatDate(n.publishOn, lang, { weekday: true })}
                    {n.expiresOn ? ` · ${t(`until ${formatDate(n.expiresOn)}`, `${formatDate(n.expiresOn, "hi")} तक`)}` : ""}
                  </p>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState icon={<Megaphone className="h-5 w-5" aria-hidden />} title={t("No notices right now", "अभी कोई सूचना नहीं")}>
          {t("New notices from the school will appear here.", "विद्यालय की नई सूचनाएँ यहाँ दिखेंगी।")}
        </EmptyState>
      )}
    </>
  );
}
