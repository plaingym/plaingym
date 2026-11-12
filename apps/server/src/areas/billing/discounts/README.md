<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Discount catalog

`GET` and `POST /api/billing/discounts`, and `GET` and `PATCH
/api/billing/discounts/{discountId}` require `plans.manage` (owner or admin).
The list supports `active=true|false`, `limit` and `offset`. Responses include
the plan IDs, use count and revision. Updates require the revision read by the
client; stale saves return 409. An update is merged with the stored terms and
checked again, so a change that leaves an invalid combination (a percentage and
an amount, say) returns 400 naming the rule. There is no delete route: use
`active: false`.

A named discount contains a percentage (1–10,000 basis points), a positive fixed
amount in the gym's currency, or neither, and may waive the signup fee. At least
one benefit is required; percentage and amount cannot be combined. A price
discount lasts once, for a positive number of cycles, or forever. A waiver-only
discount has no duration or cycle count. Amounts respect the currency's charge
step. An optional end date is a calendar date in the gym's timezone. An empty
plan list means all plans; IDs in a nonempty list must belong to the gym.

Names are trimmed and limited to 100 characters. Optional codes contain 3–40
ASCII letters, digits or dashes. Names and codes are unique per gym without
regard to case; conflicts return 409. A cleared code can be reused.

Any `membership_discounts` history locks price, currency, waiver and duration
terms, including the cycle count. Name, code, end date, eligible plans, maximum
uses and active status remain editable. The maximum cannot be below uses already
taken. Existing snapshots remain unchanged by catalog edits. Catalog edits lock
the discount row, replace plan links and write their audit in one transaction.
An application writer must acquire the same discount row lock before reading
terms and inserting its snapshot, to serialize with catalog edits.

`discounts`, `discount_plans` and `membership_discounts` have forced gym RLS and
composite foreign keys, and are included in exports. Snapshot membership references
also include the household. Only one application with no end timestamp may exist
per membership; ended applications retain their reason and terms.

`createDiscountCatalogService` accepts the existing `CatalogOptions` (database
scope, clock and gym settings accessor). `createDiscountCatalogRoutes` accepts
an optional service. Its production contribution is mounted by the billing
routes barrel. This catalog does not apply discounts or increment uses; it does
not change invoice calculations, membership operations or public signup.
