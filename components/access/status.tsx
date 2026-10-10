/**
 * A person's sign-in status in words (never colour alone): a badge
 * ("Active", "Not activated", "Turned off"), a line saying what that
 * means right now ("Slip printed 3 Oct, valid until 17 Oct"), and — after
 * too many wrong tries — "Locked after too many wrong tries — until 10:45 pm"
 * (or the daily cap, or two-step sign-in locked until someone unlocks it).
 * Server-safe; other pages can show it next to a student or staff record.
 */
import { Ban, CircleCheck, CircleDashed, Lock } from "lucide-react";
import { Badge } from "@/components/ui";
import { formatDate, todayIST } from "@/lib/dates";
import { needsTwoFactor } from "@/lib/roles";
import type { SignIn } from "@/lib/queries/access";
import type { SignInLock } from "@/lib/auth/throttle";

const ic = "h-3.5 w-3.5 shrink-0";

/** "3 Oct" this year, "3 Oct 2025" otherwise (dates in India). */
export function shortDate(d: Date, now = new Date()): string {
  const iso = todayIST(d);
  const full = formatDate(iso);
  return iso.slice(0, 4) === todayIST(now).slice(0, 4) ? full.replace(/ \d{4}$/, "") : full;
}

/** "28 Sep, 10:15 am" this year. */
export function shortDateTime(d: Date, now = new Date()): string {
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  return `${shortDate(d, now)}, ${time}`;
}

export function SignInBadge({ signIn }: { signIn: SignIn | null }) {
  if (!signIn) {
    return (
      <Badge tone="grey">
        <Ban className={ic} aria-hidden />
        No portal access
      </Badge>
    );
  }
  if (signIn.status === "active") {
    return (
      <Badge tone="green">
        <CircleCheck className={ic} aria-hidden />
        Active
      </Badge>
    );
  }
  if (signIn.status === "pending") {
    return (
      <Badge tone="amber">
        <CircleDashed className={ic} aria-hidden />
        Not activated
      </Badge>
    );
  }
  return (
    <Badge tone="grey">
      <Ban className={ic} aria-hidden />
      Turned off
    </Badge>
  );
}

/** What the status means now, in one short line. */
export function signInDetail(signIn: SignIn | null, opts: { current?: boolean; kind?: "student" | "staff" | "admin"; now?: Date } = {}): string {
  const now = opts.now ?? new Date();
  if (!signIn) return opts.current === false ? "Has left the school" : "Portal access is set to “No login”";
  if (signIn.status === "disabled") {
    if (opts.current === false) return opts.kind === "staff" ? "Has left the school" : "Left the school";
    return opts.kind === "staff" ? "Portal access is off" : "Can’t sign in or use a slip";
  }
  if (signIn.status === "active") {
    const parts = [signIn.lastLoginAt ? `Last signed in ${shortDateTime(signIn.lastLoginAt, now)}` : signIn.passwordChangedAt ? `Activated ${shortDate(signIn.passwordChangedAt, now)}` : "Activated"];
    if (needsTwoFactor(signIn.role)) parts.push(signIn.totpEnabled ? "authenticator app on" : "authenticator app not set up yet");
    return parts.join(" · ");
  }
  const s = signIn.slip;
  if (s.kind === "none") return s.hadSlip ? "No valid slip — print a new one" : "No slip yet";
  if (s.kind === "expired") return `Slip expired ${shortDate(s.expiresAt, now)} — print a new one`;
  return `${s.reset ? "New slip" : "Slip"} printed ${shortDate(s.printedAt, now)}, valid until ${shortDate(s.expiresAt, now)}${s.reset ? " (password reset)" : ""}`;
}

/** "10:45 pm" (India time). */
export function clockTime(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
}

/** What a sign-in lock means, in words (see lib/auth/throttle.ts). */
export function lockWords(lock: SignInLock): string {
  if (lock.reason === "codes") return "Two-step sign-in locked after 20 wrong codes in a row — until someone unlocks it";
  if (lock.reason === "day") return `Too many wrong passwords today: new devices get one try every 10 minutes (devices that signed in before still work) — until ${lock.until ? shortDateTime(lock.until) : "unlocked"}`;
  return `Locked after too many wrong tries — until ${lock.until ? clockTime(lock.until) : "unlocked"}`;
}

/** Shown while a login ID can't be used (or only on known devices) because of too many wrong tries. */
export function LockNote({ lock }: { lock: SignInLock }) {
  return (
    <span className="inline-flex items-start gap-1.5 text-[0.85rem] font-semibold leading-snug text-clay-600">
      <Lock className={`${ic} mt-[0.2em]`} aria-hidden />
      <span>{lockWords(lock)}</span>
    </span>
  );
}

export function SignInStatus({ signIn, current, kind }: { signIn: SignIn | null; current?: boolean; kind?: "student" | "staff" | "admin" }) {
  return (
    <span className="grid justify-items-start gap-1">
      <SignInBadge signIn={signIn} />
      <span className="text-[0.85rem] leading-snug text-muted">{signInDetail(signIn, { current, kind })}</span>
      {signIn?.lock ? <LockNote lock={signIn.lock} /> : null}
    </span>
  );
}
