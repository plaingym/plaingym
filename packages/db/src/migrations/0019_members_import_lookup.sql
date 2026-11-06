-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "members" ADD COLUMN "last_name_folded" text GENERATED ALWAYS AS (lower(last_name)) STORED;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "email_folded" text GENERATED ALWAYS AS (lower(email)) STORED;--> statement-breakpoint
CREATE INDEX "members_gym_last_name_folded_idx" ON "members" USING btree ("gym_id","last_name_folded") WHERE "members"."anonymized_at" is null;--> statement-breakpoint
CREATE INDEX "members_gym_email_folded_idx" ON "members" USING btree ("gym_id","email_folded") WHERE "members"."anonymized_at" is null;
