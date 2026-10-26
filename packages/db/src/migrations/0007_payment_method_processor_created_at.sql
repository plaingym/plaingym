-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "payment_methods" ADD COLUMN "processor_created_at" timestamp with time zone;
