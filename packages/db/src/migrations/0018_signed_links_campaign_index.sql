-- SPDX-License-Identifier: AGPL-3.0-only
CREATE INDEX "signed_links_campaign_idx" ON "signed_links" USING btree ("gym_id","campaign_id","id");