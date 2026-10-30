-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "email_deliveries_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "email_deliveries_key_key" UNIQUE("gym_id","key"),
	CONSTRAINT "email_deliveries_state_check" CHECK ("email_deliveries"."state" in ('sending', 'accepted', 'unknown', 'not_accepted')),
	CONSTRAINT "email_deliveries_key_check" CHECK (char_length("email_deliveries"."key") between 1 and 300),
	CONSTRAINT "email_deliveries_attempts_check" CHECK ("email_deliveries"."attempts" > 0)
);
--> statement-breakpoint
ALTER TABLE "email_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "email_deliveries_gym_policy" ON "email_deliveries" AS PERMISSIVE FOR ALL TO "app" USING ("email_deliveries"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("email_deliveries"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);