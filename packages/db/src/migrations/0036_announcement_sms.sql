-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "announcement_sms_recipients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"announcement_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"member_ids" jsonb NOT NULL,
	"phone_digest" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_sms_recipients_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "announcement_sms_recipients_member_key" UNIQUE("gym_id","announcement_id","member_id"),
	CONSTRAINT "announcement_sms_recipients_state_check" CHECK ("announcement_sms_recipients"."state" in ('pending', 'sent', 'failed', 'skipped')),
	CONSTRAINT "announcement_sms_recipients_members_check" CHECK (jsonb_typeof("announcement_sms_recipients"."member_ids") = 'array' and jsonb_array_length("announcement_sms_recipients"."member_ids") > 0),
	CONSTRAINT "announcement_sms_recipients_outcome_check" CHECK (("announcement_sms_recipients"."state" in ('failed', 'skipped')) = ("announcement_sms_recipients"."reason" is not null)),
	CONSTRAINT "announcement_sms_recipients_reason_check" CHECK ("announcement_sms_recipients"."reason" in ('ineligible', 'duplicate_phone', 'disabled', 'no_provider', 'no_consent', 'phone_changed', 'cap_reached', 'not_accepted', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "announcement_sms_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "sms_body" text;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "sms_recipient_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "sms_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "sms_failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "sms_skipped" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "sms_scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "sms_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcement_sms_recipients" ADD CONSTRAINT "announcement_sms_recipients_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_sms_recipients" ADD CONSTRAINT "announcement_sms_recipients_announcement_fk" FOREIGN KEY ("gym_id","announcement_id") REFERENCES "public"."announcements"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_sms_recipients" ADD CONSTRAINT "announcement_sms_recipients_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcement_sms_recipients_scan_idx" ON "announcement_sms_recipients" USING btree ("gym_id","announcement_id","state","id");--> statement-breakpoint
CREATE INDEX "announcement_sms_recipients_member_idx" ON "announcement_sms_recipients" USING btree ("gym_id","member_id");--> statement-breakpoint
-- rollback-reviewed: Checks only new count columns with zero defaults. Existing email inserts omit them; the existing email history reader projects only email fields and ignores these columns.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_sms_counts_check" CHECK ("announcements"."sms_recipient_count" >= 0 and "announcements"."sms_sent" >= 0 and "announcements"."sms_failed" >= 0 and "announcements"."sms_skipped" >= 0);--> statement-breakpoint
-- rollback-reviewed: Checks only the new nullable text body. Existing email inserts leave it null; the existing email history reader projects only email fields and ignores this column.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_sms_body_check" CHECK ("announcements"."sms_body" is null or char_length("announcements"."sms_body") between 1 and 480);--> statement-breakpoint
CREATE POLICY "announcement_sms_recipients_gym_policy" ON "announcement_sms_recipients" AS PERMISSIVE FOR ALL TO "app" USING ("announcement_sms_recipients"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("announcement_sms_recipients"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);
