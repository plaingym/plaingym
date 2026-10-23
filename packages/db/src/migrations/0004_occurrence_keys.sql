-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "class_sessions" ADD COLUMN "occurrence_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_occurrence_key" UNIQUE("gym_id","template_id","occurrence_starts_at");--> statement-breakpoint
-- Generated starts could not be moved before this migration, so each one is still its occurrence.
UPDATE "class_sessions" SET "occurrence_starts_at" = "starts_at" WHERE "template_id" IS NOT NULL;
