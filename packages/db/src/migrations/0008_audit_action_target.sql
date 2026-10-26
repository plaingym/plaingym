-- SPDX-License-Identifier: AGPL-3.0-only
CREATE INDEX "audit_events_gym_action_target_idx" ON "audit_events" USING btree ("gym_id","action","target_id");
