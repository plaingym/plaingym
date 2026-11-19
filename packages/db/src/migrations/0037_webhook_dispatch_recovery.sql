-- SPDX-License-Identifier: AGPL-3.0-only
CREATE INDEX "stripe_events_recovery_error_idx" ON "stripe_events" USING btree ("gym_id","id") WHERE "stripe_events"."processed_at" is null and "stripe_events"."error" is not null;--> statement-breakpoint
CREATE INDEX "stripe_events_recovery_no_error_idx" ON "stripe_events" USING btree ("gym_id","id") WHERE "stripe_events"."processed_at" is null and "stripe_events"."error" is null;
