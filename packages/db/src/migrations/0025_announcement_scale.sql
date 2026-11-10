-- SPDX-License-Identifier: AGPL-3.0-only
-- Generated schema expansion, staged to preserve generations and normalize legacy lifecycle pairs before enforcing them.
ALTER TABLE "announcements" ADD COLUMN "send_generation" uuid;--> statement-breakpoint
UPDATE "announcements" SET "send_generation" = "id";--> statement-breakpoint
ALTER TABLE "announcements" ALTER COLUMN "send_generation" SET NOT NULL;--> statement-breakpoint
UPDATE "announcements" SET "completed_at" = CASE WHEN "status" = 'sent' THEN coalesce("completed_at", "created_at") ELSE NULL END
  WHERE ("status" = 'sent') <> ("completed_at" IS NOT NULL);--> statement-breakpoint
UPDATE "announcement_recipients" SET "reason" = CASE
  WHEN "state" = 'failed' THEN coalesce("reason", 'unknown')
  WHEN "state" = 'skipped' THEN coalesce("reason", 'ineligible')
  ELSE NULL END
  WHERE ("state" IN ('failed', 'skipped')) <> ("reason" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "email_deliveries_command_idx" ON "email_deliveries" USING btree ("gym_id","command_digest");--> statement-breakpoint
CREATE INDEX "announcement_recipients_member_idx" ON "announcement_recipients" USING btree ("gym_id","member_id");--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_generation_key" UNIQUE("gym_id","send_generation");--> statement-breakpoint
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_outcome_check" CHECK (("announcement_recipients"."state" in ('failed', 'skipped')) = ("announcement_recipients"."reason" is not null));--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_completion_check" CHECK (("announcements"."status" = 'sent') = ("announcements"."completed_at" is not null));
