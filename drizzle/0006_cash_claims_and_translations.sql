CREATE TYPE "public"."cash_claim_status" AS ENUM('pending', 'approved', 'declined', 'withdrawn');--> statement-breakpoint
CREATE TABLE "cash_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"student_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"amount" integer NOT NULL,
	"admission_amount" integer DEFAULT 0 NOT NULL,
	"paid_on" date NOT NULL,
	"note" text,
	"status" "cash_claim_status" DEFAULT 'pending' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decline_reason" text,
	"payment_id" uuid
);
--> statement-breakpoint
CREATE TABLE "text_translations" (
	"source_hash" text NOT NULL,
	"lang" text NOT NULL,
	"text" text NOT NULL,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "text_translations_source_hash_lang_pk" PRIMARY KEY("source_hash","lang")
);
--> statement-breakpoint
ALTER TABLE "cash_claims" ADD CONSTRAINT "cash_claims_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_claims" ADD CONSTRAINT "cash_claims_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_claims" ADD CONSTRAINT "cash_claims_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_claims" ADD CONSTRAINT "cash_claims_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_claims" ADD CONSTRAINT "cash_claims_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_claims" ADD CONSTRAINT "cash_claims_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_claims_school_status" ON "cash_claims" USING btree ("school_id","status");--> statement-breakpoint
CREATE INDEX "cash_claims_student" ON "cash_claims" USING btree ("student_id","session_id");--> statement-breakpoint
CREATE INDEX "text_translations_used" ON "text_translations" USING btree ("used_at");