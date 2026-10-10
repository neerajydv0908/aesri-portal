/**
 * Who can do what, in one place.
 *
 *   super_admin   AESRI administrator: both schools, everything
 *   school_admin  School office admin or principal: everything in one school
 *   accounts      Accountant: fees and receipts in one school; can look up students
 *   teacher       Their own classes: attendance, homework, marks, remarks, class notices
 *   student       The family's account for one child: that child's records only
 */
import type { Lang } from "@/lib/i18n";

export type Role = "super_admin" | "school_admin" | "accounts" | "teacher" | "student";

export type StaffAccess = "teacher" | "office_admin" | "principal" | "accounts" | "none";

/** Accounts that can see many people's records sign in with an authenticator app too. */
export const needsTwoFactor = (role: Role) => role === "super_admin" || role === "school_admin" || role === "accounts";

/** Full school-office access. */
export const OFFICE_ROLES: Role[] = ["super_admin", "school_admin"];

/** Fees and receipts. */
export const FEE_ROLES: Role[] = ["super_admin", "school_admin", "accounts"];

/** Can open the office's student list and profiles (read). */
export const STUDENT_LOOKUP_ROLES: Role[] = ["super_admin", "school_admin", "accounts"];

/** The sign-in role that goes with a staff member's portal access (null = no login). */
export function roleForAccess(access: StaffAccess): Exclude<Role, "student" | "super_admin"> | null {
  switch (access) {
    case "teacher":
      return "teacher";
    case "office_admin":
    case "principal":
      return "school_admin";
    case "accounts":
      return "accounts";
    default:
      return null;
  }
}

export const ACCESS_LABELS: Record<StaffAccess, string> = {
  teacher: "Teacher",
  office_admin: "Office admin",
  principal: "Principal",
  accounts: "Accounts",
  none: "No login",
};

export function roleLabel(role: Role, lang: Lang = "en"): string {
  switch (role) {
    case "student":
      return lang === "hi" ? "विद्यार्थी व परिवार" : "Student & family";
    case "teacher":
      return "Teacher";
    case "school_admin":
      return "School office";
    case "accounts":
      return "Accounts";
    default:
      return "AESRI administrator";
  }
}
