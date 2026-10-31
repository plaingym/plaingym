-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "auth_verification" ADD COLUMN "gym_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_verification" ADD COLUMN "household_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_verification" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_verification" ADD CONSTRAINT "auth_verification_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_verification" ADD CONSTRAINT "auth_verification_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_verification_portal_invitation_idx" ON "auth_verification" USING btree ("gym_id","household_id","expires_at") WHERE "auth_verification"."household_id" is not null;--> statement-breakpoint
CREATE INDEX "auth_verification_portal_invitee_idx" ON "auth_verification" USING btree ("user_id") WHERE "auth_verification"."user_id" is not null;--> statement-breakpoint
-- Backfill invitations issued before this release. Only portal invitation rows are read, and nothing is cast until
-- pg_input_is_valid has accepted it, so a Better Auth row or a malformed invitation never fails the upgrade.
-- Rows that don't parse, or whose gym or invitee no longer exists, keep null: they can't be accepted either.
WITH "invitations" AS MATERIALIZED (
	SELECT "id", split_part("identifier", ':', 2) AS "gym", CASE WHEN pg_input_is_valid("value", 'jsonb') THEN "value"::jsonb END AS "binding"
	FROM "auth_verification" WHERE "identifier" LIKE 'portal-invitation:%'
), "bindings" AS MATERIALIZED (
	SELECT "id", "gym"::uuid AS "gym_id", ("binding" ->> 'householdId')::uuid AS "household_id", ("binding" ->> 'userId')::uuid AS "user_id"
	FROM "invitations"
	WHERE pg_input_is_valid("gym", 'uuid') AND pg_input_is_valid("binding" ->> 'householdId', 'uuid') AND pg_input_is_valid("binding" ->> 'userId', 'uuid')
)
UPDATE "auth_verification" SET "gym_id" = "bindings"."gym_id", "household_id" = "bindings"."household_id", "user_id" = "bindings"."user_id"
FROM "bindings"
WHERE "auth_verification"."id" = "bindings"."id"
	AND EXISTS (SELECT 1 FROM "gyms" WHERE "gyms"."id" = "bindings"."gym_id")
	AND EXISTS (SELECT 1 FROM "auth_user" WHERE "auth_user"."id" = "bindings"."user_id");
