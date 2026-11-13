-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "memberships" ADD COLUMN "scheduled_origin" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_scheduled_origin_check" CHECK ("memberships"."scheduled_origin" in ('switch', 'downgrade', 'price_change'));