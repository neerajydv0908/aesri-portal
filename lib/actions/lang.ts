"use server";

import { cookies } from "next/headers";
import { LANG_COOKIE, LANG_COOKIE_OPTIONS } from "@/lib/i18n";

/** Remember the reader's language (English or Hindi) for a year. */
export async function setLanguage(formData: FormData): Promise<void> {
  const lang = formData.get("lang") === "hi" ? "hi" : "en";
  (await cookies()).set(LANG_COOKIE, lang, LANG_COOKIE_OPTIONS);
}
