-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "email_deliveries" ADD COLUMN "command_digest" text;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "command_result" jsonb;