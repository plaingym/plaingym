-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "lead_contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lead_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"channel" text NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	CONSTRAINT "lead_contacts_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "lead_contacts_channel_check" CHECK ("lead_contacts"."channel" in ('call', 'text', 'email', 'in_person', 'other')),
	CONSTRAINT "lead_contacts_note_check" CHECK (char_length("lead_contacts"."note") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "lead_contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"source" text,
	"stage" text DEFAULT 'new' NOT NULL,
	"lost_reason" text,
	"next_follow_up_on" date,
	"last_contacted_at" timestamp with time zone,
	"trial_attended_at" timestamp with time zone,
	"won_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "leads_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "leads_member_key" UNIQUE("gym_id","member_id"),
	CONSTRAINT "leads_source_check" CHECK ("leads"."source" in ('trial_form', 'join', 'drop_in', 'walk_in', 'referral', 'phone', 'other')),
	CONSTRAINT "leads_stage_check" CHECK ("leads"."stage" in ('new', 'contacted', 'trial_booked', 'trial_attended', 'won', 'lost')),
	CONSTRAINT "leads_lost_reason_check" CHECK (char_length("leads"."lost_reason") <= 500),
	CONSTRAINT "leads_lost_at_check" CHECK ("leads"."stage" <> 'lost' or "leads"."lost_at" is not null),
	CONSTRAINT "leads_won_at_check" CHECK ("leads"."stage" <> 'won' or "leads"."won_at" is not null),
	CONSTRAINT "leads_revision_check" CHECK ("leads"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lead_contacts" ADD CONSTRAINT "lead_contacts_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_contacts" ADD CONSTRAINT "lead_contacts_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_contacts" ADD CONSTRAINT "lead_contacts_lead_fk" FOREIGN KEY ("gym_id","lead_id") REFERENCES "public"."leads"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_contacts_lead_idx" ON "lead_contacts" USING btree ("gym_id","lead_id","occurred_at");--> statement-breakpoint
CREATE INDEX "leads_stage_idx" ON "leads" USING btree ("gym_id","stage");--> statement-breakpoint
CREATE INDEX "leads_follow_up_idx" ON "leads" USING btree ("gym_id","next_follow_up_on") WHERE "leads"."stage" not in ('won', 'lost');--> statement-breakpoint
CREATE POLICY "lead_contacts_gym_policy" ON "lead_contacts" AS PERMISSIVE FOR ALL TO "app" USING ("lead_contacts"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("lead_contacts"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "leads_gym_policy" ON "leads" AS PERMISSIVE FOR ALL TO "app" USING ("leads"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("leads"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);
