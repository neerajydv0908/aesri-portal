/**
 * The portal's "page not found": for addresses that don't exist, and for
 * records someone may not see (pages call notFound() rather than saying a
 * record exists). In the portal's look, in the reader's language (the same
 * "lang" cookie as the rest of the portal), with the way back home.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { AesriEmblem } from "@/components/brand/emblems";
import { tr } from "@/lib/i18n";
import { getLang } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLang()) === "hi" ? "पृष्ठ नहीं मिला" : "Page not found" };
}

export default async function NotFound() {
  const lang = await getLang();
  const t = tr(lang);
  return (
    <main id="main" tabIndex={-1} className="grid min-h-dvh place-items-center bg-cream-100 px-4 py-10 outline-none">
      <div className="card w-full max-w-lg p-7 text-center sm:p-9">
        <AesriEmblem className="mx-auto h-14 w-14 text-forest-700" title="" />
        <p className={lang === "hi" ? "mt-5 text-[0.95rem] font-semibold text-muted" : "eyebrow mt-5"}>{t("Error 404", "त्रुटि 404")}</p>
        <h1 className="mt-2 text-[clamp(1.8rem,5vw,2.3rem)] text-forest-900">{t("We couldn’t find that page", "यह पृष्ठ नहीं मिला")}</h1>
        <p className="mt-3 text-[1rem] text-forest-900/85">
          {t(
            "The link may be old, or the page may have moved. If you typed the address, please check it.",
            "हो सकता है कि लिंक पुराना हो या पृष्ठ हटा दिया गया हो। अगर आपने पता ख़ुद लिखा है, तो कृपया उसे जाँच लें।",
          )}
        </p>
        <Link
          href="/"
          className="mt-7 inline-flex min-h-12 items-center justify-center rounded-full bg-forest-800 px-6 font-semibold text-cream-50 transition-colors hover:bg-forest-700"
        >
          {t("Go to the home page", "मुख्य पृष्ठ पर जाएँ")}
        </Link>
        {lang === "hi" ? (
          <p lang="en" className="mt-6 text-[0.9rem] text-muted">
            This page could not be found. The button above goes to the home page.
          </p>
        ) : (
          <p lang="hi" className="mt-6 text-[0.9rem] text-muted">
            यह पृष्ठ नहीं मिला। ऊपर का बटन मुख्य पृष्ठ पर ले जाता है।
          </p>
        )}
        <p className="mt-6 border-t border-forest-900/10 pt-4 text-[0.82rem] text-muted">{t("AESRI Campus Portal", "एईएसआरआई कैंपस पोर्टल")}</p>
      </div>
    </main>
  );
}
