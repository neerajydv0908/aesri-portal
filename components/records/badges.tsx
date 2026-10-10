/**
 * Status badges for student and staff records: each has a word and an icon
 * as well as a colour, so the status never depends on colour alone.
 */
import { ArrowRightLeft, Ban, BadgeCheck, CheckCircle2, CircleDashed, GraduationCap, LogOut, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui";
import type { SignInStatus, StudentStatus } from "@/lib/queries/records";

const ic = "h-3.5 w-3.5 shrink-0";

export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  active: "Current",
  left: "Left",
  transferred: "Transferred",
  passed_out: "Passed out",
};

export function StudentStatusBadge({ status }: { status: StudentStatus }) {
  switch (status) {
    case "active":
      return (
        <Badge tone="green">
          <UserCheck className={ic} aria-hidden />
          Current
        </Badge>
      );
    case "left":
      return (
        <Badge tone="grey">
          <LogOut className={ic} aria-hidden />
          Left
        </Badge>
      );
    case "transferred":
      return (
        <Badge tone="grey">
          <ArrowRightLeft className={ic} aria-hidden />
          Transferred
        </Badge>
      );
    default:
      return (
        <Badge tone="blue">
          <GraduationCap className={ic} aria-hidden />
          Passed out
        </Badge>
      );
  }
}

export function StaffStatusBadge({ status }: { status: "active" | "left" }) {
  return status === "active" ? (
    <Badge tone="green">
      <UserCheck className={ic} aria-hidden />
      Current
    </Badge>
  ) : (
    <Badge tone="grey">
      <LogOut className={ic} aria-hidden />
      Left
    </Badge>
  );
}

export const SIGN_IN_LABELS: Record<SignInStatus, string> = {
  pending: "Not activated",
  active: "Active",
  disabled: "Turned off",
  none: "No login",
};

/** Where a sign-in account stands: not activated yet, active, or turned off. */
export function SignInBadge({ status }: { status: SignInStatus }) {
  switch (status) {
    case "active":
      return (
        <Badge tone="green">
          <CheckCircle2 className={ic} aria-hidden />
          Active
        </Badge>
      );
    case "pending":
      return (
        <Badge tone="amber">
          <CircleDashed className={ic} aria-hidden />
          Not activated
        </Badge>
      );
    case "disabled":
      return (
        <Badge tone="grey">
          <Ban className={ic} aria-hidden />
          Turned off
        </Badge>
      );
    default:
      return (
        <Badge tone="grey">
          <Ban className={ic} aria-hidden />
          No login
        </Badge>
      );
  }
}

export function RteBadge() {
  return (
    <Badge tone="blue">
      <BadgeCheck className={ic} aria-hidden />
      RTE seat
    </Badge>
  );
}
