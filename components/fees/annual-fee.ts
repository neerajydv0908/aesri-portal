/**
 * One sentence that says what a student's class costs in a year, so a fee
 * group such as "LKG – Class V" never reads like one fee shared by those
 * classes: "Annual fee for Class II: ₹10,000 per year (the same for every
 * class from LKG to Class V), paid in 2 instalments of ₹5,000."
 */
import { classLabel, classLabelHi, ROMAN } from "@/lib/classes";
import type { Lang } from "@/lib/i18n";
import { rupees, type annualFeeFor } from "@/lib/services/fees";

type AnnualFee = NonNullable<ReturnType<typeof annualFeeFor>>;

const ORDER = ["Nursery", "LKG", "UKG", ...ROMAN];

/** "from LKG to Class V" · "एलकेजी से कक्षा 5 तक" (null when the fee is for one class only). */
function classRange(classNames: string[], lang: Lang): string | null {
  if (classNames.length < 2) return null;
  const sorted = [...classNames].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return lang === "hi" ? `${classLabelHi(first)} से ${classLabelHi(last)} तक` : `from ${classLabel(first)} to ${classLabel(last)}`;
}

/**
 * The sentence in English or Hindi. `perStudent` says "per student per year"
 * (office pages); a family's page is about their own child, so "per year".
 */
export function annualFeeSentence(fee: AnnualFee, className: string, stream: string | null, lang: Lang, opts: { perStudent?: boolean } = {}): string {
  const parts = fee.instalments;
  const n = parts.length;
  const equal = n > 1 && parts.every((p) => p === parts[0]);
  const range = classRange(fee.band.classNames, lang);
  if (lang === "hi") {
    const per = opts.perStudent ? "प्रति विद्यार्थी, प्रति वर्ष" : "प्रति वर्ष";
    const same = range ? ` (${range} हर कक्षा के लिए यही फ़ीस)` : "";
    const paid =
      n === 0
        ? ""
        : n === 1
          ? ", जो एक किस्त में जमा होती है"
          : equal
            ? `, जो ${rupees(parts[0])} की ${n} किस्तों में जमा होती है`
            : `, जो ${n} किस्तों में जमा होती है: ${parts.slice(0, -1).map(rupees).join(", ")} और ${rupees(parts[n - 1])}`;
    return `${classLabelHi(className, stream)} की वार्षिक फ़ीस: ${rupees(fee.amount)} ${per}${same}${paid}।`;
  }
  const per = opts.perStudent ? "per student per year" : "per year";
  const same = range ? ` (the same for every class ${range})` : "";
  const paid =
    n === 0
      ? ""
      : n === 1
        ? ", paid in one instalment"
        : equal
          ? `, paid in ${n} instalments of ${rupees(parts[0])}`
          : `, paid in ${n} instalments: ${parts.slice(0, -1).map(rupees).join(", ")} and ${rupees(parts[n - 1])}`;
  return `Annual fee for ${classLabel(className, stream)}: ${rupees(fee.amount)} ${per}${same}${paid}.`;
}
