-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "ranks" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "ranks" ADD CONSTRAINT "ranks_color_check" CHECK ("ranks"."color" ~ '^#[0-9a-fA-F]{6}$');
