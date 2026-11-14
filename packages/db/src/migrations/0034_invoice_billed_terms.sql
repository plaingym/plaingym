-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "invoice_line_items" ADD COLUMN "billed_unit_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "billed_discount" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_billed_terms_check" CHECK (("invoice_line_items"."billed_unit_amount_cents" is null and "invoice_line_items"."billed_discount" is null)
    or ("invoice_line_items"."kind" = 'membership' and "invoice_line_items"."billed_unit_amount_cents" is not null and "invoice_line_items"."billed_unit_amount_cents" >= 0
      and ("invoice_line_items"."billed_discount" is null or jsonb_typeof("invoice_line_items"."billed_discount") = 'object')));--> statement-breakpoint
-- Preserve only recorded issuance terms. Missing snapshots stay unknown, rather than inferring later edits.
WITH recorded AS (
  SELECT DISTINCT ON (line.id) line.id, snapshot.value
  FROM invoice_line_items AS line
  JOIN audit_events AS event ON event.gym_id = line.gym_id AND event.target_id = line.invoice_id
    AND event.action = 'billing.invoice.issued' AND event.target_type = 'invoice'
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(event.after->'membershipPricing') = 'array'
    THEN event.after->'membershipPricing' ELSE '[]'::jsonb END) AS snapshot(value)
  WHERE line.kind = 'membership' AND snapshot.value->>'membershipId' = line.membership_id::text
    AND jsonb_typeof(snapshot.value->'amountCents') = 'number'
    AND CASE WHEN snapshot.value->>'amountCents' ~ '^[0-9]{1,10}$'
      THEN (snapshot.value->>'amountCents')::bigint <= 2147483647 ELSE false END
    AND jsonb_typeof(snapshot.value->'discount') IN ('object', 'null')
  ORDER BY line.id, event.occurred_at DESC, event.id DESC
)
UPDATE invoice_line_items AS line
SET billed_unit_amount_cents = (recorded.value->>'amountCents')::integer,
    billed_discount = nullif(recorded.value->'discount', 'null'::jsonb)
FROM recorded WHERE line.id = recorded.id;
