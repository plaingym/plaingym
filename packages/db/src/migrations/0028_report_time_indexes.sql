-- SPDX-License-Identifier: AGPL-3.0-only
CREATE INDEX "attendances_gym_occurred_at_idx" ON "attendances" USING btree ("gym_id","occurred_at");--> statement-breakpoint
CREATE INDEX "payments_gym_paid_at_idx" ON "payments" USING btree ("gym_id","paid_at");--> statement-breakpoint
CREATE INDEX "refunds_gym_resolved_at_idx" ON "refunds" USING btree ("gym_id","resolved_at");
