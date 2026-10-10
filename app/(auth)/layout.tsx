import Link from "next/link";
import clsx from "clsx";
import { ArrowLeft } from "lucide-react";
import { AesriEmblem, AadharshilaCrest, AryavartCrest } from "@/components/brand/emblems";
import { LanguageSwitch } from "@/components/shell/language-switch";
import { websiteUrl } from "@/lib/env";
import { tr, type Lang } from "@/lib/i18n";
import { getLang } from "@/lib/i18n/server";

/** "← aesrischools.org": the way back to AESRI's public website (WEBSITE_URL). */
function WebsiteLink({ lang, className }: { lang: Lang; className?: string }) {
  const t = tr(lang);
  const href = websiteUrl();
  const host = new URL(href).host.replace(/^www\./, "");
  return (
    <a href={href} className={clsx("min-h-6 items-center gap-1.5 text-[0.88rem] font-semibold text-forest-800 underline-offset-4 hover:underline", className)}>
      <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
      <span className="sr-only">{t("Back to the AESRI website: ", "एईएसआरआई वेबसाइट पर वापस: ")}</span>
      <span>{host}</span>
    </a>
  );
}

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const lang = await getLang();
  const t = tr(lang);
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <aside className="jaali-light relative hidden flex-col justify-between overflow-hidden bg-forest-900 p-12 text-cream-50 lg:flex">
        <div className="flex items-center gap-3">
          <AesriEmblem className="h-11 w-11 text-sage-200" title="" />
          <div>
            <p className="font-display text-xl leading-none">AESRI</p>
            <p className="mt-1 text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-sage-300">{t("Campus Portal", "कैंपस पोर्टल")}</p>
          </div>
        </div>
        <div className="max-w-md">
          <p className="font-display text-[clamp(2.4rem,3.6vw,3.4rem)] leading-[1.05]">
            {t("Attendance, marks, homework and fees — in one place.", "उपस्थिति, अंक, गृहकार्य और फ़ीस — एक ही जगह।")}
          </p>
          <p className="mt-5 text-[1.05rem] leading-relaxed text-sage-200">
            {t(
              "For the families, teachers and staff of Aryavart Public School and Aadharshila Public School.",
              "आर्यवर्त पब्लिक स्कूल और आधारशिला पब्लिक स्कूल के परिवारों, शिक्षकों और स्टाफ़ के लिए।",
            )}
          </p>
        </div>
        <ul className="grid gap-4 text-[0.95rem] text-cream-100">
          <li className="flex items-center gap-3">
            <AryavartCrest className="h-8 w-8 text-ochre-400" title="" />
            <span>
              {t("Aryavart Public School", "आर्यवर्त पब्लिक स्कूल")} <span className="text-sage-300">· {t("Palana", "पलाना")}</span>
            </span>
          </li>
          <li className="flex items-center gap-3">
            <AadharshilaCrest className="h-8 w-8 text-ochre-400" title="" />
            <span>
              {t("Aadharshila Public School", "आधारशिला पब्लिक स्कूल")} <span className="text-sage-300">· {t("Udairamsar", "उदयरामसर")}</span>
            </span>
          </li>
        </ul>
      </aside>

      <div className="flex min-h-dvh flex-col bg-cream-100 px-5 py-5 sm:px-10">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 lg:hidden">
            <AesriEmblem className="h-9 w-9 text-forest-700" title="" />
            <span className="font-display text-lg text-forest-900">{t("AESRI Portal", "एईएसआरआई पोर्टल")}</span>
          </div>
          {/* Large screens: top left, beside the dark panel. Phones: under the privacy line (the top bar has the portal's name). */}
          <WebsiteLink lang={lang} className="hidden lg:inline-flex" />
          <LanguageSwitch lang={lang} />
        </div>
        <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-10 outline-none">
          {children}
        </main>
        <p className="text-center text-[0.8rem] text-muted">
          {t("Private portal of AESRI schools. Please don't share your password with anyone.", "एईएसआरआई विद्यालयों का निजी पोर्टल। अपना पासवर्ड किसी से साझा न करें।")}{" "}
          <Link href="/privacy" className="inline-block min-h-6 font-semibold text-forest-800 underline underline-offset-2">
            {t("Privacy notice", "गोपनीयता सूचना")}
          </Link>
        </p>
        <p className="mt-2 flex justify-center lg:hidden">
          <WebsiteLink lang={lang} className="inline-flex" />
        </p>
      </div>
    </div>
  );
}
