-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "sms_daily_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"day" date NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"refused" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sms_daily_usage_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "sms_daily_usage_day_key" UNIQUE("gym_id","day"),
	CONSTRAINT "sms_daily_usage_counts_check" CHECK ("sms_daily_usage"."sent" >= 0 and "sms_daily_usage"."refused" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sms_daily_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sms_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"command_digest" text,
	"command_result" jsonb,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sms_deliveries_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "sms_deliveries_key_key" UNIQUE("gym_id","key"),
	CONSTRAINT "sms_deliveries_state_check" CHECK ("sms_deliveries"."state" in ('sending', 'accepted', 'unknown', 'not_accepted')),
	CONSTRAINT "sms_deliveries_key_check" CHECK (char_length("sms_deliveries"."key") between 1 and 300 and "sms_deliveries"."key" ~ '^[A-Za-z0-9_.:-]+$'),
	CONSTRAINT "sms_deliveries_attempts_check" CHECK ("sms_deliveries"."attempts" > 0)
);
--> statement-breakpoint
ALTER TABLE "sms_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sms_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipient" text NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sms_outbox_gym_id_id_key" UNIQUE("gym_id","id")
);
--> statement-breakpoint
ALTER TABLE "sms_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gyms" ADD COLUMN "sms_config_encrypted" text;--> statement-breakpoint
ALTER TABLE "gyms" ADD COLUMN "member_sms_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gyms" ADD COLUMN "sms_daily_cap" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "sms_notices_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "sms_notices_consent_source" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "sms_notices_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "sms_notices_consent_source" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "sms_announcements_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "sms_announcements_consent_source" text;--> statement-breakpoint
ALTER TABLE "sms_daily_usage" ADD CONSTRAINT "sms_daily_usage_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_deliveries" ADD CONSTRAINT "sms_deliveries_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_outbox" ADD CONSTRAINT "sms_outbox_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_deliveries_command_idx" ON "sms_deliveries" USING btree ("gym_id","command_digest");--> statement-breakpoint
CREATE INDEX "sms_outbox_gym_time_idx" ON "sms_outbox" USING btree ("gym_id","sent_at");--> statement-breakpoint
CREATE INDEX "households_gym_phone_idx" ON "households" USING btree ("gym_id","phone_e164");--> statement-breakpoint
CREATE INDEX "members_gym_phone_idx" ON "members" USING btree ("gym_id","phone_e164");--> statement-breakpoint
-- rollback-reviewed: Checks only the new cap column; old inserts use its positive default and old readers ignore it.
ALTER TABLE "gyms" ADD CONSTRAINT "gyms_sms_daily_cap_check" CHECK ("gyms"."sms_daily_cap" > 0);--> statement-breakpoint
-- rollback-reviewed: Checks only new nullable SMS columns; old inserts omit them and old readers ignore them, with no change to existing phone values.
ALTER TABLE "households" ADD CONSTRAINT "households_phone_e164_check" CHECK ("households"."phone_e164" ~ '^[+][1-9][0-9]{1,14}$');--> statement-breakpoint
-- rollback-reviewed: Checks only new nullable SMS columns; old inserts omit them and old readers ignore them, with no change to existing phone values.
ALTER TABLE "households" ADD CONSTRAINT "households_sms_notices_source_check" CHECK ("households"."sms_notices_consent_source" in ('join', 'portal', 'staff'));--> statement-breakpoint
-- rollback-reviewed: Checks only new nullable SMS columns; old inserts omit them and old readers ignore them, with no change to existing phone values.
ALTER TABLE "households" ADD CONSTRAINT "households_sms_notices_consent_check" CHECK (("households"."sms_notices_consent_at" is null) = ("households"."sms_notices_consent_source" is null) and ("households"."sms_notices_consent_at" is null or "households"."phone_e164" is not null));--> statement-breakpoint
-- rollback-reviewed: Checks only new nullable SMS columns; old inserts omit them and old readers ignore them, with no change to existing phone values.
ALTER TABLE "members" ADD CONSTRAINT "members_phone_e164_check" CHECK ("members"."phone_e164" ~ '^[+][1-9][0-9]{1,14}$');--> statement-breakpoint
-- rollback-reviewed: Checks only new nullable SMS columns; old inserts omit them and old readers ignore them, with no change to existing phone values.
ALTER TABLE "members" ADD CONSTRAINT "members_sms_notices_source_check" CHECK ("members"."sms_notices_consent_source" in ('join', 'portal', 'staff'));--> statement-breakpoint
-- rollback-reviewed: Checks only new nullable SMS columns; old inserts omit them and old readers ignore them, with no change to existing phone values.
ALTER TABLE "members" ADD CONSTRAINT "members_sms_announcements_source_check" CHECK ("members"."sms_announcements_consent_source" in ('join', 'portal'));--> statement-breakpoint
-- rollback-reviewed: Checks only new nullable SMS columns; old inserts omit them and old readers ignore them, with no change to existing phone values.
ALTER TABLE "members" ADD CONSTRAINT "members_sms_notices_consent_check" CHECK (("members"."sms_notices_consent_at" is null) = ("members"."sms_notices_consent_source" is null) and ("members"."sms_notices_consent_at" is null or "members"."phone_e164" is not null));--> statement-breakpoint
-- rollback-reviewed: Checks only new nullable SMS columns; old inserts omit them and old readers ignore them, with no change to existing phone values.
ALTER TABLE "members" ADD CONSTRAINT "members_sms_announcements_consent_check" CHECK (("members"."sms_announcements_consent_at" is null) = ("members"."sms_announcements_consent_source" is null) and ("members"."sms_announcements_consent_at" is null or "members"."phone_e164" is not null));--> statement-breakpoint
CREATE POLICY "sms_daily_usage_gym_policy" ON "sms_daily_usage" AS PERMISSIVE FOR ALL TO "app" USING ("sms_daily_usage"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("sms_daily_usage"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sms_deliveries_gym_policy" ON "sms_deliveries" AS PERMISSIVE FOR ALL TO "app" USING ("sms_deliveries"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("sms_deliveries"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sms_outbox_gym_policy" ON "sms_outbox" AS PERMISSIVE FOR ALL TO "app" USING ("sms_outbox"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("sms_outbox"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);
