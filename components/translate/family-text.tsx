/**
 * Text written by teachers or the office, as a family reads it: in Hindi
 * when it was translated for them, or as written — with its `lang`, so fonts
 * and screen readers treat it right. See lib/translate.
 *
 * `notes` adds the small line under it (TranslatedNote): "translated
 * automatically · see the original", or "written in English". For items with
 * several texts (a homework's title and details), leave it off and put one
 * <TranslatedNote values={[…]} /> under the item instead. "compact" (short
 * lists that link to the full page, like Home): only a small "(in English)"
 * after text that has no translation — the page's TranslationSummary says
 * the rest.
 */
import clsx from "clsx";
import type { ElementType } from "react";
import type { FamilyTextValue } from "@/lib/translate";
import { TranslatedNote } from "./translated-note";

export function FamilyText({
  value,
  as: As = "span",
  className,
  notes = true,
}: {
  value: FamilyTextValue | null;
  as?: ElementType;
  className?: string;
  notes?: boolean | "compact";
}) {
  if (!value) return null;
  const main = (
    <As lang={value.lang} className={clsx("whitespace-pre-line", className)}>
      {value.text}
      {notes === "compact" && value.untranslated ? (
        <span lang="hi" className="ml-1.5 whitespace-nowrap text-[0.82rem] font-normal text-muted">
          (अंग्रेज़ी में लिखा)
        </span>
      ) : null}
    </As>
  );
  if (!notes || notes === "compact" || (!value.original && !value.untranslated)) return main;
  return (
    <>
      {main}
      <TranslatedNote values={[value]} />
    </>
  );
}
