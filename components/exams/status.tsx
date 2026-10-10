/**
 * Small, server-safe pieces for exams: result status badges, a subject's
 * outcome (always an icon AND a word, never colour alone) and a progress bar.
 */
import clsx from "clsx";
import { CircleCheck, CircleDashed, Lock, Minus, Send, TriangleAlert, UserX } from "lucide-react";
import { Badge } from "@/components/ui";
import type { OverallOutcome, SubjectOutcome } from "./rules";

export type ResultStatus = "open" | "submitted" | "published";

/** Staff screens: where a section's results stand. */
export function ResultStatusBadge({ status, className }: { status: ResultStatus; className?: string }) {
  if (status === "published") {
    return (
      <Badge tone="green" className={className}>
        <Lock className="h-3.5 w-3.5" aria-hidden />
        Published
      </Badge>
    );
  }
  if (status === "submitted") {
    return (
      <Badge tone="blue" className={className}>
        <Send className="h-3.5 w-3.5" aria-hidden />
        Sent to office
      </Badge>
    );
  }
  return (
    <Badge tone="grey" className={className}>
      <CircleDashed className="h-3.5 w-3.5" aria-hidden />
      Open
    </Badge>
  );
}

const OUTCOME_WORDS: Record<SubjectOutcome, { en: string; hi: string }> = {
  passed: { en: "Passed", hi: "उत्तीर्ण" },
  below: { en: "Below pass mark", hi: "उत्तीर्णांक से कम" },
  absent: { en: "Absent", hi: "अनुपस्थित" },
  missing: { en: "Not entered", hi: "दर्ज नहीं" },
};

export function outcomeWord(outcome: SubjectOutcome, lang: "en" | "hi"): string {
  return OUTCOME_WORDS[outcome][lang];
}

const OUTCOME_ICON = { passed: CircleCheck, below: TriangleAlert, absent: UserX, missing: Minus } as const;
const OUTCOME_TONE: Record<SubjectOutcome, string> = {
  passed: "text-forest-700",
  below: "text-clay-600",
  absent: "text-ochre-600",
  missing: "text-muted",
};

/**
 * A subject's outcome as icon + word. `lang` "both" prints English and Hindi
 * (report cards).
 */
export function OutcomeLabel({ outcome, lang, className }: { outcome: SubjectOutcome; lang: "en" | "hi" | "both"; className?: string }) {
  const Icon = OUTCOME_ICON[outcome];
  const w = OUTCOME_WORDS[outcome];
  return (
    <span className={clsx("inline-flex items-start gap-1.5 font-semibold", OUTCOME_TONE[outcome], className)}>
      <Icon className="mt-[0.2em] h-[1.05em] w-[1.05em] shrink-0" aria-hidden />
      {lang === "both" ? (
        // Report cards: one line when printed or on wider screens; on a phone the Hindi goes on its own line.
        <span>
          {w.en}
          <span className="hidden font-normal text-forest-900/60 sm:inline print:inline"> · </span>
          <span lang="hi" className="block sm:inline print:inline">
            {w.hi}
          </span>
        </span>
      ) : lang === "hi" ? (
        <span lang="hi">{w.hi}</span>
      ) : (
        <span>{w.en}</span>
      )}
    </span>
  );
}

/** "6 of 8" with a thin bar. The bar is decorative; the words carry the meaning. */
export function Progress({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const complete = total > 0 && done >= total;
  return (
    <span className={clsx("inline-flex min-w-[7.5rem] flex-col gap-1", className)}>
      <span className="tabular text-[0.9rem] text-forest-900">
        {complete ? <CircleCheck className="mr-1 inline h-4 w-4 align-[-0.2em] text-forest-700" aria-hidden /> : null}
        {done} of {total}
        {complete ? <span className="sr-only"> (complete)</span> : null}
      </span>
      <span className="h-1.5 w-full overflow-hidden rounded-full bg-cream-300/70" aria-hidden>
        <span className={clsx("block h-full rounded-full", complete ? "bg-forest-600" : "bg-ochre-400")} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* A student's overall result                                          */
/* ------------------------------------------------------------------ */

type OverallInput = {
  outcome: OverallOutcome;
  needsImprovement: { name: string; nameHi: string | null; outcome: SubjectOutcome }[];
};

/** "Passed all subjects" / "Needs improvement in: …" / "Absent in every subject" in English or Hindi. */
export function overallText(r: OverallInput, lang: "en" | "hi"): string {
  switch (r.outcome) {
    case "passed":
      return lang === "hi" ? "सभी विषयों में उत्तीर्ण" : "Passed all subjects";
    case "absent":
      return lang === "hi" ? "सभी विषयों में अनुपस्थित" : "Absent in every subject";
    case "improve": {
      const names = r.needsImprovement
        .map((l) => (lang === "hi" ? `${l.nameHi ?? l.name}${l.outcome === "absent" ? " (अनुपस्थित)" : ""}` : `${l.name}${l.outcome === "absent" ? " (absent)" : ""}`))
        .join(", ");
      return lang === "hi" ? `इन विषयों में सुधार की आवश्यकता: ${names}` : `Needs improvement in: ${names}`;
    }
    case "incomplete":
      return lang === "hi" ? "परिणाम अपूर्ण: कुछ विषयों के अंक अभी दर्ज नहीं हैं" : "Result incomplete: some marks are not entered yet";
    default:
      return lang === "hi" ? "अभी कोई अंक दर्ज नहीं" : "No marks entered yet";
  }
}

export function OverallIcon({ outcome, className }: { outcome: OverallOutcome; className?: string }) {
  const Icon = outcome === "passed" ? CircleCheck : outcome === "improve" ? TriangleAlert : outcome === "absent" ? UserX : Minus;
  return (
    <Icon
      className={clsx(
        outcome === "passed" ? "text-forest-700" : outcome === "improve" ? "text-clay-600" : outcome === "absent" ? "text-ochre-600" : "text-muted",
        className,
      )}
      aria-hidden
    />
  );
}
