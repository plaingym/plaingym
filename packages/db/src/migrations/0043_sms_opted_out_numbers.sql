-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "sms_opted_out_numbers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phone_e164" text NOT NULL,
	"opted_out_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sms_opted_out_numbers_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "sms_opted_out_numbers_phone_key" UNIQUE("gym_id","phone_e164"),
	CONSTRAINT "sms_opted_out_numbers_phone_e164_check" CHECK ("sms_opted_out_numbers"."phone_e164" ~ '^[+][1-9][0-9]{1,14}$')
);
--> statement-breakpoint
ALTER TABLE "sms_opted_out_numbers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sms_opted_out_numbers" ADD CONSTRAINT "sms_opted_out_numbers_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "sms_opted_out_numbers_gym_policy" ON "sms_opted_out_numbers" AS PERMISSIVE FOR ALL TO "app" USING ("sms_opted_out_numbers"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("sms_opted_out_numbers"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);