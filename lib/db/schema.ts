/**
 * AESRI Campus Portal — database schema (PostgreSQL, via Drizzle ORM).
 *
 * Every school-owned row carries a `schoolId`, and every query in the app is
 * filtered by the signed-in person's school (see lib/auth/dal.ts). Money is
 * stored in paise (integers), dates as YYYY-MM-DD strings.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

export const roleEnum = pgEnum("role", ["super_admin", "school_admin", "accounts", "teacher", "student"]);
export const accountStatusEnum = pgEnum("account_status", ["pending", "active", "disabled"]);
export const codePurposeEnum = pgEnum("code_purpose", ["activation", "reset"]);
export const studentStatusEnum = pgEnum("student_status", ["active", "left", "transferred", "passed_out"]);
export const staffStatusEnum = pgEnum("staff_status", ["active", "left"]);
/** What a staff member may do in the portal (the "Portal access" column of the Excel template). */
export const staffAccessEnum = pgEnum("staff_access", ["teacher", "office_admin", "principal", "accounts", "none"]);
export const attendanceStatusEnum = pgEnum("attendance_status", ["present", "absent", "late", "leave"]);
export const homeworkCheckEnum = pgEnum("homework_check", ["done", "late", "not_done", "excused"]);
export const remarkKindEnum = pgEnum("remark_kind", ["appreciation", "concern"]);
/** "students": chosen students of one section (their families only). */
export const noticeAudienceEnum = pgEnum("notice_audience", ["school", "staff", "section", "students"]);
export const noticeStatusEnum = pgEnum("notice_status", ["draft", "pending", "published", "archived"]);
export const resultStatusEnum = pgEnum("result_status", ["open", "submitted", "published"]);
export const chargeKindEnum = pgEnum("charge_kind", ["instalment", "admission", "other"]);
export const paymentMethodEnum = pgEnum("payment_method", ["cash", "cheque", "bank", "online", "opening"]);
export const paymentStatusEnum = pgEnum("payment_status", ["completed", "reversed"]);
export const orderStatusEnum = pgEnum("order_status", ["created", "paid", "failed", "expired"]);
export const refundMethodEnum = pgEnum("refund_method", ["online", "cash", "cheque", "bank"]);
/** A cash payment a family recorded on the portal: waiting, or what the school decided (or withdrawn by the family). */
export const cashClaimStatusEnum = pgEnum("cash_claim_status", ["pending", "approved", "declined", "withdrawn"]);
export const smsStatusEnum = pgEnum("sms_status", ["queued", "sent", "failed", "cancelled", "skipped"]);

/* ------------------------------------------------------------------ */
/* Schools, sessions, classes                                          */
/* ------------------------------------------------------------------ */

export type SchoolSettings = {
  /** Minimum percentage to pass a subject in school exams. */
  passPercent: number;
  /** Attendance below this percentage is highlighted. */
  attendanceWarnPercent: number;
  /** Text messages to families and staff (missing = the defaults in lib/sms/settings.ts). */
  sms?: SchoolSmsSettings;
  /** The "Needs support" colour rule for teachers (missing = the defaults in lib/support/rules.ts). */
  support?: SupportRuleSettings;
};

/**
 * When a student shows red in the teachers' "Needs support" view: a Stud-AI
 * estimate of 50% or more in any subject, or attendance below
 * attendanceRedPercent% together with concernsRed or more concerns in the
 * last concernDays days.
 */
export type SupportRuleSettings = {
  attendanceRedPercent: number;
  concernsRed: number;
  concernDays: number;
};

/** Things that can send a text message (SMS). */
export type SmsEvent =
  | "attendance_absent"
  | "attendance_late"
  | "attendance_leave"
  | "attendance_present"
  | "remark"
  | "notice_school"
  | "notice_class"
  | "notice_students"
  | "notice_staff"
  | "homework_digest"
  | "results"
  | "payment"
  | "cash_declined";

export type SchoolSmsSettings = {
  /** Master switch for this school. */
  enabled: boolean;
  /** Which events send a message (missing = default for that event). */
  events: Partial<Record<SmsEvent, boolean>>;
  /** Language of messages to families. */
  lang: "hi" | "en";
  /** Also send family messages to the second mobile on record. */
  alsoSecondMobile: boolean;
  /** When the day's homework summary goes out (IST, "HH:MM"). */
  homeworkDigestAt: string;
  /** No messages between these times (IST, "HH:MM"); they wait until the end of the quiet time. Null = none. */
  quietHours: { from: string; to: string } | null;
};

export const schools = pgTable("schools", {
  id: text("id").primaryKey(), // "aryavart" | "aadharshila"
  code: text("code").notNull(), // used in receipt numbers: ARY, AAD
  loginPrefix: text("login_prefix").notNull(), // "Arya" | "Aadhar"
  name: text("name").notNull(),
  nameHi: text("name_hi").notNull(),
  place: text("place").notNull(),
  phone: text("phone"),
  email: text("email"),
  settings: jsonb("settings").$type<SchoolSettings>().notNull(),
});

export const academicSessions = pgTable("academic_sessions", {
  id: text("id").primaryKey(), // "2026-27"
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  isCurrent: boolean("is_current").notNull().default(false),
});

export const classes = pgTable(
  "classes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    name: text("name").notNull(), // "LKG", "I" … "XII"
    stream: text("stream"), // "Arts" for XI–XII at Aryavart
    sortOrder: integer("sort_order").notNull(),
  },
  (t) => [uniqueIndex("classes_school_name").on(t.schoolId, t.name)],
);

export const staff = pgTable(
  "staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    empNo: text("emp_no").notNull(),
    name: text("name").notNull(),
    designation: text("designation"),
    access: staffAccessEnum("access").notNull().default("teacher"),
    mobile: text("mobile"),
    email: text("email"),
    joinedOn: date("joined_on"),
    status: staffStatusEnum("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("staff_school_emp").on(t.schoolId, t.empNo)],
);

export const sections = pgTable(
  "sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classId: uuid("class_id").notNull().references(() => classes.id),
    sessionId: text("session_id").notNull().references(() => academicSessions.id),
    name: text("name").notNull(), // "A"
    classTeacherId: uuid("class_teacher_id").references(() => staff.id),
  },
  (t) => [uniqueIndex("sections_class_session_name").on(t.classId, t.sessionId, t.name)],
);

export const subjects = pgTable(
  "subjects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    name: text("name").notNull(),
    nameHi: text("name_hi"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("subjects_school_name").on(t.schoolId, t.name)],
);

/** Which subjects are taught in a class. */
export const classSubjects = pgTable(
  "class_subjects",
  {
    classId: uuid("class_id").notNull().references(() => classes.id),
    subjectId: uuid("subject_id").notNull().references(() => subjects.id),
  },
  (t) => [primaryKey({ columns: [t.classId, t.subjectId] })],
);

/** Who teaches which subject in which section. */
export const teachingAssignments = pgTable(
  "teaching_assignments",
  {
    sectionId: uuid("section_id").notNull().references(() => sections.id),
    subjectId: uuid("subject_id").notNull().references(() => subjects.id),
    staffId: uuid("staff_id").notNull().references(() => staff.id),
  },
  (t) => [primaryKey({ columns: [t.sectionId, t.subjectId] }), index("teaching_staff").on(t.staffId)],
);

/** Subjects a staff member teaches (from the Excel sheet or their record). Used to suggest teachers on the Classes page. */
export const staffSubjects = pgTable(
  "staff_subjects",
  {
    staffId: uuid("staff_id").notNull().references(() => staff.id),
    subjectId: uuid("subject_id").notNull().references(() => subjects.id),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.subjectId] })],
);

/* ------------------------------------------------------------------ */
/* Students                                                            */
/* ------------------------------------------------------------------ */

export const students = pgTable(
  "students",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    srNo: text("sr_no").notNull(),
    name: text("name").notNull(),
    dob: date("dob"),
    gender: text("gender"), // "M" | "F" | "O"
    admittedOn: date("admitted_on"),
    fatherName: text("father_name"),
    motherName: text("mother_name"),
    /** A guardian who is not a parent (optional). */
    guardianName: text("guardian_name"),
    /** The parent's mobile: the family's contact number on record. */
    guardianMobile: text("guardian_mobile"),
    mobile2: text("mobile2"),
    address: text("address"),
    /** Admitted to a seat reserved under the RTE Act: no fees are charged. */
    rte: boolean("rte").notNull().default(false),
    /** The family asked not to get text messages (SMS). */
    smsOff: boolean("sms_off").notNull().default(false),
    status: studentStatusEnum("status").notNull().default("active"),
    leftOn: date("left_on"),
    /** Links the same child's records at both schools (e.g. Aadharshila → Aryavart for Class XI). */
    personKey: uuid("person_key").notNull().defaultRandom(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("students_school_sr").on(t.schoolId, t.srNo), index("students_person").on(t.personKey)],
);

export const enrolments = pgTable(
  "enrolments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id").notNull().references(() => students.id),
    sessionId: text("session_id").notNull().references(() => academicSessions.id),
    sectionId: uuid("section_id").notNull().references(() => sections.id),
    rollNo: integer("roll_no"),
  },
  (t) => [uniqueIndex("enrolments_student_session").on(t.studentId, t.sessionId), index("enrolments_section").on(t.sectionId)],
);

/* ------------------------------------------------------------------ */
/* Accounts and sign-in                                                */
/* ------------------------------------------------------------------ */

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Normalised login ID: lower case, no leading zeros ("arya7634", "aryae12"). */
    loginId: text("login_id").notNull(),
    role: roleEnum("role").notNull(),
    schoolId: text("school_id").references(() => schools.id),
    studentId: uuid("student_id").references(() => students.id),
    staffId: uuid("staff_id").references(() => staff.id),
    /** Only for accounts without a student/staff record (AESRI admins). */
    displayName: text("display_name"),
    passwordHash: text("password_hash"),
    status: accountStatusEnum("status").notNull().default("pending"),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: ts("locked_until"),
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    /** Last accepted authenticator time-step, so a code can't be used twice. */
    totpLastStep: integer("totp_last_step"),
    privacyAcceptedAt: ts("privacy_accepted_at"),
    passwordChangedAt: ts("password_changed_at"),
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("accounts_login_id").on(t.loginId),
    uniqueIndex("accounts_student").on(t.studentId),
    uniqueIndex("accounts_staff").on(t.staffId),
  ],
);

/** One-time codes printed on activation / reset slips. Only a keyed hash is stored. */
export const oneTimeCodes = pgTable(
  "one_time_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    codeHash: text("code_hash").notNull(),
    purpose: codePurposeEnum("purpose").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    revokedAt: ts("revoked_at"),
    createdBy: uuid("created_by").references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [index("codes_account").on(t.accountId)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    /** SHA-256 of the random token held in the browser cookie. */
    id: text("id").primaryKey(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    mfaPassed: boolean("mfa_passed").notNull().default(false),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_account").on(t.accountId)],
);

/**
 * Browsers an administrator trusted after a right authenticator code ("Trust
 * this browser for 30 days"): signing in there asks for the password only
 * (lib/auth/trusted.ts). The browser holds a random token in a cookie; only
 * its SHA-256 is kept here.
 */
export const trustedBrowsers = pgTable(
  "trusted_browsers",
  {
    /** SHA-256 of the random token held in the browser cookie. */
    id: text("id").primaryKey(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    /** Keyed fingerprint of the authenticator key it was trusted with: setting the app up again leaves it stale. */
    totpTag: text("totp_tag").notNull(),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    lastUsedAt: ts("last_used_at"),
    /** A short name for the list ("Chrome on Windows"), not the browser's full user-agent text. */
    browser: text("browser").notNull(),
  },
  (t) => [index("trusted_browsers_account").on(t.accountId)],
);

/** Counters for rate limiting (per IP address). */
export const throttles = pgTable("throttles", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: ts("window_start").notNull(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: ts("at").notNull().defaultNow(),
    actorId: uuid("actor_id"),
    actorLogin: text("actor_login"),
    schoolId: text("school_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    ip: text("ip"),
  },
  (t) => [index("audit_school_at").on(t.schoolId, t.at)],
);

/* ------------------------------------------------------------------ */
/* Attendance                                                          */
/* ------------------------------------------------------------------ */

/** A register taken for a section on a day (so "not yet marked" is visible). */
export const attendanceRegisters = pgTable(
  "attendance_registers",
  {
    sectionId: uuid("section_id").notNull().references(() => sections.id),
    date: date("date").notNull(),
    takenBy: uuid("taken_by").notNull().references(() => accounts.id),
    takenAt: ts("taken_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sectionId, t.date] })],
);

export const attendance = pgTable(
  "attendance",
  {
    studentId: uuid("student_id").notNull().references(() => students.id),
    date: date("date").notNull(),
    sectionId: uuid("section_id").notNull().references(() => sections.id),
    status: attendanceStatusEnum("status").notNull(),
    markedBy: uuid("marked_by").notNull().references(() => accounts.id),
    markedAt: ts("marked_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.studentId, t.date] }), index("attendance_section_date").on(t.sectionId, t.date)],
);

/* ------------------------------------------------------------------ */
/* Homework, remarks, notices                                          */
/* ------------------------------------------------------------------ */

export const homework = pgTable(
  "homework",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sectionId: uuid("section_id").notNull().references(() => sections.id),
    subjectId: uuid("subject_id").references(() => subjects.id),
    title: text("title").notNull(),
    details: text("details"),
    assignedOn: date("assigned_on").notNull(),
    dueOn: date("due_on").notNull(),
    createdBy: uuid("created_by").notNull().references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [index("homework_section_due").on(t.sectionId, t.dueOn)],
);

export const homeworkChecks = pgTable(
  "homework_checks",
  {
    homeworkId: uuid("homework_id").notNull().references(() => homework.id),
    studentId: uuid("student_id").notNull().references(() => students.id),
    status: homeworkCheckEnum("status").notNull(),
    checkedBy: uuid("checked_by").notNull().references(() => accounts.id),
    checkedAt: ts("checked_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.homeworkId, t.studentId] }), index("homework_checks_student").on(t.studentId)],
);

/** Teachers' remarks about a student — appreciation as well as concerns. */
export const remarks = pgTable(
  "remarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    studentId: uuid("student_id").notNull().references(() => students.id),
    kind: remarkKindEnum("kind").notNull(),
    category: text("category").notNull(),
    note: text("note").notNull(),
    actionTaken: text("action_taken"),
    recordedOn: date("recorded_on").notNull(),
    recordedBy: uuid("recorded_by").notNull().references(() => accounts.id),
    visibleToGuardian: boolean("visible_to_guardian").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("remarks_student").on(t.studentId)],
);

export const notices = pgTable(
  "notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    audience: noticeAudienceEnum("audience").notNull(),
    sectionId: uuid("section_id").references(() => sections.id),
    category: text("category").notNull(),
    titleEn: text("title_en").notNull(),
    titleHi: text("title_hi"),
    bodyEn: text("body_en").notNull(),
    bodyHi: text("body_hi"),
    status: noticeStatusEnum("status").notNull().default("draft"),
    publishOn: date("publish_on").notNull(),
    expiresOn: date("expires_on"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").notNull().references(() => accounts.id),
    approvedBy: uuid("approved_by").references(() => accounts.id),
    approvedAt: ts("approved_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("notices_school_status").on(t.schoolId, t.status)],
);

/** For notices with audience "students": the students whose families get it. */
export const noticeRecipients = pgTable(
  "notice_recipients",
  {
    noticeId: uuid("notice_id").notNull().references(() => notices.id),
    studentId: uuid("student_id").notNull().references(() => students.id),
  },
  (t) => [primaryKey({ columns: [t.noticeId, t.studentId] }), index("notice_recipients_student").on(t.studentId)],
);

/* ------------------------------------------------------------------ */
/* Exams and marks                                                     */
/* ------------------------------------------------------------------ */

export const exams = pgTable("exams", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: text("school_id").notNull().references(() => schools.id),
  sessionId: text("session_id").notNull().references(() => academicSessions.id),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

/** Maximum marks for a subject in a class, for one exam. */
export const examPapers = pgTable(
  "exam_papers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    examId: uuid("exam_id").notNull().references(() => exams.id),
    classId: uuid("class_id").notNull().references(() => classes.id),
    subjectId: uuid("subject_id").notNull().references(() => subjects.id),
    maxMarks: integer("max_marks").notNull(),
  },
  (t) => [uniqueIndex("exam_papers_unique").on(t.examId, t.classId, t.subjectId)],
);

export const marks = pgTable(
  "marks",
  {
    examId: uuid("exam_id").notNull().references(() => exams.id),
    studentId: uuid("student_id").notNull().references(() => students.id),
    subjectId: uuid("subject_id").notNull().references(() => subjects.id),
    marks: numeric("marks", { precision: 5, scale: 1 }),
    absent: boolean("absent").notNull().default(false),
    enteredBy: uuid("entered_by").notNull().references(() => accounts.id),
    enteredAt: ts("entered_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.examId, t.studentId, t.subjectId] })],
);

/** Result status per exam and section: teachers submit, the school publishes (then it's locked). */
export const examResults = pgTable(
  "exam_results",
  {
    examId: uuid("exam_id").notNull().references(() => exams.id),
    sectionId: uuid("section_id").notNull().references(() => sections.id),
    status: resultStatusEnum("status").notNull().default("open"),
    publishedBy: uuid("published_by").references(() => accounts.id),
    publishedAt: ts("published_at"),
  },
  (t) => [primaryKey({ columns: [t.examId, t.sectionId] })],
);

/** The class teacher's remark on a student's report card for one exam, written by the teacher. */
export const reportRemarks = pgTable(
  "report_remarks",
  {
    examId: uuid("exam_id").notNull().references(() => exams.id),
    studentId: uuid("student_id").notNull().references(() => students.id),
    remark: text("remark").notNull(),
    updatedBy: uuid("updated_by").notNull().references(() => accounts.id),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.examId, t.studentId] })],
);

/* ------------------------------------------------------------------ */
/* Stud-AI estimates (teachers only)                                   */
/* ------------------------------------------------------------------ */

/**
 * Stud-AI's latest estimate of a student's risk of not passing the next
 * exam in a subject, this session. Worked out again on the school's own
 * server whenever the student's marks, homework or attendance change, or
 * the model is retrained (lib/studai/estimates.ts). Shown to the class
 * teacher and admins only, never to families or students. Rows of earlier
 * sessions are deleted.
 */
export const riskEstimates = pgTable(
  "risk_estimates",
  {
    sessionId: text("session_id").notNull().references(() => academicSessions.id),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    /** The estimated risk of not passing, 1–99 (%); null for a subject Stud-AI wasn't trained on ("Not enough data as of now"). */
    percent: integer("percent"),
    /** Stud-AI's sentence: "Estimated risk of not passing the next mathematics examination: 62%". */
    text: text("text").notNull(),
    /** The main reasons, in words. */
    reasons: jsonb("reasons").$type<EstimateReasonRow[]>().notNull(),
    /** Inputs Stud-AI didn't have, so it used a typical value instead. */
    assumed: jsonb("assumed").$type<string[]>().notNull(),
    /** False: Stud-AI wasn't trained on this subject, so there is no estimate. */
    knownSubject: boolean("known_subject").notNull(),
    testsUsed: integer("tests_used").notNull(),
    computedAt: ts("computed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.studentId, t.subjectId] })],
);

/** One of the main reasons behind a Stud-AI estimate, in words (lib/studai/contract.ts). */
export type EstimateReasonRow = { key: string; words: string; value: string; effect: "raises" | "lowers"; sentence: string };

/**
 * For each student, a fingerprint of the records and model behind their
 * current estimates: when it no longer matches, they are worked out again.
 */
export const riskChecks = pgTable(
  "risk_checks",
  {
    sessionId: text("session_id").notNull().references(() => academicSessions.id),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    modelVersion: text("model_version"),
    checkedAt: ts("checked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.studentId] })],
);

/* ------------------------------------------------------------------ */
/* Fees and payments                                                   */
/* ------------------------------------------------------------------ */

/** A fee plan mirrors one approved version of the school's public fee schedule. */
export const feePlans = pgTable(
  "fee_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    version: integer("version").notNull(),
    approvalRef: text("approval_ref"),
    appliesFrom: text("applies_from").notNull(), // session id, e.g. "2026-27"
    isCurrent: boolean("is_current").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("fee_plans_school_version").on(t.schoolId, t.version)],
);

export const feeBands = pgTable("fee_bands", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").notNull().references(() => feePlans.id),
  label: text("label").notNull(),
  labelHi: text("label_hi").notNull(),
  classNames: text("class_names").array().notNull(),
  annualAmount: integer("annual_amount").notNull(), // paise
  sortOrder: integer("sort_order").notNull(),
});

export const feeInstalments = pgTable("fee_instalments", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").notNull().references(() => feePlans.id),
  label: text("label").notNull(),
  labelHi: text("label_hi").notNull(),
  dueMonthDay: text("due_month_day").notNull(), // "04-10"
  percent: integer("percent").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

/** One-time charges that apply to every class (the admission fee). */
export const feeOneTime = pgTable("fee_one_time", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").notNull().references(() => feePlans.id),
  key: text("key").notNull(), // "admission"
  label: text("label").notNull(),
  labelHi: text("label_hi").notNull(),
  amount: integer("amount").notNull(),
  refundable: boolean("refundable").notNull(),
});

/** What a student owes (the ledger's debit side). */
export const studentCharges = pgTable(
  "student_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    studentId: uuid("student_id").notNull().references(() => students.id),
    sessionId: text("session_id").notNull().references(() => academicSessions.id),
    planId: uuid("plan_id").references(() => feePlans.id),
    kind: chargeKindEnum("kind").notNull(),
    label: text("label").notNull(),
    labelHi: text("label_hi").notNull(),
    amount: integer("amount").notNull(),
    dueOn: date("due_on").notNull(),
    waived: boolean("waived").notNull().default(false),
    waiverNote: text("waiver_note"),
    createdBy: uuid("created_by").references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [index("charges_student").on(t.studentId, t.sessionId)],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    studentId: uuid("student_id").notNull().references(() => students.id),
    sessionId: text("session_id").notNull().references(() => academicSessions.id),
    amount: integer("amount").notNull(),
    method: paymentMethodEnum("method").notNull(),
    reference: text("reference"),
    paidOn: date("paid_on").notNull(),
    receiptNo: text("receipt_no").notNull(),
    status: paymentStatusEnum("status").notNull().default("completed"),
    reversalNote: text("reversal_note"),
    recordedBy: uuid("recorded_by").references(() => accounts.id),
    provider: text("provider"),
    providerPaymentId: text("provider_payment_id"),
    orderId: uuid("order_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("payments_receipt").on(t.schoolId, t.receiptNo),
    uniqueIndex("payments_provider_payment").on(t.providerPaymentId),
    uniqueIndex("payments_order").on(t.orderId),
    index("payments_student").on(t.studentId),
  ],
);

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    paymentId: uuid("payment_id").notNull().references(() => payments.id),
    chargeId: uuid("charge_id").notNull().references(() => studentCharges.id),
    amount: integer("amount").notNull(),
  },
  (t) => [primaryKey({ columns: [t.paymentId, t.chargeId] })],
);

/**
 * Money given back on a payment: online through the payment gateway (checked
 * with the gateway; each gateway refund once), or by the school office for a
 * payment taken at the counter. The payment's receipt stays as it was; each
 * refund has its own voucher number from a per-school, per-session counter.
 * An office refund entered by mistake is cancelled ("reversed"), never deleted.
 */
export const paymentRefunds = pgTable(
  "payment_refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    paymentId: uuid("payment_id").notNull().references(() => payments.id),
    studentId: uuid("student_id").notNull().references(() => students.id),
    sessionId: text("session_id").notNull().references(() => academicSessions.id),
    voucherNo: text("voucher_no").notNull(),
    amount: integer("amount").notNull(), // paise
    refundedOn: date("refunded_on").notNull(),
    method: refundMethodEnum("method").notNull(),
    reference: text("reference"),
    note: text("note").notNull(),
    provider: text("provider"),
    providerRefundId: text("provider_refund_id"),
    /** The office's refund form, once: a retried or repeated submit records nothing more. */
    requestId: text("request_id"),
    status: paymentStatusEnum("status").notNull().default("completed"),
    cancellationNote: text("cancellation_note"),
    cancelledBy: uuid("cancelled_by").references(() => accounts.id),
    cancelledAt: ts("cancelled_at"),
    recordedBy: uuid("recorded_by").references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("refunds_voucher").on(t.schoolId, t.voucherNo),
    uniqueIndex("refunds_provider_refund").on(t.providerRefundId),
    uniqueIndex("refunds_request").on(t.requestId),
    index("refunds_payment").on(t.paymentId),
    index("refunds_school_date").on(t.schoolId, t.refundedOn),
  ],
);

/** The fee lines a refund takes money back from (none when it only returns money paid beyond the fees due). */
export const refundAllocations = pgTable(
  "refund_allocations",
  {
    refundId: uuid("refund_id").notNull().references(() => paymentRefunds.id),
    chargeId: uuid("charge_id").notNull().references(() => studentCharges.id),
    amount: integer("amount").notNull(),
  },
  (t) => [primaryKey({ columns: [t.refundId, t.chargeId] })],
);

/** An online payment attempt started by a parent. */
export const paymentOrders = pgTable(
  "payment_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    studentId: uuid("student_id").notNull().references(() => students.id),
    amount: integer("amount").notNull(),
    chargeIds: uuid("charge_ids").array().notNull(),
    provider: text("provider").notNull(),
    providerOrderId: text("provider_order_id"),
    status: orderStatusEnum("status").notNull().default("created"),
    createdBy: uuid("created_by").notNull().references(() => accounts.id),
    createdAt: createdAt(),
    paidAt: ts("paid_at"),
    paymentId: uuid("payment_id"),
    failureReason: text("failure_reason"),
    /** When the portal last asked the gateway about this unfinished order (lib/services/payment-check.ts). */
    checkedAt: ts("checked_at"),
  },
  (t) => [uniqueIndex("orders_provider_order").on(t.providerOrderId), index("orders_student").on(t.studentId)],
);

/**
 * A cash payment a family recorded on the portal ("I paid ₹5,000 in cash on
 * 30 September"). It is only a claim: nothing is paid, and no receipt exists,
 * until the principal or an office admin approves it — then it becomes an
 * ordinary cash payment with a receipt (`paymentId`). Declining it tells the
 * family by text message. `admissionAmount` is the part for the admission
 * fee; the rest is tuition.
 */
export const cashClaims = pgTable(
  "cash_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    studentId: uuid("student_id").notNull().references(() => students.id),
    sessionId: text("session_id").notNull().references(() => academicSessions.id),
    amount: integer("amount").notNull(), // paise
    admissionAmount: integer("admission_amount").notNull().default(0),
    /** The day the family says the cash was handed over. */
    paidOn: date("paid_on").notNull(),
    /** Optional: who the family gave it to ("to the class teacher"). */
    note: text("note"),
    status: cashClaimStatusEnum("status").notNull().default("pending"),
    createdBy: uuid("created_by").notNull().references(() => accounts.id),
    createdAt: createdAt(),
    decidedBy: uuid("decided_by").references(() => accounts.id),
    decidedAt: ts("decided_at"),
    /** Why the school declined it (shown to the family). */
    declineReason: text("decline_reason"),
    /** The cash payment made when it was approved. */
    paymentId: uuid("payment_id").references(() => payments.id),
  },
  (t) => [index("cash_claims_school_status").on(t.schoolId, t.status), index("cash_claims_student").on(t.studentId, t.sessionId)],
);

/** Webhook deliveries already processed (duplicates are ignored). */
export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
});

/**
 * An Excel import waiting for the office to confirm it. The checked rows are
 * kept only until the import is confirmed or discarded (then only counts remain).
 */
export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    sessionId: text("session_id").notNull().references(() => academicSessions.id),
    fileName: text("file_name").notNull(),
    status: text("status").notNull().default("previewed"), // "previewed" | "imported" | "discarded"
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    createdBy: uuid("created_by").notNull().references(() => accounts.id),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("imports_school_created").on(t.schoolId, t.createdAt)],
);

/**
 * Text messages (SMS): an outbox the sender works through, and the record of
 * what was sent. `vars` are the template's variables; `body` is the text as
 * the family receives it. Queued messages with the same `dedupeKey` are
 * merged (e.g. a register corrected within minutes sends one message).
 */
export const smsMessages = pgTable(
  "sms_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schoolId: text("school_id").notNull().references(() => schools.id),
    /** What caused it: attendance, remark, notice, homework, results, payment, test. */
    kind: text("kind").notNull(),
    /** Template key (see lib/sms/templates.ts), e.g. "attendance". */
    template: text("template").notNull(),
    lang: text("lang").notNull(),
    studentId: uuid("student_id").references(() => students.id),
    staffId: uuid("staff_id").references(() => staff.id),
    /** 10-digit Indian mobile number. */
    toMobile: text("to_mobile").notNull(),
    vars: jsonb("vars").$type<string[]>().notNull(),
    body: text("body").notNull(),
    status: smsStatusEnum("status").notNull().default("queued"),
    sendAfter: ts("send_after").notNull().defaultNow(),
    dedupeKey: text("dedupe_key"),
    relatedType: text("related_type"),
    relatedId: text("related_id"),
    provider: text("provider"),
    providerRef: text("provider_ref"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdBy: uuid("created_by").references(() => accounts.id),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
  },
  (t) => [
    uniqueIndex("sms_dedupe_queued").on(t.dedupeKey).where(sql`status = 'queued'`),
    index("sms_due").on(t.status, t.sendAfter),
    index("sms_school_created").on(t.schoolId, t.createdAt),
    index("sms_student").on(t.studentId),
  ],
);

/**
 * Hindi translations of text that teachers and the office wrote in English
 * (homework, remarks, notices…), made by the translation service when a
 * family reading in Hindi first sees the text (lib/translate). Found again by
 * a fingerprint of the original, which itself is not stored here. Rows not
 * read for 180 days are deleted.
 */
export const textTranslations = pgTable(
  "text_translations",
  {
    /** SHA-256 (hex) of the original text, as lib/translate/text.ts prepares it. */
    sourceHash: text("source_hash").notNull(),
    lang: text("lang").notNull(),
    text: text("text").notNull(),
    /** Who translated it: the service ("azure"). */
    provider: text("provider").notNull(),
    createdAt: createdAt(),
    usedAt: ts("used_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sourceHash, t.lang] }), index("text_translations_used").on(t.usedAt)],
);

/** Settings that belong to AESRI rather than one school (e.g. SMS template IDs). */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedBy: uuid("updated_by").references(() => accounts.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Receipt number sequences, one per school and session. */
export const counters = pgTable("counters", {
  key: text("key").primaryKey(),
  value: integer("value").notNull(),
});

export const nowSql = sql`now()`;

/** Separate from sign-in throttles, whose cleanup uses a different window. */
export const inferenceQuotas = pgTable("inference_quotas", {
  accountId: uuid("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  minuteStart: ts("minute_start").notNull(),
  minuteCount: integer("minute_count").notNull(),
  dayStart: ts("day_start").notNull(),
  dayCount: integer("day_count").notNull(),
});
