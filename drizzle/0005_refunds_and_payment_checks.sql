-- Refunds: money given back on a payment (online through Razorpay, or by the office for a counter payment),
-- and the fee lines each refund takes money back from. Nothing existing changes: payments keep their receipts.
-- payment_orders.checked_at: when the portal last asked Razorpay about an unfinished online payment.
CREATE TYPE "public"."refund_method" AS ENUM('online', 'cash', 'cheque', 'bank');--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" text NOT NULL,
	"payment_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"voucher_no" text NOT NULL,
	"amount" integer NOT NULL,
	"refunded_on" date NOT NULL,
	"method" "refund_method" NOT NULL,
	"reference" text,
	"note" text NOT NULL,
	"provider" text,
	"provider_refund_id" text,
	"request_id" text,
	"status" "payment_status" DEFAULT 'completed' NOT NULL,
	"cancellation_note" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_allocations" (
	"refund_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "refund_allocations_refund_id_charge_id_pk" PRIMARY KEY("refund_id","charge_id")
);
--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_cancelled_by_accounts_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_recorded_by_accounts_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_refund_id_payment_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."payment_refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_charge_id_student_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."student_charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_voucher" ON "payment_refunds" USING btree ("school_id","voucher_no");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_refund" ON "payment_refunds" USING btree ("provider_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_request" ON "payment_refunds" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "refunds_payment" ON "payment_refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_school_date" ON "payment_refunds" USING btree ("school_id","refunded_on");