import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert } from "@/components/ui";
import { getActor } from "@/lib/auth/dal";
import { tr } from "@/lib/i18n";
import { getLang } from "@/lib/i18n/server";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "साइन इन" : "Sign in" };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; signedout?: string; expired?: string }> }) {
  const sp = await searchParams;
  const actor = await getActor();
  if (actor && actor.mfaPassed) redirect("/home");
  const lang = await getLang();
  const t = tr(lang);
  return (
    <div className="rise-in">
      <p className="eyebrow">{t("Campus Portal", "कैंपस पोर्टल")}</p>
      <h1 className="mt-2 text-[2.4rem] text-forest-900">{t("Sign in", "साइन इन करें")}</h1>
      <p className="mt-2 text-muted">
        {t("Use the login ID from your slip, such as Arya7634 or AadharE12.", "अपनी पर्ची वाला लॉगिन आईडी लिखें, जैसे Arya7634 या AadharE12।")}
      </p>
      {sp.signedout ? (
        <Alert tone="green" className="mt-6">
          {t("You have signed out.", "आप साइन आउट हो गए हैं।")}
        </Alert>
      ) : null}
      <LoginForm lang={lang} next={sp.next} />
      <div className="mt-8 grid gap-3 border-t border-forest-900/10 pt-6 text-[0.95rem]">
        <Link href="/activate" className="font-semibold text-forest-800 underline-offset-4 hover:underline">
          {t("First time? Activate your account with the code on your slip →", "पहली बार? अपनी पर्ची के कोड से खाता सक्रिय करें →")}
        </Link>
        <Link href="/forgot" className="text-muted underline-offset-4 hover:text-forest-900 hover:underline">
          {t("Forgot your password?", "पासवर्ड भूल गए?")}
        </Link>
      </div>
    </div>
  );
}
