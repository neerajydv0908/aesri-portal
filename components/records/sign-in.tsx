/**
 * The "sign-in" box on a student's or staff member's record: their login ID,
 * whether the account is activated, and a link to print a slip.
 */
import type { ReactNode } from "react";
import { KeyRound, Lock, Printer } from "lucide-react";
import { ButtonLink, Card, CardTitle } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import type { SignIn } from "@/lib/queries/records";
import { SignInBadge } from "./badges";

export function SignInCard({
  title,
  signIn,
  slipHref,
  slipNote,
  offNote,
  noAccountNote,
}: {
  title: string;
  signIn: SignIn | null;
  /** Where to print a slip (null: this person may not print slips, or none can be printed). */
  slipHref: string | null;
  /** Why there is no "Print" button, when that needs saying. */
  slipNote?: ReactNode;
  /** Why the account is turned off, and how it comes back. */
  offNote: ReactNode;
  noAccountNote: ReactNode;
}) {
  const lock = signIn?.lock && (!signIn.lock.until || signIn.lock.until > new Date()) ? signIn.lock : null;
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      {signIn ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted" aria-hidden />
              <span className="sr-only">Login ID: </span>
              <span className="font-display text-[1.45rem] leading-none text-forest-900 tabular">{signIn.loginId}</span>
            </p>
            <SignInBadge status={signIn.status} />
          </div>
          <p className="text-[0.92rem] text-muted">
            {signIn.status === "active"
              ? signIn.lastLoginAt
                ? `Last signed in: ${formatDateTime(signIn.lastLoginAt)}.`
                : "Activated, but hasn’t signed in since."
              : signIn.status === "pending"
                ? "Not activated yet: the slip with a one-time code hasn’t been used."
                : offNote}
          </p>
          {lock ? (
            <p className="flex items-start gap-2 text-[0.92rem] text-forest-900">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ochre-600" aria-hidden />
              {lock.reason === "codes"
                ? "Two-step sign-in is locked after 20 wrong codes in a row, until someone unlocks it."
                : lock.reason === "day"
                  ? `Too many wrong passwords today: until ${lock.until ? formatDateTime(lock.until) : "it is unlocked"}, phones and computers that have signed in to this account before can sign in as usual, and others get one try every 10 minutes.`
                  : `Locked after too many wrong tries, until ${lock.until ? formatDateTime(lock.until) : "it is unlocked"}.`}{" "}
              It can be unlocked on Slips &amp; sign-in, or by printing a new slip.
            </p>
          ) : null}
          {slipHref && signIn.status !== "disabled" ? (
            <div className="grid gap-2">
              <ButtonLink href={slipHref} variant="secondary" className="justify-self-start">
                <Printer className="h-4 w-4" aria-hidden />
                {signIn.status === "pending" ? "Print an activation slip" : "Print a new slip"}
              </ButtonLink>
              {signIn.status === "active" ? (
                <p className="text-[0.85rem] text-muted">Only if the password is forgotten: a new slip replaces the old password.</p>
              ) : null}
            </div>
          ) : slipNote && signIn.status !== "disabled" ? (
            <p className="text-[0.88rem] text-muted">{slipNote}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-[0.95rem] text-muted">{noAccountNote}</p>
      )}
    </Card>
  );
}
