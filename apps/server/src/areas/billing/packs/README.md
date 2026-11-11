<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Class pack catalog

`createPackCatalogService` lists, reads, creates and updates class packs. Each pack
has a name, a price in the gym's currency, 1–100 credits, optional expiry of
1–3,650 days and attached tax rates. Archive and restore use `active: false/true`
with the current revision. Lists include archived packs unless filtered by `active`.
Prices use shared money validation, including the currency's charge step on
amount-only updates. No sale, grant or spend is performed by the catalog.

`createPackCatalogRoutes` registers GET/POST `/api/billing/class-packs` and
GET/PATCH `/api/billing/class-packs/{packId}`. Every route requires `plans.manage`
(owner or admin), returns `Cache-Control: no-store`, and runs through gym RLS.
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
