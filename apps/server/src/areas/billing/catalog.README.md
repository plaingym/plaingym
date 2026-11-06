<!-- SPDX-License-Identifier: AGPL-3.0-only -->
Catalog and membership services use the existing frozen billing contracts and
the existing schema. Catalog prices and tax links are revision checked. Retirement
sets active=false; it never deletes a referenced plan or tax. New assignments and
new tax links require active records; existing memberships keep their price,
interval, currency, and original commitment when a catalog item is edited.

A price, sign-up fee or membership price override must be a whole step of its currency
(`minorUnitStep`: 100 for ISK and UGX, 10 for the three-decimal currencies), as Stripe charges
nothing finer. The request schemas refuse one that names its currency; an update that changes an
amount alone is checked against the stored currency. Unchanged amounts are left alone.

A tax rate is never archived while charge types or plans carry it. Archiving
(`active: false`) an active rate that something carries is a conflict whose
details list the charge types, the plans and the memberships (not cancelled) on
those plans; GET /api/billing/tax-rates/{taxRateId}/usage returns the same list.
With `detach: true` one transaction removes every link and archives the rate,
with one `billing.tax_rate.archived` audit naming each item. Plans' next cycle
invoices then drop the rate. The plan and charge type revisions don't change; a
plan or charge type edit locks the rates it names before reading its own links,
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
createMembershipService, createMembershipRoutes, configureMemberships, and
createMembershipJobs. Routes and daily jobs are already in their area barrels;
configureMemberships(service) makes both share the runtime-injected service.
No additional route mounting is needed.

The catalog UI lives at /admin/billing/plans and includes plans, tax rates, and
charge types. Memberships register their own member-profile tab. Both use stacked
cards and single-column forms on phones. Front desk can read memberships; owner
and admin can assign and change their state.
