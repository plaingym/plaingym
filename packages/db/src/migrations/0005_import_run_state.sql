-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "export_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"datasets" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"download_url" text,
	"expires_at" timestamp with time zone,
	CONSTRAINT "export_runs_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "export_runs_status_check" CHECK ("export_runs"."status" in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "export_runs_result_check" CHECK (("export_runs"."status" = 'succeeded' and "export_runs"."download_url" is not null
    and "export_runs"."expires_at" is not null and "export_runs"."completed_at" is not null)
    or ("export_runs"."status" <> 'succeeded' and "export_runs"."download_url" is null and "export_runs"."expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "export_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"row_count" integer NOT NULL,
	"committed_rows" integer DEFAULT 0 NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "import_chunks_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "import_chunks_position_key" UNIQUE("gym_id","run_id","position"),
	CONSTRAINT "import_chunks_counts_check" CHECK ("import_chunks"."position" >= 0 and "import_chunks"."row_count" > 0
    and "import_chunks"."committed_rows" >= 0 and "import_chunks"."committed_rows" <= "import_chunks"."row_count")
);
--> statement-breakpoint
ALTER TABLE "import_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"input" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"timezone" text NOT NULL,
	"dry_run" boolean NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_rows" integer NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"committed_rows" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "import_runs_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "import_runs_status_check" CHECK ("import_runs"."status" in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "import_runs_counts_check" CHECK ("import_runs"."total_rows" >= 0 and "import_runs"."processed_rows" >= 0 and "import_runs"."processed_rows" <= "import_runs"."total_rows"
    and "import_runs"."committed_rows" >= 0 and "import_runs"."committed_rows" <= "import_runs"."processed_rows" and "import_runs"."error_count" >= 0
    and (not "import_runs"."dry_run" or "import_runs"."committed_rows" = 0))
);
--> statement-breakpoint
ALTER TABLE "import_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_chunks" ADD CONSTRAINT "import_chunks_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_chunks" ADD CONSTRAINT "import_chunks_run_fk" FOREIGN KEY ("gym_id","run_id") REFERENCES "public"."import_runs"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_runs_retention_idx" ON "export_runs" USING btree ("gym_id","updated_at");--> statement-breakpoint
CREATE INDEX "import_runs_retention_idx" ON "import_runs" USING btree ("gym_id","updated_at");--> statement-breakpoint
CREATE POLICY "export_runs_gym_policy" ON "export_runs" AS PERMISSIVE FOR ALL TO "app" USING ("export_runs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("export_runs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "import_chunks_gym_policy" ON "import_chunks" AS PERMISSIVE FOR ALL TO "app" USING ("import_chunks"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("import_chunks"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "import_runs_gym_policy" ON "import_runs" AS PERMISSIVE FOR ALL TO "app" USING ("import_runs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("import_runs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);