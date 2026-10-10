import type { Metadata } from "next";
import Link from "next/link";
import { Phone } from "lucide-react";
import { getDb } from "@/lib/db/client";
import { schools } from "@/lib/db/schema";
import { placeIn, tr } from "@/lib/i18n";
import { getLang } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "पासवर्ड भूल गए" : "Forgot password" };
}

export default async function ForgotPage() {
  const lang = await getLang();
  const t = tr(lang);
  const db = await getDb();
  const list = await db.select().from(schools).orderBy(schools.id);
  return (
    <div className="rise-in">
      <p className="eyebrow">{t("Help", "सहायता")}</p>
      <h1 className="mt-2 text-[2.2rem] text-forest-900">{t("Forgot your password?", "पासवर्ड भूल गए?")}</h1>
      <p className="mt-3 text-[1.02rem] text-forest-900/85">
        {t(
          "Contact your school office. After checking who you are, the office prints a new slip with a new one-time code. Your old password stops working, and you choose a new one with the code.",
          "अपने विद्यालय कार्यालय से संपर्क करें। आपकी पहचान जाँचने के बाद कार्यालय नए एक-बार वाले कोड के साथ नई पर्ची देगा। पुराना पासवर्ड काम करना बंद कर देगा और आप कोड से नया पासवर्ड चुनेंगे।",
        )}
      </p>
      <ul className="mt-7 grid gap-3">
        {list.map((s) => (
          <li key={s.id} className="card flex items-center justify-between gap-4 p-5">
            <div>
              <p className="font-semibold text-forest-900">{lang === "hi" ? s.nameHi : s.name}</p>
              <p className="text-[0.9rem] text-muted">{placeIn(s.place, lang)}</p>
            </div>
            {s.phone ? (
              <a href={`tel:${s.phone.replace(/\s/g, "")}`} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-forest-800 px-4 text-[0.92rem] font-semibold text-cream-50 hover:bg-forest-700">
                <Phone className="h-4 w-4" aria-hidden />
                {s.phone}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-6 text-[0.92rem] text-muted">
        {t("Office hours: working days during school office hours.", "कार्यालय समय: कार्यदिवसों में विद्यालय कार्यालय समय।")}
      </p>
      <p className="mt-8 border-t border-forest-900/10 pt-6 text-[0.95rem]">
        <Link href="/login" className="font-semibold text-forest-800 underline-offset-4 hover:underline">
          ← {t("Back to sign in", "साइन इन पर वापस")}
        </Link>
      </p>
    </div>
  );
}
