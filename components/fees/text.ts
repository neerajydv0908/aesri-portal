import type { Lang } from "@/lib/i18n";

/**
 * Small caps labels ("eyebrow") are fine in English, but Devanagari at that
 * size is hard to read: Hindi labels get a larger, plain style instead.
 */
export const eyebrowFor = (lang: Lang) => (lang === "hi" ? "text-[0.92rem] font-semibold text-muted" : "eyebrow");
