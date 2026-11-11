<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Class packs

`createPackCatalogService` lists, reads, creates and updates class packs. Each pack
has a name, a price in the gym's currency, 1–100 credits, optional expiry of
1–3,650 days and attached tax rates. Archive and restore use `active: false/true`
with the current revision. Lists include archived packs unless filtered by `active`.
Prices use shared money validation, including the currency's charge step on
amount-only updates. No sale, grant or spend is performed by the catalog.

`createPackCatalogRoutes` registers GET/POST `/api/billing/class-packs` and
GET/PATCH `/api/billing/class-packs/{packId}`. Reads require `billing.read`
(owner, admin or front desk); changes require `plans.manage` (owner or admin).
Every route returns `Cache-Control: no-store` and runs through gym RLS.
An unknown or foreign gym resource is 404; stale edits are 409.
The billing route barrel mounts these routes. The service defaults to the runtime
gym scope, clock and settings accessor; tests can supply these options directly.

Pack edits lock the pack and validate tax rates under sorted share locks before
reading existing links. Inactive rates cannot be newly attached. Confirmed tax
archive counts and detaches pack links along with plans and charge types, in the
same audited transaction. Each catalog mutation records its before/after values,
staff actor and injected time in `audit_events`.

Migration `0027_class_packs.sql` adds the catalog, tax links, sale snapshots and
credit ledger with forced gym RLS and composite references. Sales keep their
invoice household, while credits reference the member independently of household.
Ledger lot and sale references also include the recipient member. Ledger rows
are append-only for app except `reason`, which may be redacted to an empty string
on adjustment entries. Attendance IDs intentionally have no FK because undo
deletes attendance. Partial unique indexes deduplicate every ledger command;
adjustments have separate indexes for lot-opening and lot-drawing entries.
The four tables are gym export datasets with explicit column projections.

## Sales and credits

`createPackSalesRoutes` exposes POST `/api/billing/packs/{packId}/sell` under
`payments.record` (owner, admin or front desk). The existing pack route export
mounts it. Its strict body has `memberId` and `dueOn`; the member's locked household
is the payer, so a caller cannot assign another household or an existing invoice.
Sales lock household before member, matching erasure, and reject a member whose
household changed while the sale waited for its lock.
Archived packs return 409; foreign resources and erased members return 404.
`createPackSalesService` locks the pack for share and snapshots its credit count
and expiry days in a sale. The one-off invoice uses the pack's name as its charge
line and the existing pricing, tax snapshot and invoice numbering helpers. Invoice,
lines, sale and their audits commit together. A zero-total invoice is then settled
through `InvoiceTransitions.settleZero`, and the sale returns the paid invoice.
Staff collect positive-total invoices through existing saved-card, pay-link or
manual-payment actions.

The service accepts a `transitions` option; `configurePackSales(service)` selects
the service used by the mounted routes. The runtime can supply its publishing
transitions to enqueue the zero-sale effect immediately. The default transitions
persist the same effect for the hourly sweep.

`createPackCredits` is called directly by invoice effects. The paid/zero-settlement
effect grants the sale before `afterInvoicePaid`, including a zero-total sale's
settlement effect. It locks invoice then member,
requires paid or partially refunded state and inserts a single grant under the
sale's partial unique index. The expiry is local midnight at the start of the day
`expiryDays` after the local paid date, computed through shared time helpers in
the gym's timezone; null expiry never expires. Processing delays do not extend it.

A transition to fully refunded records `reverse_credits` in the same transaction.
That effect locks invoice then member and reverses the lot's remaining balance
(grant plus every entry on that lot). Used or expired credits stay consumed;
zero remaining writes no ledger row. Partial refunds change no credits. A failed
full refund does not restore credits, even when it fails before the queued reversal
runs. A grant delayed past a full refund stays suppressed, including after a failed
refund returns the invoice to paid. Credits follow the member after a household move;
the invoice and sale keep the original payer. Unique grant/reversal indexes and
transactional `billing.credits.granted` / `billing.credits.reversed` audits make
effect replays and crashes before completion safe.
