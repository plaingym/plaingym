-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "class_bookings" ADD COLUMN "session_cancel_status" text;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD COLUMN "session_cancel_position" integer;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD COLUMN "restore_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- rollback-reviewed: Checks only the new nullable marker columns; the previous release never writes them and never moves a cancelled booking back, so its inserts and updates pass, and its readers ignore them.
ALTER TABLE "class_bookings" ADD CONSTRAINT "class_bookings_session_cancel_check" CHECK (("class_bookings"."session_cancel_status" is null and "class_bookings"."session_cancel_position" is null) or ("class_bookings"."status" = 'cancelled' and "class_bookings"."session_cancel_status" is not null and "class_bookings"."session_cancel_status" = 'booked' and "class_bookings"."session_cancel_position" is null) or ("class_bookings"."status" = 'cancelled' and "class_bookings"."session_cancel_status" is not null and "class_bookings"."session_cancel_status" = 'waitlisted' and "class_bookings"."session_cancel_position" is not null and "class_bookings"."session_cancel_position" > 0));--> statement-breakpoint
-- rollback-reviewed: Checks only the new restore count column; the previous release's inserts use its 0 default and its readers ignore it.
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_restore_count_check" CHECK ("class_sessions"."restore_count" >= 0);
