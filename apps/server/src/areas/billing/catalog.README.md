<!-- SPDX-License-Identifier: AGPL-3.0-only -->
The [discount catalog](discounts/README.md) adds manager-only list, read, create
and revision-checked update routes at `/api/billing/discounts`. Catalog edits do
not apply discounts to memberships or invoices.

Catalog and membership services use the existing frozen billing contracts and
the existing schema. Catalog prices and tax links are revision checked. Retirement
sets active=false; it never deletes a referenced plan or tax. New assignments and
new tax links require active records; existing memberships keep their price,
interval, currency, and original commitment when a catalog item is edited.

A price, sign-up fee or membership price override must be a whole step of its currency
(`minorUnitStep`: 100 for ISK and UGX, 10 for the three-decimal currencies), as Stripe charges
nothing finer. The request schemas refuse one that names its currency; an update that changes an
amount alone is checked against the stored currency. Unchanged amounts are left alone.

## Plan price changes for existing members

A plan update with a new price (`PATCH /api/billing/plans/{planId}`) changes only the price new
members get; it changes no membership. Two owner and admin routes (`plans.manage`) on
`/api/billing/plans/{planId}/price-change` move existing members (`catalog.price-change.ts`):

* `GET` with `amountCents` and `effectiveOn` (on or after the gym-local today) previews the plan's
  memberships that aren't cancelled, at most 2,000 by member name. Each says whether "Choose members"
  ticks it by default (not in a commitment ending after the date, not on a custom price, not frozen)
  and whether "All existing members" moves it (frozen ones too), or why it can't move: a switch to
  another plan scheduled (`switch_scheduled`), a price change already scheduled (`price_scheduled`:
  a downgrade now's or an earlier price change), or a currency or interval other than the plan's
  (`terms`). A custom price is an amount or interval other than the plan's current price. The
  preview also counts the households, those whose payer has no address or was erased, the
  switches to this plan (which keep the price they were quoted), and says whether the gym can send
  member email now.
* `POST` with `{ requestKey, planRevision, amountCents, effectiveOn, notify, memberships }` (1 to
  2,000 distinct `{ id, revision }`, under its own 256 KB body limit) checks the price's currency
  step and the date, and that every listed membership is the gym's (404 before any write). Under
  the plan's row lock it looks for a `billing.plan.price_changed` audit with the key: the same
  price, date, flag and list (a digest of the sorted IDs) resume, or return the recorded result;
  anything else is a conflict (`request_reused`). A new request changes the plan's price
  (revision-checked) with that audit. Then, a few households per short transaction, it locks each
  household and then its memberships (the cycle build's order) and sets the price-only scheduled
  change on each listed membership that can move (`scheduled_plan_id` the plan, the new price, the
  membership's interval, `scheduled_on` the date, origin `price_change`), audited as
  `billing.membership.price_change_scheduled` with the key. A membership the key already scheduled
  is found by that audit before its revision is checked, so a retry, a concurrent request with the
  key or a resume after a failed chunk schedules nothing twice. One that changed, was cancelled or
  left the plan since the preview is skipped (`changed`). A household is never split. With
  `notify`, each household with a membership scheduled gets the price notice job
  (`billing.memberships.price_notice`, key `plan-price:<requestKey>:<householdId>`), enqueued in
  that transaction, so it runs only after commit, once. The result lists the memberships scheduled
  and skipped, the households notified (a notice queued) and, among them, those whose payer has no
  address or was erased, which the notice job skips; the first run
  to finish records it (`billing.plan.price_change_applied`) and a replay returns it.

The cycle build applies the change at the first active cycle due on or after its date, with no
proration (`memberships.README.md`, scheduled changes), so a frozen, trial or pending membership keeps it until it is billed as
active. Discounts come off the new price. A later plan switch or a staff price edit replaces it.

Class pack catalog services and routes are described in [packs/README.md](packs/README.md).

A tax rate is never archived while charge types, class packs or plans carry it. Archiving
(`active: false`) an active rate that something carries is a conflict whose
details list the charge types, the packs, the plans and the memberships (not cancelled) on
those plans; GET /api/billing/tax-rates/{taxRateId}/usage returns the same list.
With `detach: true` one transaction removes every link and archives the rate,
with one `billing.tax_rate.archived` audit naming each item. Plans' next cycle
invoices then drop the rate. The plan and charge type revisions don't change; a
plan, pack or charge type edit locks the rates it names before reading its own links,
so an edit that waited on a detach can't attach the archived rate again.
Rates archived and attached before this rule keep their links and stay editable
as they are: plans still apply the rate, one-off invoices for such a charge type
are refused (`tax_rate_inactive`), and the catalog warns on each with a way to
remove it (`detach: true` clears an archived rate's links too, with a
`billing.tax_rate.detached` audit). The UI labels these rates **Inactive** and
offers a removal-only confirmation. Only a `tax_rate_attached` conflict opens
the archive confirmation after a save; a stale revision keeps the draft and
asks staff to reload. One-off invoices lock the charge type and its rates, then
reread its links so a confirmed detach that committed while they waited is honored.

All mutations write audits in their transaction. Membership edits apply a new
plan's defaults before explicit overrides. Commitments are recorded, not enforced:
staff can cancel before the date. New HTTP assignments are pending unless the
plan has a trial; internal callers can explicitly select an initial state. No
operation in this service calls a payment provider.

A staff assignment to a household with no live memberships (new, or with only
cancelled ones) starts billing on its join date, with no prorated opening period;
its first bill, after any trial, sets the household's billing day. Later staff
assignments must use the household's next billing date: the earliest active or
pending monthly due date on or after the start, else the billing day (trial and
frozen dates don't count). The member tab suggests exactly that date. Internal
assignments preserve explicitly supplied dates, including imported annual renewals.

Freezing skips at least the next due cycle immediately. A timed freeze also skips
every cycle before its resume date. Resuming never restores the skipped cycle or
back-bills frozen time, but cycles due from a scheduled resume date on stay owed
even when the resume runs late (after downtime). Monthly dates retain the
household's anchor, with short months clamped; a date off the billing day (a
trial that ended mid-cycle) advances to the next billing day, as the invoice
engine bills it. A staff-assigned trial is first due when it ends. The daily billing.memberships.dates job processes expired trials
and timed freezes using the gym's calendar date. It selects due records in bounded
pages and commits each change separately, with revisions protecting staff edits.
Pending memberships remain pending until explicitly activated (for example, by
the payment transition service).

Assignment is idempotent on the internal request ID. The assignment audit records
the request, membership snapshot, and first-period billing instructions (including
the sign-up fee and tax snapshots), in the assigning transaction. Its optional
onAssigned(tx, context, membership, billing) callback lets invoice creation commit
atomically with the membership. It must perform database work only. The default
service records the instructions but does not issue first-period or fee invoices;
runtime integration must inject the invoice engine callback before collecting
those amounts. Repeating an assignment ID never issues them twice. A callback
failure rolls back the membership, audit, and invoice work together.

Composition exports: createCatalogService, createCatalogRoutes, configureCatalog,
createPriceChangeService, configurePriceChanges, createMembershipService,
createMembershipRoutes, configureMemberships, and createMembershipJobs. Routes and
daily jobs are already in their area barrels; configureMemberships(service) makes both
share the runtime-injected service. The price change routes need
configurePriceChanges(createPriceChangeService({ jobs, smtp, clock })) at runtime;
without it the preview says the gym can't email and an apply with `notify` is
`unavailable` before any write. No additional route mounting is needed.

The catalog UI lives at /admin/billing/plans and includes plans, tax rates, and
charge types. Memberships register their own member-profile tab. Both use stacked
cards and single-column forms on phones. Front desk can read memberships; owner
and admin can assign and change their state.
