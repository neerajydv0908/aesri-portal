import type { Lang } from "@/lib/i18n";
import { tr } from "@/lib/i18n";

export type NavIcon =
  | "home"
  | "attendance"
  | "results"
  | "homework"
  | "fees"
  | "notices"
  | "remarks"
  | "profile"
  | "students"
  | "staff"
  | "classes"
  | "access"
  | "exams"
  | "log"
  | "settings"
  | "schools"
  | "admins"
  | "import"
  | "sms"
  | "reportRemarks"
  | "support";

/** Things waiting for this person, shown on their menu (kept fresh by components/shell/nav-counts.tsx). */
export type NavCounts = { cashToApprove?: number };

/** A count shown on a menu item as a red dot (e.g. cash payments waiting for approval), with words for screen readers. */
export type NavBadge = { count: number; label: string };

/** `count`: which of the NavCounts this item shows as a red dot when it isn't zero. */
export type NavItem = { href: string; label: string; icon: NavIcon; count?: keyof NavCounts };
export type NavGroup = { label?: string; items: NavItem[] };

/** The red dot for one of the counts (none when nothing waits). */
export function navBadge(key: keyof NavCounts, counts: NavCounts): NavBadge | null {
  const n = counts[key] ?? 0;
  if (n <= 0) return null;
  switch (key) {
    case "cashToApprove":
      return { count: n, label: `${n} cash ${n === 1 ? "payment" : "payments"} waiting for approval` };
  }
}

import type { Role } from "@/lib/roles";

/** The menu for a role. */
export function navFor(role: Role, lang: Lang): NavGroup[] {
  const t = tr(lang);
  if (role === "student") {
    return [
      {
        items: [
          { href: "/home", label: t("Home", "मुख्य पृष्ठ"), icon: "home" },
          { href: "/my/attendance", label: t("Attendance", "उपस्थिति"), icon: "attendance" },
          { href: "/my/results", label: t("Results", "परिणाम"), icon: "results" },
          { href: "/my/homework", label: t("Homework", "गृहकार्य"), icon: "homework" },
          { href: "/my/fees", label: t("Fees", "फ़ीस"), icon: "fees" },
          { href: "/my/notices", label: t("Notices", "सूचनाएँ"), icon: "notices" },
          { href: "/my/remarks", label: t("Teacher remarks", "शिक्षक टिप्पणियाँ"), icon: "remarks" },
          { href: "/my/profile", label: t("Profile", "प्रोफ़ाइल"), icon: "profile" },
        ],
      },
    ];
  }
  if (role === "teacher") {
    return [
      {
        items: [
          { href: "/home", label: "Home", icon: "home" },
          { href: "/teach/attendance", label: "Attendance", icon: "attendance" },
          { href: "/teach/homework", label: "Homework", icon: "homework" },
          { href: "/teach/marks", label: "Marks", icon: "exams" },
          { href: "/teach/report-remarks", label: "Report-card remarks", icon: "reportRemarks" },
          { href: "/teach/remarks", label: "Remarks", icon: "remarks" },
          { href: "/teach/notices", label: "Class notices", icon: "notices" },
          { href: "/teach/students", label: "My students", icon: "students" },
          { href: "/teach/support", label: "Needs support", icon: "support" },
        ],
      },
    ];
  }
  if (role === "accounts") {
    return [
      {
        label: "Accounts",
        items: [
          { href: "/home", label: "Home", icon: "home" },
          { href: "/office/fees", label: "Fees", icon: "fees" },
          { href: "/office/students", label: "Students", icon: "students" },
        ],
      },
    ];
  }
  const office: NavGroup = {
    label: "School office",
    items: [
      { href: "/home", label: "Home", icon: "home" },
      { href: "/office/students", label: "Students", icon: "students" },
      { href: "/office/staff", label: "Staff", icon: "staff" },
      { href: "/office/import", label: "Import from Excel", icon: "import" },
      { href: "/office/classes", label: "Classes & subjects", icon: "classes" },
      { href: "/office/access", label: "Slips & sign-in", icon: "access" },
      { href: "/office/attendance", label: "Attendance", icon: "attendance" },
      { href: "/office/exams", label: "Exams & results", icon: "exams" },
      // The red dot: cash payments families recorded, for the principal and office admins to approve (the count is only theirs).
      { href: "/office/fees", label: "Fees", icon: "fees", count: "cashToApprove" },
      { href: "/office/notices", label: "Notices", icon: "notices" },
      { href: "/office/sms", label: "Text messages", icon: "sms" },
      { href: "/office/log", label: "Activity log", icon: "log" },
      { href: "/office/settings", label: "Settings", icon: "settings" },
    ],
  };
  // Principals and office admins can also teach or cover a class.
  const teaching: NavGroup = {
    label: "Teaching",
    items: [
      { href: "/teach/attendance", label: "Take attendance", icon: "attendance" },
      { href: "/teach/homework", label: "Homework", icon: "homework" },
      { href: "/teach/marks", label: "Marks entry", icon: "exams" },
      { href: "/teach/report-remarks", label: "Report-card remarks", icon: "reportRemarks" },
      { href: "/teach/remarks", label: "Remarks", icon: "remarks" },
      { href: "/teach/notices", label: "Class notices", icon: "notices" },
      { href: "/teach/students", label: "Class lists", icon: "students" },
      { href: "/teach/support", label: "Needs support", icon: "support" },
    ],
  };
  if (role === "school_admin") return [office, teaching];
  return [
    {
      label: "AESRI",
      items: [
        { href: "/aesri", label: "Both schools", icon: "schools" },
        { href: "/aesri/admins", label: "Administrators", icon: "admins" },
        { href: "/aesri/sms", label: "Text messages", icon: "sms" },
      ],
    },
    office,
    teaching,
  ];
}
