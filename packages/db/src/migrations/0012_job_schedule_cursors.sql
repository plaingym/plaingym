-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "job_schedule_cursors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"name" text NOT NULL,
	"expression" text NOT NULL,
	"timezone" text NOT NULL,
	"last_occurrence" timestamp with time zone NOT NULL,
	CONSTRAINT "job_schedule_cursors_gym_name_key" UNIQUE("gym_id","name")
);
--> statement-breakpoint
ALTER TABLE "job_schedule_cursors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_schedule_cursors" ADD CONSTRAINT "job_schedule_cursors_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "job_schedule_cursors_gym_policy" ON "job_schedule_cursors" AS PERMISSIVE FOR ALL TO "app" USING (("job_schedule_cursors"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) or (current_setting('app.system', true) = 'on')) WITH CHECK (("job_schedule_cursors"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) or (current_setting('app.system', true) = 'on'));