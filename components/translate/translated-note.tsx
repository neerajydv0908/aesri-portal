/**
 * How families learn that text was translated for them: one line at the top
 * of a page (TranslationSummary), and under each translated item a small
 * "see the original in English" (TranslatedNote) — and, for what has no
 * translation yet, that it is in English. Nothing when everything is shown
 * as written.
 */
import clsx from "clsx";
import { Languages } from "lucide-react";
import type { FamilyTextLookup, FamilyTextValue } from "@/lib/translate";

export function TranslatedNote({ values, className }: { values: (FamilyTextValue | null | undefined)[]; className?: string }) {
  const originals = values.filter((v): v is FamilyTextValue & { original: string } => !!v?.original);
  const english = values.some((v) => v?.untranslated);
  if (!originals.length && !english) return null;
  return (
    <div className={clsx("mt-2 grid gap-1 text-[0.85rem] text-muted", className)}>
      {originals.length ? (
        <details className="[&_summary::-webkit-details-marker]:hidden">
          <summary lang="hi" className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1.5 font-semibold text-forest-800 underline-offset-2 hover:underline">
            <Languages className="h-3.5 w-3.5" aria-hidden />
            मूल अंग्रेज़ी में देखें
          </summary>
          {originals.map((v, i) => (
            <span key={i} lang="en" className="mt-1 block whitespace-pre-line text-forest-900">
              {v.original}
            </span>
          ))}
        </details>
      ) : null}
      {english ? (
        <p lang="hi">
          {originals.length
            ? "(इसका कुछ हिस्सा अंग्रेज़ी में लिखा गया है — उसका हिंदी अनुवाद अभी उपलब्ध नहीं है।)"
            : "(यह अंग्रेज़ी में लिखा गया है — इसका हिंदी अनुवाद अभी उपलब्ध नहीं है।)"}
        </p>
      ) : null}
    </div>
  );
}

/** Once per page, when something on it was translated automatically. */
export function TranslationSummary({ say, className }: { say: FamilyTextLookup | FamilyTextLookup[]; className?: string }) {
  if (!(Array.isArray(say) ? say : [say]).some((s) => s.translated)) return null;
  return (
    <p lang="hi" className={clsx("mb-5 flex items-start gap-2 rounded-xl bg-sage-50 px-4 py-3 text-[0.92rem] text-forest-900 ring-1 ring-forest-700/15", className)}>
      <Languages className="mt-0.5 h-4 w-4 shrink-0 text-forest-700" aria-hidden />
      <span>
        शिक्षकों और विद्यालय ने जो अंग्रेज़ी में लिखा, उसका हिंदी अनुवाद कंप्यूटर ने अपने-आप किया है, इसलिए कहीं-कहीं शब्द अलग हो सकते हैं। कोई बात समझ न आए तो कक्षा अध्यापक से पूछें।
      </span>
    </p>
  );
}
