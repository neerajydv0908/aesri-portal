-- Stud-AI's percentages, sentences and reasons are shown again (contract 3). Only the derived
-- caches are cleared, so the new columns can be added; marks, attendance and students remain intact.
-- Estimates are worked out again the next time a teacher opens "Needs support".
DELETE FROM "risk_estimates";
--> statement-breakpoint
DELETE FROM "risk_checks";
--> statement-breakpoint
ALTER TABLE "risk_estimates" ADD COLUMN "percent" integer;--> statement-breakpoint
ALTER TABLE "risk_estimates" ADD COLUMN "text" text NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_estimates" ADD COLUMN "reasons" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_estimates" ADD COLUMN "assumed" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_estimates" ADD COLUMN "known_subject" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_estimates" DROP COLUMN "decision";--> statement-breakpoint
ALTER TABLE "risk_estimates" DROP COLUMN "review_reason";