-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_status_check";--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status_check" CHECK ("refunds"."status" in ('pending', 'succeeded', 'failed', 'canceled'));