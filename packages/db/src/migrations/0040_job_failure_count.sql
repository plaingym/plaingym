-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "jobs" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;
