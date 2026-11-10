-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "announcement_opt_outs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "announcement_opt_outs_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "announcement_opt_outs_member_key" UNIQUE("gym_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "announcement_opt_outs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "announcement_recipients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"announcement_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_recipients_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "announcement_recipients_member_key" UNIQUE("gym_id","announcement_id","member_id"),
	CONSTRAINT "announcement_recipients_state_check" CHECK ("announcement_recipients"."state" in ('pending', 'sent', 'failed', 'skipped')),
	CONSTRAINT "announcement_recipients_reason_check" CHECK ("announcement_recipients"."reason" in ('opt_out', 'undeliverable', 'disabled', 'anonymized', 'ineligible', 'missing_email', 'duplicate_address', 'not_accepted', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "announcement_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"audience" jsonb NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "announcements_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "announcements_subject_check" CHECK (char_length("announcements"."subject") between 1 and 150),
	CONSTRAINT "announcements_body_check" CHECK (char_length("announcements"."body") between 1 and 10000),
	CONSTRAINT "announcements_audience_check" CHECK (jsonb_typeof("announcements"."audience") = 'object'
    and coalesce(jsonb_typeof("announcements"."audience"->'statuses') = 'array', false)
    and coalesce(jsonb_typeof("announcements"."audience"->'programIds') = 'array', false)),
	CONSTRAINT "announcements_recipient_count_check" CHECK ("announcements"."recipient_count" >= 0),
	CONSTRAINT "announcements_status_check" CHECK ("announcements"."status" in ('sending', 'sent'))
);
--> statement-breakpoint
ALTER TABLE "announcements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signed_links" DROP CONSTRAINT "signed_links_purpose_check";--> statement-breakpoint
ALTER TABLE "signed_links" DROP CONSTRAINT "signed_links_resource_check";--> statement-breakpoint
ALTER TABLE "announcement_opt_outs" ADD CONSTRAINT "announcement_opt_outs_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_opt_outs" ADD CONSTRAINT "announcement_opt_outs_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_announcement_fk" FOREIGN KEY ("gym_id","announcement_id") REFERENCES "public"."announcements"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcement_recipients_scan_idx" ON "announcement_recipients" USING btree ("gym_id","announcement_id","state","id");--> statement-breakpoint
ALTER TABLE "signed_links" ADD CONSTRAINT "signed_links_purpose_check" CHECK ("signed_links"."purpose" in ('onboarding', 'pay_invoice', 'update_card', 'sign_waiver', 'unsubscribe'));--> statement-breakpoint
ALTER TABLE "signed_links" ADD CONSTRAINT "signed_links_resource_check" CHECK (
    ("signed_links"."purpose" = 'pay_invoice' and "signed_links"."invoice_id" is not null and "signed_links"."member_id" is null)
    or ("signed_links"."purpose" in ('sign_waiver', 'unsubscribe') and "signed_links"."member_id" is not null and "signed_links"."invoice_id" is null)
    or ("signed_links"."purpose" in ('update_card', 'onboarding') and "signed_links"."invoice_id" is null and "signed_links"."member_id" is null)
  );--> statement-breakpoint
CREATE POLICY "announcement_opt_outs_gym_policy" ON "announcement_opt_outs" AS PERMISSIVE FOR ALL TO "app" USING ("announcement_opt_outs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("announcement_opt_outs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "announcement_recipients_gym_policy" ON "announcement_recipients" AS PERMISSIVE FOR ALL TO "app" USING ("announcement_recipients"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("announcement_recipients"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "announcements_gym_policy" ON "announcements" AS PERMISSIVE FOR ALL TO "app" USING ("announcements"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("announcements"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);
