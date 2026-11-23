-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "stripe_events" ADD COLUMN "failed_at" timestamp with time zone;
