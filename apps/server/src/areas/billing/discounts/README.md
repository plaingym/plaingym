<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Discount catalog

`GET` and `POST /api/billing/discounts`, and `GET` and `PATCH
/api/billing/discounts/{discountId}` require `plans.manage` (owner or admin).
The list supports `active=true|false`, `limit` and `offset`. Responses include
the plan IDs, use count, revision and read-only `termsLocked` flag. The flag is
true after any application, even when all uses have been released and the count
is zero. Updates require the revision read by the
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
routes barrel. The catalog edits terms; `apply.ts` applies them during membership
assignment and supplies the runner with their snapshots.
It also ends applications atomically for staff replacement/removal, cancellation
and plan switches. `switchDiscount` uses the application's snapshotted plan IDs;
`switchAppliedDiscount` ends an ineligible application with reason `switch`.
Replacement and removal routes are described in the
[memberships README](../memberships.README.md); none of these operations returns
a catalog use or consumes a cycle.

Staff assignment accepts `discount: { discountId }` or `discount: { code }`.
Codes match without regard to case. An inactive or unknown discount returns
`discount_unknown` in the error's `details.reason`; other refusals are
`discount_ended`, `discount_used_up` and `discount_plan`. The end date includes
the whole local day in the gym's timezone. Eligibility is checked when applied.

Lock order is household, membership, then discount. `resolveDiscount` locks the
catalog row and reads the eligible plans. Its public audience returns the same
neutral error for every refusal. `takeDiscountUses` reserves one or more uses
under that lock; callers reserving several applications do so together in the
same transaction. `applyDiscount` writes the snapshot. The internal lifecycle
flag `discountUseTaken` is only for callers that already reserved that use in
the encompassing transaction; the HTTP request never accepts it. Assignment
replays compare the whole request, including the discount, before reserving.

Every application takes a use, including a fee-only waiver; cancellation does
not return it. The one exception is a public join voided unpaid after seven days
(`public/pages/join.md`, **Unpaid joins**): in the void's transaction, under the
household lock, the join cleanup ends the code's live applications with reason
`released` (`endDiscount`), and `releaseDiscountUses` lowers `uses` by the count
the join recorded, under the discount row lock and never below zero, audited as
`billing.discount.uses_released`. The join's `public.join.voided` record, written in
the same transaction, keeps a replay or a second run from releasing again. Fee-only applications finish with `completed` at assignment.
The membership response includes the live snapshot's name, terms, eligible
plans and cycles left, or null when no live application remains. Invoices use
that snapshot even if the catalog's name, code or eligibility changes later.
Only a billed full cycle consumes one `once` or `cycles` cycle, including a
first period that starts on its period boundary and so bills a whole period.
Prorated first periods, off-day stubs, trials and skipped frozen periods
consume none. The last
cycle marks the application `completed` in the transaction advancing the due
date. Forever applications have no cycle counter.
