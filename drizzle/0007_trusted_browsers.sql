CREATE TABLE "trusted_browsers" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"totp_tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"browser" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trusted_browsers" ADD CONSTRAINT "trusted_browsers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trusted_browsers_account" ON "trusted_browsers" USING btree ("account_id");