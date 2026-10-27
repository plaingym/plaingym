-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "gyms" ADD COLUMN "retry_days" integer[] DEFAULT '{3,7}' NOT NULL;--> statement-breakpoint
ALTER TABLE "gyms" ADD CONSTRAINT "gyms_retry_days_check" CHECK (cardinality("gyms"."retry_days") = 0 or (
    array_ndims("gyms"."retry_days") = 1 and array_lower("gyms"."retry_days", 1) = 1
    and cardinality("gyms"."retry_days") between 1 and 4 and array_position("gyms"."retry_days", null) is null
    and 1 <= all("gyms"."retry_days") and 28 >= all("gyms"."retry_days")
    and (cardinality("gyms"."retry_days") < 2 or "gyms"."retry_days"[1] < "gyms"."retry_days"[2])
    and (cardinality("gyms"."retry_days") < 3 or "gyms"."retry_days"[2] < "gyms"."retry_days"[3])
    and (cardinality("gyms"."retry_days") < 4 or "gyms"."retry_days"[3] < "gyms"."retry_days"[4])));
