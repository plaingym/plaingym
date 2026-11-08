-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "waiver_templates" ADD COLUMN "document_key" text;--> statement-breakpoint
ALTER TABLE "waiver_templates" ADD COLUMN "document_hash" text;--> statement-breakpoint
ALTER TABLE "waiver_templates" ADD COLUMN "document_pages" integer;--> statement-breakpoint
ALTER TABLE "waiver_templates" ADD COLUMN "document_bytes" integer;--> statement-breakpoint
ALTER TABLE "waiver_templates" ADD CONSTRAINT "waiver_templates_content_check" CHECK ((
    length(trim("waiver_templates"."body")) > 0 and "waiver_templates"."document_key" is null and "waiver_templates"."document_hash" is null and "waiver_templates"."document_pages" is null and "waiver_templates"."document_bytes" is null
  ) or (
    "waiver_templates"."body" = '' and "waiver_templates"."document_key" is not null and "waiver_templates"."document_key" like "waiver_templates"."gym_id"::text || '/waivers/templates/%.pdf'
    and "waiver_templates"."document_hash" is not null and "waiver_templates"."document_hash" ~ '^[a-f0-9]{64}$'
    and "waiver_templates"."document_pages" is not null and "waiver_templates"."document_pages" between 1 and 20
    and "waiver_templates"."document_bytes" is not null and "waiver_templates"."document_bytes" between 1 and 10485760
  ));
