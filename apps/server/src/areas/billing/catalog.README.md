<!-- SPDX-License-Identifier: AGPL-3.0-only -->
Catalog and membership services use the existing frozen billing contracts and
the existing schema. Catalog prices and tax links are revision checked. Retirement
sets active=false; it never deletes a referenced plan or tax. New assignments and
new tax links require active records; existing memberships keep their price,
interval, currency, and original commitment when a catalog item is edited.

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
