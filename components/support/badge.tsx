/**
 * The "Needs support" colour as a badge: always a word and an icon as well
 * as the colour, so it never depends on seeing colour. Teachers only.
 */
import { CircleCheck, CircleDashed, Eye, LifeBuoy } from "lucide-react";
import { Badge, type Tone } from "@/components/ui";
import { COLOUR_WORDS, type SupportColour } from "@/lib/support/rules";

const TONE: Record<SupportColour, Tone> = { red: "red", amber: "amber", grey: "grey", green: "green" };

export function SupportIcon({ colour, className = "h-3.5 w-3.5 shrink-0" }: { colour: SupportColour; className?: string }) {
  if (colour === "red") return <LifeBuoy className={className} aria-hidden />;
  if (colour === "amber") return <Eye className={className} aria-hidden />;
  if (colour === "grey") return <CircleDashed className={className} aria-hidden />;
  return <CircleCheck className={className} aria-hidden />;
}

export function SupportBadge({ colour, className }: { colour: SupportColour; className?: string }) {
  return (
    <Badge tone={TONE[colour]} className={className}>
      <SupportIcon colour={colour} />
      {COLOUR_WORDS[colour]}
    </Badge>
  );
}

/**
 * One subject's Stud-AI estimate: the risk of not passing the next exam as a
 * percentage. A subject Stud-AI wasn't trained on reads "Not enough data as of
 * now"; a result the colour rule counts as unsure (a name that looks like a
 * covered subject, or an estimate without a percentage) reads "Review needed".
 */
export function EstimatePercent({
  percent,
  knownSubject,
  unsure,
  className,
}: {
  percent: number | null;
  knownSubject: boolean;
  /** The colour rule counts this result as unsure (a "not enough data" name that looks like a covered subject). */
  unsure?: boolean;
  className?: string;
}) {
  const label = unsure ? "Review needed" : !knownSubject ? "Not enough data as of now" : typeof percent === "number" ? `${percent}%` : "Review needed";
  return (
    <span data-testid="studai-estimate" className={className}>
      {label}
    </span>
  );
}
