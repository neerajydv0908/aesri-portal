CREATE TABLE "risk_checks" (
	"session_id" text NOT NULL,
	"student_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"model_version" text,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "risk_checks_session_id_student_id_pk" PRIMARY KEY("session_id","student_id")
);
--> statement-breakpoint
CREATE TABLE "risk_estimates" (
	"session_id" text NOT NULL,
	"student_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"percent" integer NOT NULL,
	"risk" numeric(5, 4) NOT NULL,
	"text" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"assumed" jsonb NOT NULL,
	"known_subject" boolean NOT NULL,
	"tests_used" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "risk_estimates_session_id_student_id_subject_id_pk" PRIMARY KEY("session_id","student_id","subject_id")
);
--> statement-breakpoint
DROP TABLE "ai_drafts" CASCADE;--> statement-breakpoint
ALTER TABLE "risk_checks" ADD CONSTRAINT "risk_checks_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_checks" ADD CONSTRAINT "risk_checks_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_estimates" ADD CONSTRAINT "risk_estimates_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_estimates" ADD CONSTRAINT "risk_estimates_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_estimates" ADD CONSTRAINT "risk_estimates_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_remarks" DROP COLUMN "source";--> statement-breakpoint
-- The old AI assistant's on/off switch is gone with it (Stud-AI is now the estimates model).
UPDATE "schools" SET "settings" = "settings" - 'ai';
