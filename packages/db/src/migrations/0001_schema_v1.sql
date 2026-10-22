-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE "gym_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"kind" text DEFAULT 'custom' NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "gym_domains_hostname_key" UNIQUE("hostname"),
	CONSTRAINT "gym_domains_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "gym_domains_kind_check" CHECK ("gym_domains"."kind" in ('default', 'custom')),
	CONSTRAINT "gym_domains_hostname_check" CHECK ("gym_domains"."hostname" = lower("gym_domains"."hostname") and "gym_domains"."hostname" <> '')
);
--> statement-breakpoint
CREATE TABLE "gyms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"website_enabled" boolean DEFAULT false NOT NULL,
	"existing_site_url" text,
	"stripe_config_encrypted" text,
	"smtp_config_encrypted" text,
	"s3_config_encrypted" text,
	"qr_key_encrypted" text,
	"backup_destination" jsonb,
	"backup_public_key" text,
	"backup_blob_key_encrypted" text,
	"backup_retention_bytes" bigint,
	"billing_enabled" boolean DEFAULT false NOT NULL,
	"member_emails_enabled" boolean DEFAULT false NOT NULL,
	"booking_window_days" integer DEFAULT 14 NOT NULL,
	"cancellation_cutoff_minutes" integer DEFAULT 60 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gyms_slug_key" UNIQUE("slug"),
	CONSTRAINT "gyms_status_check" CHECK ("gyms"."status" in ('active', 'suspended')),
	CONSTRAINT "gyms_limits_check" CHECK ("gyms"."booking_window_days" >= 0 and "gyms"."cancellation_cutoff_minutes" >= 0 and "gyms"."backup_retention_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	CONSTRAINT "auth_account_provider_account_key" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_rate_limit_key_key" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gym_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "auth_session_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	CONSTRAINT "auth_user_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"member_id" uuid,
	CONSTRAINT "household_users_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "household_users_gym_household_user_key" UNIQUE("gym_id","household_id","user_id"),
	CONSTRAINT "household_users_scope_check" CHECK ("household_users"."scope" in ('payer', 'member')),
	CONSTRAINT "household_users_member_scope_check" CHECK ("household_users"."scope" <> 'member' or "household_users"."member_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "household_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"billing_day" integer DEFAULT 1 NOT NULL,
	"stripe_customer_id" text,
	"default_payment_method_id" text,
	"pin_hash" text,
	"family_discount_basis_points" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "households_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "households_gym_stripe_customer_key" UNIQUE("gym_id","stripe_customer_id"),
	CONSTRAINT "households_billing_day_check" CHECK ("households"."billing_day" between 1 and 31),
	CONSTRAINT "households_discount_check" CHECK ("households"."family_discount_basis_points" between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "households" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "member_tag_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "member_tag_links_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "member_tag_links_pair_key" UNIQUE("gym_id","member_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "member_tag_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "member_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"color" text,
	CONSTRAINT "member_tags_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "member_tags_gym_name_key" UNIQUE("gym_id","name")
);
--> statement-breakpoint
ALTER TABLE "member_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"household_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"photo_key" text,
	"date_of_birth" date,
	"status" text DEFAULT 'prospect' NOT NULL,
	"emergency_contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"medical_notes" text,
	"email_opt_out" boolean DEFAULT false NOT NULL,
	"email_deliverable" boolean DEFAULT true NOT NULL,
	"checkin_code_version" integer DEFAULT 1 NOT NULL,
	"checkin_code_hash" text,
	"anonymized_at" timestamp with time zone,
	CONSTRAINT "members_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "members_gym_household_id_key" UNIQUE("gym_id","household_id","id"),
	CONSTRAINT "members_gym_checkin_hash_key" UNIQUE("gym_id","checkin_code_hash"),
	CONSTRAINT "members_status_check" CHECK ("members"."status" in ('prospect', 'trial', 'active', 'frozen', 'cancelled', 'visitor')),
	CONSTRAINT "members_checkin_version_check" CHECK ("members"."checkin_code_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"member_id" uuid,
	"display_name" text NOT NULL,
	"bio" text,
	"photo_key" text,
	"rank" text,
	"is_public" boolean DEFAULT false NOT NULL,
	CONSTRAINT "staff_profiles_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "staff_profiles_gym_user_key" UNIQUE("gym_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "staff_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "staff_roles_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "staff_roles_gym_user_key" UNIQUE("gym_id","user_id"),
	CONSTRAINT "staff_roles_role_check" CHECK ("staff_roles"."role" in ('owner', 'admin', 'coach', 'front_desk'))
);
--> statement-breakpoint
ALTER TABLE "staff_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "installed_packs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pack_id" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "installed_packs_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "installed_packs_version_key" UNIQUE("gym_id","pack_id","version"),
	CONSTRAINT "installed_packs_version_check" CHECK ("installed_packs"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "installed_packs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "member_ranks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"rank_id" uuid NOT NULL,
	"sub_rank" integer DEFAULT 0 NOT NULL,
	"promoted_at" timestamp with time zone NOT NULL,
	"promoted_by" uuid,
	"notes" text,
	CONSTRAINT "member_ranks_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "member_ranks_sub_rank_check" CHECK ("member_ranks"."sub_rank" >= 0)
);
--> statement-breakpoint
ALTER TABLE "member_ranks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"rank_system_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "programs_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "programs_gym_name_key" UNIQUE("gym_id","name")
);
--> statement-breakpoint
ALTER TABLE "programs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rank_systems" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"installed_pack_id" uuid,
	CONSTRAINT "rank_systems_gym_id_id_key" UNIQUE("gym_id","id")
);
--> statement-breakpoint
ALTER TABLE "rank_systems" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ranks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rank_system_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"sub_ranks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "ranks_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "ranks_gym_system_position_key" UNIQUE("gym_id","rank_system_id","position"),
	CONSTRAINT "ranks_position_check" CHECK ("ranks"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ranks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attendances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"session_id" uuid,
	"program_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"source_key" text,
	CONSTRAINT "attendances_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "attendances_session_member_key" UNIQUE("gym_id","session_id","member_id"),
	CONSTRAINT "attendances_source_key" UNIQUE("gym_id","source_key"),
	CONSTRAINT "attendances_source_check" CHECK ("attendances"."source" in ('kiosk', 'coach', 'import'))
);
--> statement-breakpoint
ALTER TABLE "attendances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_bookings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"waitlist_position" integer,
	"booked_by" uuid NOT NULL,
	"booked_by_kind" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "class_bookings_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_bookings_status_check" CHECK ("class_bookings"."status" in ('booked', 'waitlisted', 'cancelled')),
	CONSTRAINT "class_bookings_actor_check" CHECK ("class_bookings"."booked_by_kind" in ('member', 'staff')),
	CONSTRAINT "class_bookings_waitlist_check" CHECK (("class_bookings"."status" = 'waitlisted' and "class_bookings"."waitlist_position" is not null and "class_bookings"."waitlist_position" > 0) or ("class_bookings"."status" <> 'waitlisted' and "class_bookings"."waitlist_position" is null))
);
--> statement-breakpoint
ALTER TABLE "class_bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_session_programs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	CONSTRAINT "class_session_programs_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_session_programs_pair_key" UNIQUE("gym_id","session_id","program_id")
);
--> statement-breakpoint
ALTER TABLE "class_session_programs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_session_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "class_session_tags_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_session_tags_pair_key" UNIQUE("gym_id","session_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "class_session_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"template_id" uuid,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"coach_id" uuid,
	"capacity" integer,
	"notes" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	CONSTRAINT "class_sessions_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_sessions_materialized_key" UNIQUE("gym_id","template_id","starts_at"),
	CONSTRAINT "class_sessions_times_check" CHECK ("class_sessions"."ends_at" > "class_sessions"."starts_at"),
	CONSTRAINT "class_sessions_capacity_check" CHECK ("class_sessions"."capacity" > 0),
	CONSTRAINT "class_sessions_status_check" CHECK ("class_sessions"."status" in ('scheduled', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "class_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "class_tags_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_tags_name_key" UNIQUE("gym_id","name")
);
--> statement-breakpoint
ALTER TABLE "class_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_template_programs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"template_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	CONSTRAINT "class_template_programs_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_template_programs_pair_key" UNIQUE("gym_id","template_id","program_id")
);
--> statement-breakpoint
ALTER TABLE "class_template_programs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_template_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"template_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "class_template_tags_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_template_tags_pair_key" UNIQUE("gym_id","template_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "class_template_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"weekday" integer NOT NULL,
	"local_start_time" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"coach_id" uuid,
	"capacity" integer,
	"notes" text,
	CONSTRAINT "class_templates_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "class_templates_schedule_check" CHECK ("class_templates"."weekday" between 0 and 6 and "class_templates"."duration_minutes" > 0 and "class_templates"."local_start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "class_templates_capacity_check" CHECK ("class_templates"."capacity" > 0)
);
--> statement-breakpoint
ALTER TABLE "class_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "charge_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"tax_rate_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "charge_types_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "charge_types_currency_check" CHECK ("charge_types"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "charge_types_amount_check" CHECK ("charge_types"."amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "charge_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"household_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"membership_id" uuid,
	"charge_type_id" uuid,
	"tax_rate_id" uuid,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invoice_line_items_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "invoice_line_items_kind_check" CHECK ("invoice_line_items"."kind" in ('membership', 'signup_fee', 'charge', 'discount', 'tax')),
	CONSTRAINT "invoice_line_items_currency_check" CHECK ("invoice_line_items"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "invoice_line_items_quantity_check" CHECK ("invoice_line_items"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"household_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"due_on" date NOT NULL,
	"period_starts_on" date,
	"period_ends_on" date,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"paid_at" timestamp with time zone,
	"checkout_session_id" text,
	"checkout_expires_at" timestamp with time zone,
	"needs_review" boolean DEFAULT false NOT NULL,
	"dispute_id" text,
	"dispute_status" text,
	CONSTRAINT "invoices_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "invoices_gym_household_id_key" UNIQUE("gym_id","household_id","id"),
	CONSTRAINT "invoices_kind_check" CHECK ("invoices"."kind" in ('cycle', 'one_off')),
	CONSTRAINT "invoices_status_check" CHECK ("invoices"."status" in ('draft', 'open', 'processing', 'past_due', 'paid', 'void', 'partially_refunded', 'refunded')),
	CONSTRAINT "invoices_currency_check" CHECK ("invoices"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "invoices_amount_check" CHECK ("invoices"."amount_cents" >= 0),
	CONSTRAINT "invoices_period_check" CHECK ("invoices"."kind" <> 'cycle' or ("invoices"."period_starts_on" is not null and "invoices"."period_ends_on" is not null and "invoices"."period_ends_on" > "invoices"."period_starts_on"))
);
--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"household_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"interval" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"next_due_on" date NOT NULL,
	"starts_on" date NOT NULL,
	"trial_ends_on" date,
	"frozen_at" timestamp with time zone,
	"resumes_on" date,
	"cancelled_at" timestamp with time zone,
	"commitment_ends_at" timestamp with time zone,
	CONSTRAINT "memberships_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "memberships_gym_household_id_key" UNIQUE("gym_id","household_id","id"),
	CONSTRAINT "memberships_status_check" CHECK ("memberships"."status" in ('pending', 'trial', 'active', 'frozen', 'cancelled')),
	CONSTRAINT "memberships_interval_check" CHECK ("memberships"."interval" in ('monthly', 'annual')),
	CONSTRAINT "memberships_currency_check" CHECK ("memberships"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "memberships_amount_check" CHECK ("memberships"."amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"saved_payment_method" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"payment_intent_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decline_code" text,
	"error" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "payment_attempts_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "payment_attempts_number_key" UNIQUE("gym_id","invoice_id","attempt_number"),
	CONSTRAINT "payment_attempts_intent_key" UNIQUE("gym_id","payment_intent_id"),
	CONSTRAINT "payment_attempts_status_check" CHECK ("payment_attempts"."status" in ('pending', 'succeeded', 'failed', 'requires_action')),
	CONSTRAINT "payment_attempts_currency_check" CHECK ("payment_attempts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payment_attempts_amount_check" CHECK ("payment_attempts"."amount_cents" >= 0 and "payment_attempts"."attempt_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"household_id" uuid NOT NULL,
	"processor_id" text NOT NULL,
	"brand" text,
	"last4" text,
	"expiry_month" integer,
	"expiry_year" integer,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "payment_methods_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "payment_methods_processor_key" UNIQUE("gym_id","processor_id"),
	CONSTRAINT "payment_methods_gym_household_id_key" UNIQUE("gym_id","household_id","id"),
	CONSTRAINT "payment_methods_last4_check" CHECK ("payment_methods"."last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "payment_methods_expiry_check" CHECK ("payment_methods"."expiry_month" between 1 and 12 and "payment_methods"."expiry_year" >= 2000)
);
--> statement-breakpoint
ALTER TABLE "payment_methods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"payment_intent_id" text,
	"charge_id" text,
	"reference" text,
	"paid_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "payments_intent_key" UNIQUE("gym_id","payment_intent_id"),
	CONSTRAINT "payments_charge_key" UNIQUE("gym_id","charge_id"),
	CONSTRAINT "payments_method_check" CHECK ("payments"."method" in ('card', 'cash', 'check', 'other')),
	CONSTRAINT "payments_currency_check" CHECK ("payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"interval" text NOT NULL,
	"signup_fee_cents" integer DEFAULT 0 NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"tax_rate_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "plans_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "plans_currency_check" CHECK ("plans"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "plans_interval_check" CHECK ("plans"."interval" in ('monthly', 'annual')),
	CONSTRAINT "plans_amount_check" CHECK ("plans"."amount_cents" >= 0 and "plans"."signup_fee_cents" >= 0 and "plans"."trial_days" >= 0)
);
--> statement-breakpoint
ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"processor_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "refunds_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "refunds_processor_key" UNIQUE("gym_id","processor_id"),
	CONSTRAINT "refunds_status_check" CHECK ("refunds"."status" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "refunds_currency_check" CHECK ("refunds"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "refunds_amount_check" CHECK ("refunds"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"basis_points" integer NOT NULL,
	"inclusive" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "tax_rates_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "tax_rates_percentage_check" CHECK ("tax_rates"."basis_points" between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "tax_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "waiver_signatures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"member_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"snapshot" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"signature_image_key" text NOT NULL,
	"signature_image_hash" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"ip_address" text NOT NULL,
	CONSTRAINT "waiver_signatures_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "waiver_signatures_hash_check" CHECK ("waiver_signatures"."snapshot_hash" ~ '^[a-f0-9]{64}$' and "waiver_signatures"."signature_image_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "waiver_signatures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "waiver_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'waiver' NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "waiver_templates_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "waiver_templates_version_key" UNIQUE("gym_id","name","version"),
	CONSTRAINT "waiver_templates_kind_check" CHECK ("waiver_templates"."kind" in ('waiver', 'agreement')),
	CONSTRAINT "waiver_templates_version_check" CHECK ("waiver_templates"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "waiver_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kiosk_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "kiosk_devices_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "kiosk_devices_hash_key" UNIQUE("gym_id","token_hash")
);
--> statement-breakpoint
ALTER TABLE "kiosk_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "link_campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"created_by" uuid,
	"reminder_schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "link_campaigns_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "link_campaigns_purpose_check" CHECK ("link_campaigns"."purpose" in ('onboarding', 'pay_invoice', 'update_card', 'sign_waiver'))
);
--> statement-breakpoint
ALTER TABLE "link_campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "signed_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"household_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"invoice_id" uuid,
	"member_id" uuid,
	"campaign_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	CONSTRAINT "signed_links_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "signed_links_hash_key" UNIQUE("gym_id","token_hash"),
	CONSTRAINT "signed_links_purpose_check" CHECK ("signed_links"."purpose" in ('onboarding', 'pay_invoice', 'update_card', 'sign_waiver')),
	CONSTRAINT "signed_links_resource_check" CHECK (
    ("signed_links"."purpose" = 'pay_invoice' and "signed_links"."invoice_id" is not null and "signed_links"."member_id" is null)
    or ("signed_links"."purpose" = 'sign_waiver' and "signed_links"."member_id" is not null and "signed_links"."invoice_id" is null)
    or ("signed_links"."purpose" in ('update_card', 'onboarding') and "signed_links"."invoice_id" is null and "signed_links"."member_id" is null)
  ),
	CONSTRAINT "signed_links_hash_check" CHECK ("signed_links"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "signed_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"snapshot_bytes" bigint,
	"upload_bytes" bigint,
	"object_prefix" text NOT NULL,
	"error" text,
	CONSTRAINT "backup_runs_prefix_key" UNIQUE("object_prefix"),
	CONSTRAINT "backup_runs_kind_check" CHECK ("backup_runs"."kind" in ('hourly', 'nightly', 'weekly', 'pre_upgrade', 'manual')),
	CONSTRAINT "backup_runs_status_check" CHECK ("backup_runs"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "backup_runs_sizes_check" CHECK ("backup_runs"."snapshot_bytes" >= 0 and "backup_runs"."upload_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid,
	"name" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"locked_until" timestamp with time zone,
	"lock_token" uuid,
	"last_error" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key" UNIQUE NULLS NOT DISTINCT("gym_id","idempotency_key"),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" >= 0 and "jobs"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"gym_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "stripe_events_event_key" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_events_gym_id_id_key" UNIQUE("gym_id","id"),
	CONSTRAINT "audit_events_actor_check" CHECK ("audit_events"."actor_kind" in ('user', 'system', 'device'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "email_outbox_gym_id_id_key" UNIQUE("gym_id","id")
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gym_domains" ADD CONSTRAINT "gym_domains_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_users" ADD CONSTRAINT "household_users_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_users" ADD CONSTRAINT "household_users_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_users" ADD CONSTRAINT "household_users_household_fk" FOREIGN KEY ("gym_id","household_id") REFERENCES "public"."households"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_users" ADD CONSTRAINT "household_users_member_fk" FOREIGN KEY ("gym_id","household_id","member_id") REFERENCES "public"."members"("gym_id","household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_tag_links" ADD CONSTRAINT "member_tag_links_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_tag_links" ADD CONSTRAINT "member_tag_links_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_tag_links" ADD CONSTRAINT "member_tag_links_tag_fk" FOREIGN KEY ("gym_id","tag_id") REFERENCES "public"."member_tags"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_tags" ADD CONSTRAINT "member_tags_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_household_fk" FOREIGN KEY ("gym_id","household_id") REFERENCES "public"."households"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_packs" ADD CONSTRAINT "installed_packs_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_ranks" ADD CONSTRAINT "member_ranks_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_ranks" ADD CONSTRAINT "member_ranks_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_ranks" ADD CONSTRAINT "member_ranks_program_fk" FOREIGN KEY ("gym_id","program_id") REFERENCES "public"."programs"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_ranks" ADD CONSTRAINT "member_ranks_rank_fk" FOREIGN KEY ("gym_id","rank_id") REFERENCES "public"."ranks"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_ranks" ADD CONSTRAINT "member_ranks_staff_fk" FOREIGN KEY ("gym_id","promoted_by") REFERENCES "public"."staff_profiles"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_rank_system_fk" FOREIGN KEY ("gym_id","rank_system_id") REFERENCES "public"."rank_systems"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_systems" ADD CONSTRAINT "rank_systems_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_systems" ADD CONSTRAINT "rank_systems_pack_fk" FOREIGN KEY ("gym_id","installed_pack_id") REFERENCES "public"."installed_packs"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranks" ADD CONSTRAINT "ranks_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranks" ADD CONSTRAINT "ranks_system_fk" FOREIGN KEY ("gym_id","rank_system_id") REFERENCES "public"."rank_systems"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_session_fk" FOREIGN KEY ("gym_id","session_id") REFERENCES "public"."class_sessions"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_program_fk" FOREIGN KEY ("gym_id","program_id") REFERENCES "public"."programs"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD CONSTRAINT "class_bookings_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD CONSTRAINT "class_bookings_booked_by_auth_user_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD CONSTRAINT "class_bookings_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD CONSTRAINT "class_bookings_session_fk" FOREIGN KEY ("gym_id","session_id") REFERENCES "public"."class_sessions"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_session_programs" ADD CONSTRAINT "class_session_programs_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_session_programs" ADD CONSTRAINT "class_session_programs_session_fk" FOREIGN KEY ("gym_id","session_id") REFERENCES "public"."class_sessions"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_session_programs" ADD CONSTRAINT "class_session_programs_program_fk" FOREIGN KEY ("gym_id","program_id") REFERENCES "public"."programs"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_session_tags" ADD CONSTRAINT "class_session_tags_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_session_tags" ADD CONSTRAINT "class_session_tags_session_fk" FOREIGN KEY ("gym_id","session_id") REFERENCES "public"."class_sessions"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_session_tags" ADD CONSTRAINT "class_session_tags_tag_fk" FOREIGN KEY ("gym_id","tag_id") REFERENCES "public"."class_tags"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_template_fk" FOREIGN KEY ("gym_id","template_id") REFERENCES "public"."class_templates"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_coach_fk" FOREIGN KEY ("gym_id","coach_id") REFERENCES "public"."staff_profiles"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_tags" ADD CONSTRAINT "class_tags_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_template_programs" ADD CONSTRAINT "class_template_programs_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_template_programs" ADD CONSTRAINT "class_template_programs_template_fk" FOREIGN KEY ("gym_id","template_id") REFERENCES "public"."class_templates"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_template_programs" ADD CONSTRAINT "class_template_programs_program_fk" FOREIGN KEY ("gym_id","program_id") REFERENCES "public"."programs"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_template_tags" ADD CONSTRAINT "class_template_tags_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_template_tags" ADD CONSTRAINT "class_template_tags_template_fk" FOREIGN KEY ("gym_id","template_id") REFERENCES "public"."class_templates"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_template_tags" ADD CONSTRAINT "class_template_tags_tag_fk" FOREIGN KEY ("gym_id","tag_id") REFERENCES "public"."class_tags"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_templates" ADD CONSTRAINT "class_templates_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_templates" ADD CONSTRAINT "class_templates_coach_fk" FOREIGN KEY ("gym_id","coach_id") REFERENCES "public"."staff_profiles"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_types" ADD CONSTRAINT "charge_types_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_types" ADD CONSTRAINT "charge_types_tax_fk" FOREIGN KEY ("gym_id","tax_rate_id") REFERENCES "public"."tax_rates"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_fk" FOREIGN KEY ("gym_id","household_id","invoice_id") REFERENCES "public"."invoices"("gym_id","household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_membership_fk" FOREIGN KEY ("gym_id","household_id","membership_id") REFERENCES "public"."memberships"("gym_id","household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_charge_type_fk" FOREIGN KEY ("gym_id","charge_type_id") REFERENCES "public"."charge_types"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_tax_fk" FOREIGN KEY ("gym_id","tax_rate_id") REFERENCES "public"."tax_rates"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_household_fk" FOREIGN KEY ("gym_id","household_id") REFERENCES "public"."households"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_household_fk" FOREIGN KEY ("gym_id","household_id") REFERENCES "public"."households"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_member_fk" FOREIGN KEY ("gym_id","household_id","member_id") REFERENCES "public"."members"("gym_id","household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_plan_fk" FOREIGN KEY ("gym_id","plan_id") REFERENCES "public"."plans"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_invoice_fk" FOREIGN KEY ("gym_id","invoice_id") REFERENCES "public"."invoices"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_household_fk" FOREIGN KEY ("gym_id","household_id") REFERENCES "public"."households"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_fk" FOREIGN KEY ("gym_id","invoice_id") REFERENCES "public"."invoices"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_tax_fk" FOREIGN KEY ("gym_id","tax_rate_id") REFERENCES "public"."tax_rates"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_fk" FOREIGN KEY ("gym_id","payment_id") REFERENCES "public"."payments"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_signatures" ADD CONSTRAINT "waiver_signatures_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_signatures" ADD CONSTRAINT "waiver_signatures_member_fk" FOREIGN KEY ("gym_id","member_id") REFERENCES "public"."members"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_signatures" ADD CONSTRAINT "waiver_signatures_template_fk" FOREIGN KEY ("gym_id","template_id") REFERENCES "public"."waiver_templates"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiver_templates" ADD CONSTRAINT "waiver_templates_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_devices" ADD CONSTRAINT "kiosk_devices_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_campaigns" ADD CONSTRAINT "link_campaigns_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_campaigns" ADD CONSTRAINT "link_campaigns_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_links" ADD CONSTRAINT "signed_links_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_links" ADD CONSTRAINT "signed_links_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_links" ADD CONSTRAINT "signed_links_household_fk" FOREIGN KEY ("gym_id","household_id") REFERENCES "public"."households"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_links" ADD CONSTRAINT "signed_links_campaign_fk" FOREIGN KEY ("gym_id","campaign_id") REFERENCES "public"."link_campaigns"("gym_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_links" ADD CONSTRAINT "signed_links_invoice_fk" FOREIGN KEY ("gym_id","household_id","invoice_id") REFERENCES "public"."invoices"("gym_id","household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_links" ADD CONSTRAINT "signed_links_member_fk" FOREIGN KEY ("gym_id","household_id","member_id") REFERENCES "public"."members"("gym_id","household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_auth_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_gym_user_idx" ON "auth_session" USING btree ("gym_id","user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "members_gym_status_idx" ON "members" USING btree ("gym_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "class_bookings_active_key" ON "class_bookings" USING btree ("gym_id","session_id","member_id") WHERE "class_bookings"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "class_bookings_waitlist_key" ON "class_bookings" USING btree ("gym_id","session_id","waitlist_position") WHERE "class_bookings"."status" = 'waitlisted';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_cycle_key" ON "invoices" USING btree ("gym_id","household_id","kind","due_on") WHERE "invoices"."kind" = 'cycle';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_pending_key" ON "payment_attempts" USING btree ("gym_id","invoice_id") WHERE "payment_attempts"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "jobs_gym_status_idx" ON "jobs" USING btree ("gym_id","status");--> statement-breakpoint
CREATE INDEX "stripe_events_gym_received_idx" ON "stripe_events" USING btree ("gym_id","received_at");--> statement-breakpoint
CREATE INDEX "audit_events_gym_time_idx" ON "audit_events" USING btree ("gym_id","occurred_at");--> statement-breakpoint
CREATE INDEX "email_outbox_gym_time_idx" ON "email_outbox" USING btree ("gym_id","sent_at");--> statement-breakpoint
CREATE POLICY "household_users_gym_policy" ON "household_users" AS PERMISSIVE FOR ALL TO "app" USING ("household_users"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("household_users"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "households_gym_policy" ON "households" AS PERMISSIVE FOR ALL TO "app" USING ("households"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("households"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "member_tag_links_gym_policy" ON "member_tag_links" AS PERMISSIVE FOR ALL TO "app" USING ("member_tag_links"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("member_tag_links"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "member_tags_gym_policy" ON "member_tags" AS PERMISSIVE FOR ALL TO "app" USING ("member_tags"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("member_tags"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "members_gym_policy" ON "members" AS PERMISSIVE FOR ALL TO "app" USING ("members"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("members"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "staff_profiles_gym_policy" ON "staff_profiles" AS PERMISSIVE FOR ALL TO "app" USING ("staff_profiles"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("staff_profiles"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "staff_roles_gym_policy" ON "staff_roles" AS PERMISSIVE FOR ALL TO "app" USING ("staff_roles"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("staff_roles"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "installed_packs_gym_policy" ON "installed_packs" AS PERMISSIVE FOR ALL TO "app" USING ("installed_packs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("installed_packs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "member_ranks_gym_policy" ON "member_ranks" AS PERMISSIVE FOR ALL TO "app" USING ("member_ranks"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("member_ranks"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "programs_gym_policy" ON "programs" AS PERMISSIVE FOR ALL TO "app" USING ("programs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("programs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "rank_systems_gym_policy" ON "rank_systems" AS PERMISSIVE FOR ALL TO "app" USING ("rank_systems"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("rank_systems"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ranks_gym_policy" ON "ranks" AS PERMISSIVE FOR ALL TO "app" USING ("ranks"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("ranks"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "attendances_gym_policy" ON "attendances" AS PERMISSIVE FOR ALL TO "app" USING ("attendances"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("attendances"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "class_bookings_gym_policy" ON "class_bookings" AS PERMISSIVE FOR ALL TO "app" USING ("class_bookings"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_bookings"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "class_session_programs_gym_policy" ON "class_session_programs" AS PERMISSIVE FOR ALL TO "app" USING ("class_session_programs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_session_programs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "class_session_tags_gym_policy" ON "class_session_tags" AS PERMISSIVE FOR ALL TO "app" USING ("class_session_tags"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_session_tags"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "class_sessions_gym_policy" ON "class_sessions" AS PERMISSIVE FOR ALL TO "app" USING ("class_sessions"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_sessions"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "class_tags_gym_policy" ON "class_tags" AS PERMISSIVE FOR ALL TO "app" USING ("class_tags"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_tags"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "class_template_programs_gym_policy" ON "class_template_programs" AS PERMISSIVE FOR ALL TO "app" USING ("class_template_programs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_template_programs"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "class_template_tags_gym_policy" ON "class_template_tags" AS PERMISSIVE FOR ALL TO "app" USING ("class_template_tags"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_template_tags"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "class_templates_gym_policy" ON "class_templates" AS PERMISSIVE FOR ALL TO "app" USING ("class_templates"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("class_templates"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "charge_types_gym_policy" ON "charge_types" AS PERMISSIVE FOR ALL TO "app" USING ("charge_types"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("charge_types"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "invoice_line_items_gym_policy" ON "invoice_line_items" AS PERMISSIVE FOR ALL TO "app" USING ("invoice_line_items"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("invoice_line_items"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "invoices_gym_policy" ON "invoices" AS PERMISSIVE FOR ALL TO "app" USING ("invoices"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("invoices"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "memberships_gym_policy" ON "memberships" AS PERMISSIVE FOR ALL TO "app" USING ("memberships"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("memberships"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_attempts_gym_policy" ON "payment_attempts" AS PERMISSIVE FOR ALL TO "app" USING ("payment_attempts"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("payment_attempts"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_methods_gym_policy" ON "payment_methods" AS PERMISSIVE FOR ALL TO "app" USING ("payment_methods"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("payment_methods"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payments_gym_policy" ON "payments" AS PERMISSIVE FOR ALL TO "app" USING ("payments"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("payments"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "plans_gym_policy" ON "plans" AS PERMISSIVE FOR ALL TO "app" USING ("plans"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("plans"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "refunds_gym_policy" ON "refunds" AS PERMISSIVE FOR ALL TO "app" USING ("refunds"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("refunds"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rates_gym_policy" ON "tax_rates" AS PERMISSIVE FOR ALL TO "app" USING ("tax_rates"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("tax_rates"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "waiver_signatures_gym_policy" ON "waiver_signatures" AS PERMISSIVE FOR ALL TO "app" USING ("waiver_signatures"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("waiver_signatures"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "waiver_templates_gym_policy" ON "waiver_templates" AS PERMISSIVE FOR ALL TO "app" USING ("waiver_templates"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("waiver_templates"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "kiosk_devices_gym_policy" ON "kiosk_devices" AS PERMISSIVE FOR ALL TO "app" USING ("kiosk_devices"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("kiosk_devices"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "link_campaigns_gym_policy" ON "link_campaigns" AS PERMISSIVE FOR ALL TO "app" USING ("link_campaigns"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("link_campaigns"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "signed_links_gym_policy" ON "signed_links" AS PERMISSIVE FOR ALL TO "app" USING ("signed_links"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("signed_links"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_events_gym_policy" ON "audit_events" AS PERMISSIVE FOR ALL TO "app" USING ("audit_events"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("audit_events"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "email_outbox_gym_policy" ON "email_outbox" AS PERMISSIVE FOR ALL TO "app" USING ("email_outbox"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid) WITH CHECK ("email_outbox"."gym_id" = nullif(current_setting('app.gym_id', true), '')::uuid);
