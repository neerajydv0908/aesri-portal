import type { Metadata } from "next";
import Link from "next/link";
import { tr } from "@/lib/i18n";
import { getLang } from "@/lib/i18n/server";
import { ActivateForm } from "./activate-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "अपना खाता सक्रिय करें" : "Activate your account" };
}

export default async function ActivatePage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const lang = await getLang();
  const t = tr(lang);
  return (
    <div className="rise-in">
      <p className="eyebrow">{t("First time here", "पहली बार")}</p>
      <h1 className="mt-2 text-[2.2rem] text-forest-900">{t("Activate your account", "अपना खाता सक्रिय करें")}</h1>
      <p className="mt-2 text-muted">
        {t(
          "Type the login ID and the one-time code printed on the slip from school, then choose your own password.",
          "विद्यालय से मिली पर्ची पर छपा लॉगिन आईडी और एक-बार वाला कोड लिखें, फिर अपना पासवर्ड चुनें।",
        )}
      </p>
      <ActivateForm lang={lang} loginId={typeof id === "string" ? id.slice(0, 40) : ""} />
      <p className="mt-8 border-t border-forest-900/10 pt-6 text-[0.95rem]">
        <Link href="/login" className="font-semibold text-forest-800 underline-offset-4 hover:underline">
          {t("Already activated? Sign in →", "पहले से सक्रिय? साइन इन करें →")}
        </Link>
      </p>
    </div>
  );
}
