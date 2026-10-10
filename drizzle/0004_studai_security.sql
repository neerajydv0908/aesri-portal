-- Only derived inference caches are cleared; marks, attendance and students remain intact.
-- This prevents old probabilities from being reused after the class-only contract change.
DELETE FROM "risk_estimates";
--> statement-breakpoint
DELETE FROM "risk_checks";
--> statement-breakpoint
CREATE TABLE "inference_quotas" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"minute_start" timestamp with time zone NOT NULL,
	"minute_count" integer NOT NULL,
	"day_start" timestamp with time zone NOT NULL,
	"day_count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "risk_estimates" ADD COLUMN "decision" text NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_estimates" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "inference_quotas" ADD CONSTRAINT "inference_quotas_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_estimates" DROP COLUMN "percent";--> statement-breakpoint
ALTER TABLE "risk_estimates" DROP COLUMN "risk";--> statement-breakpoint
ALTER TABLE "risk_estimates" DROP COLUMN "text";--> statement-breakpoint
ALTER TABLE "risk_estimates" DROP COLUMN "reasons";--> statement-breakpoint
ALTER TABLE "risk_estimates" DROP COLUMN "assumed";--> statement-breakpoint
ALTER TABLE "risk_estimates" DROP COLUMN "known_subject";