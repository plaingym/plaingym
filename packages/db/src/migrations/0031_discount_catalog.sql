-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "discount_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"discount_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	CONSTRAINT "discount_plans_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "discount_plans_pair_key" UNIQUE("gym_id","discount_id","plan_id")
);
--> statement-breakpoint
ALTER TABLE "discount_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"percent_basis_points" integer,
	"amount_cents" integer,
	"currency" text NOT NULL,
	"waives_signup_fee" boolean DEFAULT false NOT NULL,
	"duration" text,
	"cycles" integer,
	"ends_on" date,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "discounts_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "discounts_name_check" CHECK (char_length(btrim("discounts"."name")) between 1 and 100 and "discounts"."name" = btrim("discounts"."name")),
	CONSTRAINT "discounts_code_check" CHECK ("discounts"."code" is null or "discounts"."code" ~ '^[A-Za-z0-9-]{3,40}$'),
	CONSTRAINT "discounts_currency_check" CHECK ("discounts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "discounts_price_check" CHECK (("discounts"."percent_basis_points" is null or "discounts"."percent_basis_points" between 1 and 10000)
    and ("discounts"."amount_cents" is null or "discounts"."amount_cents" > 0)
    and ("discounts"."percent_basis_points" is null or "discounts"."amount_cents" is null)
    and ("discounts"."percent_basis_points" is not null or "discounts"."amount_cents" is not null or "discounts"."waives_signup_fee")),
	CONSTRAINT "discounts_duration_check" CHECK (("discounts"."percent_basis_points" is null and "discounts"."amount_cents" is null and "discounts"."duration" is null and "discounts"."cycles" is null)
    or (("discounts"."percent_basis_points" is not null or "discounts"."amount_cents" is not null) and "discounts"."duration" is not null
      and (("discounts"."duration" in ('once', 'forever') and "discounts"."cycles" is null)
        or ("discounts"."duration" = 'cycles' and "discounts"."cycles" is not null and "discounts"."cycles" >= 1)))),
	CONSTRAINT "discounts_uses_check" CHECK ("discounts"."uses" >= 0 and ("discounts"."max_uses" is null or ("discounts"."max_uses" > 0 and "discounts"."uses" <= "discounts"."max_uses"))),
	CONSTRAINT "discounts_revision_check" CHECK ("discounts"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "discounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "membership_discounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"household_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"name" text NOT NULL,
	"percent_basis_points" integer,
	"amount_cents" integer,
	"currency" text NOT NULL,
	"waives_signup_fee" boolean NOT NULL,
	"duration" text,
	"cycles_left" integer,
	"plan_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "membership_discounts_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "membership_discounts_name_check" CHECK (char_length(btrim("membership_discounts"."name")) between 1 and 100),
	CONSTRAINT "membership_discounts_currency_check" CHECK ("membership_discounts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "membership_discounts_price_check" CHECK (("membership_discounts"."percent_basis_points" is null or "membership_discounts"."percent_basis_points" between 1 and 10000)
    and ("membership_discounts"."amount_cents" is null or "membership_discounts"."amount_cents" > 0)
    and ("membership_discounts"."percent_basis_points" is null or "membership_discounts"."amount_cents" is null)
    and ("membership_discounts"."percent_basis_points" is not null or "membership_discounts"."amount_cents" is not null or "membership_discounts"."waives_signup_fee")),
	CONSTRAINT "membership_discounts_duration_check" CHECK (("membership_discounts"."percent_basis_points" is null and "membership_discounts"."amount_cents" is null and "membership_discounts"."duration" is null and "membership_discounts"."cycles_left" is null)
    or (("membership_discounts"."percent_basis_points" is not null or "membership_discounts"."amount_cents" is not null) and "membership_discounts"."duration" is not null
      and (("membership_discounts"."duration" = 'forever' and "membership_discounts"."cycles_left" is null)
        or ("membership_discounts"."duration" in ('once', 'cycles') and "membership_discounts"."cycles_left" is not null and "membership_discounts"."cycles_left" >= 0
          and ("membership_discounts"."duration" <> 'once' or "membership_discounts"."cycles_left" <= 1))))),
	CONSTRAINT "membership_discounts_end_check" CHECK (("membership_discounts"."ended_at" is null and "membership_discounts"."end_reason" is null)
    or ("membership_discounts"."ended_at" is not null and "membership_discounts"."ended_at" >= "membership_discounts"."applied_at" and "membership_discounts"."end_reason" is not null
      and "membership_discounts"."end_reason" in ('replaced', 'removed', 'switch', 'completed', 'released'))),
	CONSTRAINT "membership_discounts_plans_check" CHECK (array_position("membership_discounts"."plan_ids", null) is null),
	CONSTRAINT "membership_discounts_revision_check" CHECK ("membership_discounts"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "membership_discounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "discount_plans" ADD CONSTRAINT "discount_plans_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_plans" ADD CONSTRAINT "discount_plans_discount_fk" FOREIGN KEY ("gym_id","discount_id") REFERENCES "public"."discounts"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_plans" ADD CONSTRAINT "discount_plans_plan_fk" FOREIGN KEY ("gym_id","plan_id") REFERENCES "public"."plans"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_currency_fk" FOREIGN KEY ("gym_id","currency") REFERENCES "public"."gyms"("id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_discounts" ADD CONSTRAINT "membership_discounts_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_discounts" ADD CONSTRAINT "membership_discounts_membership_fk" FOREIGN KEY ("gym_id","household_id","membership_id") REFERENCES "public"."memberships"("gym_id","household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_discounts" ADD CONSTRAINT "membership_discounts_discount_fk" FOREIGN KEY ("gym_id","discount_id") REFERENCES "public"."discounts"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_discounts" ADD CONSTRAINT "membership_discounts_currency_fk" FOREIGN KEY ("gym_id","currency") REFERENCES "public"."gyms"("id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discount_plans_plan_idx" ON "discount_plans" USING btree ("gym_id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_name_key" ON "discounts" USING btree ("gym_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_code_key" ON "discounts" USING btree ("gym_id",lower("code")) WHERE "discounts"."code" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_discounts_live_key" ON "membership_discounts" USING btree ("gym_id","membership_id") WHERE "membership_discounts"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "membership_discounts_discount_idx" ON "membership_discounts" USING btree ("gym_id","discount_id");--> statement-breakpoint
CREATE POLICY "discount_plans_gym_policy" ON "discount_plans" AS PERMISSIVE FOR ALL TO "app" USING ("discount_plans"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("discount_plans"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "discounts_gym_policy" ON "discounts" AS PERMISSIVE FOR ALL TO "app" USING ("discounts"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("discounts"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "membership_discounts_gym_policy" ON "membership_discounts" AS PERMISSIVE FOR ALL TO "app" USING ("membership_discounts"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("membership_discounts"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);
