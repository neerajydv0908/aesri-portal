import type { Metadata } from "next";
import { MessageSquareText } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { RemarkKindBadge } from "@/components/daily/badges";
import { formatDate } from "@/lib/dates";
import { getLang } from "@/lib/i18n/server";
import { familyPage } from "@/lib/page";
import { listRemarks, remarkCategoryLabel } from "@/lib/services/remarks";
import { familyTexts } from "@/lib/translate";
import { FamilyText } from "@/components/translate/family-text";
import { TranslatedNote, TranslationSummary } from "@/components/translate/translated-note";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "शिक्षक टिप्पणियाँ" : "Teacher remarks" };
}

export default async function MyRemarksPage() {
  const ctx = await familyPage();
  const { t, lang } = ctx;
  // Only this child's remarks that the teacher chose to show the family.
  const rows = await listRemarks({ familyOf: ctx.studentId }, { schoolId: ctx.schoolId, studentIds: [ctx.studentId], limit: 200 });
  // What the teachers wrote, in Hindi for families who chose it.
  const say = await familyTexts(
    lang,
    rows.flatMap((r) => [r.note, r.actionTaken]),
  );
  const praise = rows.filter((r) => r.kind === "appreciation").length;
  const concerns = rows.length - praise;

  return (
    <>
      <PageHeader
        eyebrow={ctx.student.name}
        title={t("Teacher remarks", "शिक्षक टिप्पणियाँ")}
        description={t(
          "What your child’s teachers have noted — things done well, and anything that needs your attention.",
          "आपके बच्चे के शिक्षकों की टिप्पणियाँ — अच्छे काम की सराहना, और जिन बातों पर आपका ध्यान चाहिए।",
        )}
      />
      <TranslationSummary say={say} />
      {rows.length ? (
        <>
          <p className="mb-4 text-forest-900">
            {t(
              `${praise} ${praise === 1 ? "appreciation" : "appreciations"} and ${concerns} ${concerns === 1 ? "concern" : "concerns"}, newest first.`,
              `सराहना: ${praise} · चिंता: ${concerns} — सबसे नई टिप्पणी सबसे ऊपर है।`,
            )}
          </p>
          <ul className="grid gap-3">
            {rows.map((r) => (
              <li key={r.id}>
                <Card as="article" className={r.kind === "appreciation" ? "border-l-4 border-forest-700 p-5 sm:p-6" : "border-l-4 border-ochre-500 p-5 sm:p-6"}>
                  <div className="flex flex-wrap items-center gap-2">
                    <RemarkKindBadge kind={r.kind} lang={lang} />
                    <span className="text-[0.9rem] font-semibold text-muted">{remarkCategoryLabel(r.category, lang)}</span>
                  </div>
                  <FamilyText value={say(r.note)} as="p" notes={false} className="mt-2 text-[1.02rem] text-forest-900" />
                  {r.actionTaken ? (
                    <p className="mt-2 text-forest-900">
                      <span className="font-semibold">{t("What the school did: ", "विद्यालय ने क्या किया: ")}</span>
                      <FamilyText value={say(r.actionTaken)} notes={false} />
                    </p>
                  ) : null}
                  <TranslatedNote values={[say(r.note), say(r.actionTaken)]} />
                  <p className="mt-3 text-[0.88rem] text-muted">
                    {r.recordedByPerson ? `${r.recordedByPerson.name} · ` : ""}
                    {formatDate(r.recordedOn, lang, { weekday: true })}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-[0.92rem] text-muted">
            {t(
              "If you would like to talk about a remark, please contact the class teacher or the school office.",
              "किसी टिप्पणी पर बात करनी हो तो कृपया कक्षा अध्यापक या विद्यालय कार्यालय से संपर्क करें।",
            )}
            {ctx.school.phone ? ` ${t("Office:", "कार्यालय:")} ${ctx.school.phone}` : ""}
          </p>
        </>
      ) : (
        <EmptyState icon={<MessageSquareText className="h-5 w-5" aria-hidden />} title={t("No remarks yet", "अभी कोई टिप्पणी नहीं")}>
          {t("When a teacher writes a remark about your child, it will appear here.", "जब कोई शिक्षक आपके बच्चे के बारे में टिप्पणी लिखेंगे, वह यहाँ दिखेगी।")}
        </EmptyState>
      )}
    </>
  );
}
