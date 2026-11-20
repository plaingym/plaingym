-- SPDX-License-Identifier: AGPL-3.0-only
-- rollback-reviewed: The replacement admits every existing attempt state. Collection still writes only the existing states.
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_status_check";--> statement-breakpoint
-- rollback-reviewed: The replacement admits every existing payment method. Collection still writes only the existing methods.
ALTER TABLE "payments" DROP CONSTRAINT "payments_method_check";--> statement-breakpoint
DROP INDEX "payment_attempts_pending_key";--> statement-breakpoint
ALTER TABLE "gyms" ADD COLUMN "bank_debits_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "processing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "type" text DEFAULT 'card' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "mandate_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_unresolved_key" ON "payment_attempts" USING btree ("gym_id","invoice_id") WHERE "payment_attempts"."status" in ('pending', 'processing');--> statement-breakpoint
-- rollback-reviewed: Older writers never set processing, so their inserts and updates may omit the timestamp.
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_processing_check" CHECK ("payment_attempts"."status" <> 'processing' or "payment_attempts"."processing_at" is not null);--> statement-breakpoint
-- rollback-reviewed: This widens the allowed states. Collection still writes only the existing states.
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_status_check" CHECK ("payment_attempts"."status" in ('pending', 'processing', 'succeeded', 'failed', 'requires_action'));--> statement-breakpoint
-- rollback-reviewed: Earlier card inserts omit type and get the card default. Readers ignore the new columns.
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_type_check" CHECK ("payment_methods"."type" in ('card', 'us_bank_account', 'acss_debit'));--> statement-breakpoint
-- rollback-reviewed: Existing rows and earlier inserts have the card type and retain the existing expiry checks.
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_bank_expiry_check" CHECK ("payment_methods"."type" = 'card' or ("payment_methods"."expiry_month" is null and "payment_methods"."expiry_year" is null));--> statement-breakpoint
-- rollback-reviewed: This widens the allowed methods. Collection still writes only the existing methods.
ALTER TABLE "payments" ADD CONSTRAINT "payments_method_check" CHECK ("payments"."method" in ('card', 'bank_debit', 'cash', 'check', 'other'));
