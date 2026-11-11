-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "class_credit_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"credits" integer NOT NULL,
	"lot_id" uuid,
	"sale_id" uuid,
	"attendance_id" uuid,
	"expires_at" timestamp with time zone,
	"reason" text,
	"adjustment_id" uuid,
	"created_by" uuid,
	CONSTRAINT "class_credit_entries_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_credit_entries_member_id_key" UNIQUE("gym_id","member_id","id"),
	CONSTRAINT "class_credit_entries_kind_check" CHECK ("class_credit_entries"."kind" in ('grant', 'use', 'expire', 'reverse', 'adjust')),
	CONSTRAINT "class_credit_entries_sign_check" CHECK ("class_credit_entries"."credits" <> 0 and
    ("class_credit_entries"."kind" <> 'grant' or "class_credit_entries"."credits" > 0) and ("class_credit_entries"."kind" <> 'use' or "class_credit_entries"."credits" = -1) and
    ("class_credit_entries"."kind" <> 'expire' or "class_credit_entries"."credits" < 0) and
    ("class_credit_entries"."kind" <> 'reverse' or ("class_credit_entries"."sale_id" is not null and "class_credit_entries"."credits" < 0) or ("class_credit_entries"."attendance_id" is not null and "class_credit_entries"."credits" = 1))),
	CONSTRAINT "class_credit_entries_lot_check" CHECK (("class_credit_entries"."lot_id" is null) = ("class_credit_entries"."kind" = 'grant' or ("class_credit_entries"."kind" = 'adjust' and "class_credit_entries"."credits" > 0))),
	CONSTRAINT "class_credit_entries_expiry_check" CHECK ("class_credit_entries"."expires_at" is null or "class_credit_entries"."lot_id" is null),
	CONSTRAINT "class_credit_entries_source_check" CHECK (
    ("class_credit_entries"."kind" = 'grant' and "class_credit_entries"."sale_id" is not null and "class_credit_entries"."attendance_id" is null) or
    ("class_credit_entries"."kind" = 'use' and "class_credit_entries"."attendance_id" is not null and "class_credit_entries"."sale_id" is null) or
    ("class_credit_entries"."kind" = 'reverse' and (("class_credit_entries"."sale_id" is not null) <> ("class_credit_entries"."attendance_id" is not null))) or
    ("class_credit_entries"."kind" in ('expire', 'adjust') and "class_credit_entries"."sale_id" is null and "class_credit_entries"."attendance_id" is null)),
	CONSTRAINT "class_credit_entries_adjustment_check" CHECK (
    ("class_credit_entries"."kind" = 'adjust' and "class_credit_entries"."adjustment_id" is not null and "class_credit_entries"."reason" is not null and char_length("class_credit_entries"."reason") <= 500) or
    ("class_credit_entries"."kind" <> 'adjust' and "class_credit_entries"."adjustment_id" is null and "class_credit_entries"."reason" is null))
);
--> statement-breakpoint
ALTER TABLE "class_credit_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_pack_sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"credits" integer NOT NULL,
	"expiry_days" integer,
	CONSTRAINT "class_pack_sales_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_pack_sales_invoice_key" UNIQUE("gym_id","invoice_id"),
	CONSTRAINT "class_pack_sales_member_id_key" UNIQUE("gym_id","member_id","id"),
	CONSTRAINT "class_pack_sales_credits_check" CHECK ("class_pack_sales"."credits" between 1 and 100),
	CONSTRAINT "class_pack_sales_expiry_check" CHECK ("class_pack_sales"."expiry_days" is null or "class_pack_sales"."expiry_days" between 1 and 3650)
);
--> statement-breakpoint
ALTER TABLE "class_pack_sales" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_pack_tax_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pack_id" uuid NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	CONSTRAINT "class_pack_tax_rates_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_pack_tax_rates_pair_key" UNIQUE("gym_id","pack_id","tax_rate_id")
);
--> statement-breakpoint
ALTER TABLE "class_pack_tax_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_packs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"credits" integer NOT NULL,
	"expiry_days" integer,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "class_packs_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_packs_currency_check" CHECK ("class_packs"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "class_packs_amount_check" CHECK ("class_packs"."amount_cents" >= 0),
	CONSTRAINT "class_packs_credits_check" CHECK ("class_packs"."credits" between 1 and 100),
	CONSTRAINT "class_packs_expiry_check" CHECK ("class_packs"."expiry_days" is null or "class_packs"."expiry_days" between 1 and 3650),
	CONSTRAINT "class_packs_revision_check" CHECK ("class_packs"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "class_packs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "class_credit_entries" ADD CONSTRAINT "class_credit_entries_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_credit_entries" ADD CONSTRAINT "class_credit_entries_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_credit_entries" ADD CONSTRAINT "class_credit_entries_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_credit_entries" ADD CONSTRAINT "class_credit_entries_lot_fk" FOREIGN KEY ("gym_id","member_id","lot_id") REFERENCES "public"."class_credit_entries"("gym_id","member_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_credit_entries" ADD CONSTRAINT "class_credit_entries_sale_fk" FOREIGN KEY ("gym_id","member_id","sale_id") REFERENCES "public"."class_pack_sales"("gym_id","member_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_pack_sales" ADD CONSTRAINT "class_pack_sales_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_pack_sales" ADD CONSTRAINT "class_pack_sales_invoice_fk" FOREIGN KEY ("gym_id","household_id","invoice_id") REFERENCES "public"."invoices"("gym_id","household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_pack_sales" ADD CONSTRAINT "class_pack_sales_household_fk" FOREIGN KEY ("gym_id","household_id") REFERENCES "public"."households"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_pack_sales" ADD CONSTRAINT "class_pack_sales_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_pack_sales" ADD CONSTRAINT "class_pack_sales_pack_fk" FOREIGN KEY ("gym_id","pack_id") REFERENCES "public"."class_packs"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_pack_tax_rates" ADD CONSTRAINT "class_pack_tax_rates_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_pack_tax_rates" ADD CONSTRAINT "class_pack_tax_rates_pack_fk" FOREIGN KEY ("gym_id","pack_id") REFERENCES "public"."class_packs"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_pack_tax_rates" ADD CONSTRAINT "class_pack_tax_rates_tax_fk" FOREIGN KEY ("gym_id","tax_rate_id") REFERENCES "public"."tax_rates"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_packs" ADD CONSTRAINT "class_packs_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_packs" ADD CONSTRAINT "class_packs_currency_fk" FOREIGN KEY ("gym_id","currency") REFERENCES "public"."gyms"("id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "class_credit_entries_grant_sale_key" ON "class_credit_entries" USING btree ("gym_id","sale_id") WHERE "class_credit_entries"."kind" = 'grant';--> statement-breakpoint
CREATE UNIQUE INDEX "class_credit_entries_reverse_sale_key" ON "class_credit_entries" USING btree ("gym_id","sale_id") WHERE "class_credit_entries"."kind" = 'reverse' and "class_credit_entries"."sale_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "class_credit_entries_use_attendance_key" ON "class_credit_entries" USING btree ("gym_id","attendance_id") WHERE "class_credit_entries"."kind" = 'use';--> statement-breakpoint
CREATE UNIQUE INDEX "class_credit_entries_reverse_attendance_key" ON "class_credit_entries" USING btree ("gym_id","attendance_id") WHERE "class_credit_entries"."kind" = 'reverse' and "class_credit_entries"."attendance_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "class_credit_entries_expire_lot_key" ON "class_credit_entries" USING btree ("gym_id","lot_id") WHERE "class_credit_entries"."kind" = 'expire';--> statement-breakpoint
CREATE UNIQUE INDEX "class_credit_entries_adjust_lot_key" ON "class_credit_entries" USING btree ("gym_id","adjustment_id","lot_id") WHERE "class_credit_entries"."kind" = 'adjust' and "class_credit_entries"."lot_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "class_credit_entries_adjust_open_key" ON "class_credit_entries" USING btree ("gym_id","adjustment_id") WHERE "class_credit_entries"."kind" = 'adjust' and "class_credit_entries"."lot_id" is null;--> statement-breakpoint
CREATE INDEX "class_credit_entries_member_idx" ON "class_credit_entries" USING btree ("gym_id","member_id","created_at");--> statement-breakpoint
CREATE INDEX "class_credit_entries_expiry_idx" ON "class_credit_entries" USING btree ("gym_id","expires_at") WHERE "class_credit_entries"."lot_id" is null;--> statement-breakpoint
CREATE POLICY "class_credit_entries_gym_policy" ON "class_credit_entries" AS PERMISSIVE FOR ALL TO "app" USING ("class_credit_entries"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_credit_entries"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "class_pack_sales_gym_policy" ON "class_pack_sales" AS PERMISSIVE FOR ALL TO "app" USING ("class_pack_sales"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_pack_sales"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "class_pack_tax_rates_gym_policy" ON "class_pack_tax_rates" AS PERMISSIVE FOR ALL TO "app" USING ("class_pack_tax_rates"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_pack_tax_rates"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "class_packs_gym_policy" ON "class_packs" AS PERMISSIVE FOR ALL TO "app" USING ("class_packs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_packs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);
