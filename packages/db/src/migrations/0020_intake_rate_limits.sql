-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "intake_rate_limits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid,
	"route_key" text NOT NULL,
	"client_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "intake_rate_limits_window_key" UNIQUE NULLS NOT DISTINCT("gym_id","route_key","client_key","window_start")
);
--> statement-breakpoint
ALTER TABLE "intake_rate_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_rate_limits" ADD CONSTRAINT "intake_rate_limits_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_rate_limits_expiry_idx" ON "intake_rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE POLICY "intake_rate_limits_system_policy" ON "intake_rate_limits" AS PERMISSIVE FOR ALL TO "app" USING (current_setting('app.system', true) = 'on') WITH CHECK (current_setting('app.system', true) = 'on');
