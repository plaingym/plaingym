-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "invoice_line_items" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "scheduled_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "scheduled_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "scheduled_interval" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "scheduled_on" date;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "switch_override_reason" text;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_plan_fk" FOREIGN KEY ("gym_id","plan_id") REFERENCES "public"."plans"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_scheduled_plan_fk" FOREIGN KEY ("gym_id","scheduled_plan_id") REFERENCES "public"."plans"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_plan_check" CHECK ("invoice_line_items"."plan_id" is null or "invoice_line_items"."kind" in ('membership', 'signup_fee'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_scheduled_check" CHECK (("memberships"."scheduled_plan_id" is null and "memberships"."scheduled_amount_cents" is null and "memberships"."scheduled_interval" is null and "memberships"."scheduled_on" is null)
    or ("memberships"."scheduled_plan_id" is not null and "memberships"."scheduled_amount_cents" is not null and "memberships"."scheduled_amount_cents" >= 0
      and "memberships"."scheduled_interval" in ('monthly', 'annual') and "memberships"."scheduled_on" is not null));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_switch_override_reason_check" CHECK ("memberships"."switch_override_reason" is null or char_length("memberships"."switch_override_reason") between 1 and 500);