import clsx from "clsx";
type SchoolKey = string;

type Props = { className?: string; title?: string; draw?: boolean };

/** Labelled image when a title is given; hidden from assistive tech when decorative. */
function a11y(title?: string) {
  return title ? ({ role: "img", "aria-label": title } as const) : ({ "aria-hidden": true } as const);
}

/**
 * AESRI emblem — a khejri tree (Rajasthan's state tree, symbol of resilience
 * in the Thar) growing from an open book. Placeholder until an official
 * logo is supplied.
 */
export function AesriEmblem({ className, title = "AESRI emblem", draw }: Props) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={clsx(className, draw && "intro__mark")}
      {...a11y(title)}
    >
      <circle cx="32" cy="32" r="29.5" pathLength={1} />
      <path pathLength={1} d="M14.5 28.5C14.5 19 22.4 12.5 32 12.5S49.5 19 49.5 28.5c-3.4-1.9-6.6-2.3-9.4-1.1-2.5-2.7-5.3-3.8-8.1-3.8s-5.6 1.1-8.1 3.8c-2.8-1.2-6-.8-9.4 1.1Z" />
      <path pathLength={1} d="M32 45V27.5" />
      <path pathLength={1} d="M32 37c-2.8-2.1-4.9-4.7-6-8.3" />
      <path pathLength={1} d="M32 33.5c2.4-1.7 4.3-3.9 5.3-7" />
      <path pathLength={1} d="M17.5 45.5c5-2.4 9.8-2.4 14.5 0 4.7-2.4 9.5-2.4 14.5 0v4c-5-2.4-9.8-2.4-14.5 0-4.7-2.4-9.5-2.4-14.5 0v-4Z" />
    </svg>
  );
}

/** Aryavart crest — a sun rising over the dunes, framed by an arch. */
export function AryavartCrest({ className, title = "Aryavart Public School crest" }: Props) {
  return (
    <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} {...a11y(title)}>
      <path d="M13 55V29.5a19 19 0 0 1 38 0V55" />
      <circle cx="32" cy="36" r="6.5" />
      <path d="M32 23.5v3M22.8 27.3l2.1 2.1M41.2 27.3l-2.1 2.1M19.5 36h3M41.5 36h3" />
      <path d="M13 47c5.5-3.6 11.5-3.6 19 0s13.5 3.6 19 0" />
      <path d="M8.5 55h47" />
    </svg>
  );
}

/** Aadharshila crest — foundation stones with a sapling. */
export function AadharshilaCrest({ className, title = "Aadharshila Public School crest" }: Props) {
  return (
    <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} {...a11y(title)}>
      <circle cx="32" cy="32" r="29.5" />
      <rect x="16.5" y="39.5" width="14" height="9" rx="1.5" />
      <rect x="33.5" y="39.5" width="14" height="9" rx="1.5" />
      <rect x="25" y="30.5" width="14" height="9" rx="1.5" />
      <path d="M32 30.5v-9" />
      <path d="M32 25.5c-4.2 0-7.3-3-7.3-7.3 4.2 0 7.3 3.1 7.3 7.3Z" />
      <path d="M32 22.5c3.8 0 6.6-2.8 6.6-6.6-3.8 0-6.6 2.8-6.6 6.6Z" />
    </svg>
  );
}

/** Decorative crest (always shown next to the school's name). */
export function SchoolCrest({ school, className }: { school: SchoolKey; className?: string }) {
  return school === "aryavart" ? <AryavartCrest className={className} title="" /> : <AadharshilaCrest className={className} title="" />;
}
