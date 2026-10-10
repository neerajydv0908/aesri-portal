import type { Tone } from "@/components/ui";
import { addDays, formatDate } from "@/lib/dates";

/** "Due today", "Due tomorrow", "Due 2 Oct 2026" or "Was due 28 Sep 2026", with a badge tone. */
export function dueText(dueOn: string, today: string): { text: string; tone: Tone } {
  if (dueOn === today) return { text: "Due today", tone: "amber" };
  if (dueOn === addDays(today, 1)) return { text: "Due tomorrow", tone: "blue" };
  if (dueOn > today) return { text: `Due ${formatDate(dueOn)}`, tone: "blue" };
  return { text: `Was due ${formatDate(dueOn)}`, tone: "grey" };
}
