-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "households" ADD COLUMN "pin_failed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "pin_locked_until" timestamp with time zone;--> statement-breakpoint
-- rollback-reviewed: Checks only the new wrong-PIN count column; old inserts and updates omit it and get its default 0, and old readers ignore it.
ALTER TABLE "households" ADD CONSTRAINT "households_pin_failed_count_check" CHECK ("households"."pin_failed_count" >= 0);