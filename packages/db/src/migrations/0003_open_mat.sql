-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "gyms" ADD COLUMN "open_mat_counts_as_class" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attendances" ADD COLUMN "kind" text DEFAULT 'class' NOT NULL;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD COLUMN "kind" text DEFAULT 'class' NOT NULL;--> statement-breakpoint
ALTER TABLE "class_templates" ADD COLUMN "kind" text DEFAULT 'class' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_kind_check" CHECK ("attendances"."kind" in ('class', 'open_mat'));--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_kind_check" CHECK ("class_sessions"."kind" in ('class', 'open_mat'));--> statement-breakpoint
ALTER TABLE "class_templates" ADD CONSTRAINT "class_templates_kind_check" CHECK ("class_templates"."kind" in ('class', 'open_mat'));--> statement-breakpoint
-- Visits recorded before this migration without a session were open-mat check-ins.
UPDATE "attendances" SET "kind" = 'open_mat' WHERE "session_id" IS NULL AND "source" <> 'import';
