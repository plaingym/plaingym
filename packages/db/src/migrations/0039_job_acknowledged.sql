-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "jobs" ADD COLUMN "acknowledged_at" timestamp with time zone;
