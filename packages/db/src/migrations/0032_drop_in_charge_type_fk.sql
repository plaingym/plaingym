-- SPDX-License-Identifier: AGPL-3.0-only
-- Reviewed SQL: gyms.drop_in_charge_type_id must name one of the same gym's charge types. The key is declared here,
-- not in schema/gyms.ts, because a schema reference would make gyms.ts and billing.ts import each other.
-- An ID naming no charge type of the gym already showed no fee, so clearing it changes nothing a gym sees.
-- An archived (inactive) charge type still exists, so a gym that chose one keeps it.
UPDATE "gyms" SET "drop_in_charge_type_id" = NULL
WHERE "drop_in_charge_type_id" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "charge_types" WHERE "charge_types"."gym_id" = "gyms"."id" AND "charge_types"."id" = "gyms"."drop_in_charge_type_id"
);--> statement-breakpoint
ALTER TABLE "gyms" ADD CONSTRAINT "gyms_drop_in_charge_type_fk" FOREIGN KEY ("id","drop_in_charge_type_id") REFERENCES "public"."charge_types"("gym_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "gyms" VALIDATE CONSTRAINT "gyms_drop_in_charge_type_fk";
