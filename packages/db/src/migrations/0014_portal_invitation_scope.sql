-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "auth_verification" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "auth_verification" ADD CONSTRAINT "auth_verification_scope_check" CHECK ("auth_verification"."scope" in ('payer', 'member'));--> statement-breakpoint
-- Backfill the invitations written without these columns: by a process still on the release before 0013 (no gym, household
-- or invitee columns; 0013's backfill repeated) or on the release before this one (no scope). Only portal invitation rows that
-- lack one are read, and nothing is cast until pg_input_is_valid has accepted it, so a Better Auth row or a malformed invitation
-- never fails the upgrade. Rows that don't parse, or whose gym or invitee no longer exists, keep null: they can't be accepted either.
WITH "invitations" AS MATERIALIZED (
	SELECT "id", split_part("identifier", ':', 2) AS "gym", CASE WHEN pg_input_is_valid("value", 'jsonb') THEN "value"::jsonb END AS "binding"
	FROM "auth_verification" WHERE "identifier" LIKE 'portal-invitation:%' AND ("household_id" IS NULL OR "scope" IS NULL)
), "bindings" AS MATERIALIZED (
	SELECT "id", "gym"::uuid AS "gym_id", ("binding" ->> 'householdId')::uuid AS "household_id", ("binding" ->> 'userId')::uuid AS "user_id",
		"binding" ->> 'scope' AS "scope"
	FROM "invitations"
	WHERE pg_input_is_valid("gym", 'uuid') AND pg_input_is_valid("binding" ->> 'householdId', 'uuid') AND pg_input_is_valid("binding" ->> 'userId', 'uuid')
		AND "binding" ->> 'scope' IN ('payer', 'member')
)
UPDATE "auth_verification" SET "gym_id" = "bindings"."gym_id", "household_id" = "bindings"."household_id", "user_id" = "bindings"."user_id",
	"scope" = "bindings"."scope"
FROM "bindings"
WHERE "auth_verification"."id" = "bindings"."id"
	AND EXISTS (SELECT 1 FROM "gyms" WHERE "gyms"."id" = "bindings"."gym_id")
	AND EXISTS (SELECT 1 FROM "auth_user" WHERE "auth_user"."id" = "bindings"."user_id");
