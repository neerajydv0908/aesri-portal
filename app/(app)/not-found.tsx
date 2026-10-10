/**
 * "Not found" inside the signed-in portal: shown in the app shell (which
 * already provides the page's <main>) when a page calls notFound() — for
 * addresses that don't exist and for records this person may not see.
 * Families get it in their chosen language; staff screens are English.
 */
import Link from "next/link";
import { SearchX } from "lucide-react";
import { getActor } from "@/lib/auth/dal";
import { tr, type Lang } from "@/lib/i18n";
import { getLang } from "@/lib/i18n/server";
import { EmptyState, buttonClasses } from "@/components/ui";

export default async function AppNotFound() {
  const actor = await getActor();
  const lang: Lang = actor?.role === "student" ? await getLang() : "en";
  const t = tr(lang);
  return (
    <div className="py-6">
      <EmptyState
        icon={<SearchX className="h-6 w-6" aria-hidden />}
        title={<span role="heading" aria-level={1}>{t("We couldn’t find that page", "यह पृष्ठ नहीं मिला")}</span>}
        action={
          <Link href="/home" className={buttonClasses("primary", "md")}>
            {t("Go to the home page", "मुख्य पृष्ठ पर जाएँ")}
          </Link>
        }
      >
        {t(
          "The link may be old, or the record may not be one you can open. If you typed the address, please check it.",
          "हो सकता है कि लिंक पुराना हो, या यह जानकारी आपके खाते में न खुलती हो। अगर आपने पता ख़ुद लिखा है, तो कृपया उसे जाँच लें।",
        )}
      </EmptyState>
    </div>
  );
}
