CREATE TYPE "public"."sms_status" AS ENUM('queued', 'sent', 'failed', 'cancelled', 'skipped');--> statement-breakpoint
ALTER TYPE "public"."notice_audience" ADD VALUE 'students';--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notice_recipients" (
	"notice_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	CONSTRAINT "notice_recipients_notice_id_student_id_pk" PRIMARY KEY("notice_id","student_id")
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"kind" text NOT NULL,
	"template" text NOT NULL,
	"lang" text NOT NULL,
	"student_id" uuid,
	"staff_id" uuid,
	"to_mobile" text NOT NULL,
	"vars" jsonb NOT NULL,
	"body" text NOT NULL,
	"status" "sms_status" DEFAULT 'queued' NOT NULL,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text,
	"related_type" text,
	"related_id" text,
	"provider" text,
	"provider_ref" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "sms_off" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_recipients" ADD CONSTRAINT "notice_recipients_notice_id_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_recipients" ADD CONSTRAINT "notice_recipients_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notice_recipients_student" ON "notice_recipients" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_dedupe_queued" ON "sms_messages" USING btree ("dedupe_key") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "sms_due" ON "sms_messages" USING btree ("status","send_after");--> statement-breakpoint
CREATE INDEX "sms_school_created" ON "sms_messages" USING btree ("school_id","created_at");--> statement-breakpoint
CREATE INDEX "sms_student" ON "sms_messages" USING btree ("student_id");