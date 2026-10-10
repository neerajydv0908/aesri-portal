import clsx from "clsx";
import { setLanguage } from "@/lib/actions/lang";
import type { Lang } from "@/lib/i18n";

/** EN / हिं switch. A plain form, so it works before any JavaScript loads. */
export function LanguageSwitch({ lang, tone = "light" }: { lang: Lang; tone?: "light" | "dark" }) {
  const base = "min-w-11 rounded-full px-3 py-1.5 text-[0.85rem] font-semibold transition-colors";
  const on = tone === "light" ? "bg-forest-800 text-cream-50" : "bg-cream-50 text-forest-900";
  const off = tone === "light" ? "text-forest-900 hover:bg-forest-900/[0.07]" : "text-cream-100 hover:bg-cream-50/10";
  return (
    <form action={setLanguage} className={clsx("inline-flex gap-1 rounded-full p-1", tone === "light" ? "bg-cream-200/80" : "bg-cream-50/10")}>
      <button type="submit" name="lang" value="en" aria-pressed={lang === "en"} className={clsx(base, lang === "en" ? on : off)}>
        EN
      </button>
      <button type="submit" name="lang" value="hi" lang="hi" aria-pressed={lang === "hi"} aria-label="हिंदी" className={clsx(base, lang === "hi" ? on : off)}>
        हिं
      </button>
    </form>
  );
}
