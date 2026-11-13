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
The hourly transitions sweep recovers an interrupted settlement once the invoice
is due. Sales and ordinary one-offs share `issueOneOff`, including tax locking,
post-detach link checks, numbering and the issuance audit. Sale conflicts expose
`pack_inactive`, `currency_mismatch` or `tax_rate_inactive` in `details.reason`.
Staff collect positive-total invoices through existing saved-card, pay-link or
manual-payment actions.

The service accepts a `transitions` option; `configurePackSales(service)` selects
the service used by the mounted routes. The runtime passes its publishing
transitions, so a zero-total sale enqueues its credit effect immediately; the
default transitions (used when nothing is configured) persist the same effect
for the hourly sweep.

`createPackCredits` is called directly by invoice effects. The paid/zero-settlement
effect grants the sale before `afterInvoicePaid`, including a zero-total sale's
settlement effect. It locks invoice then member,
requires paid or partially refunded state and inserts a single grant under the
sale's partial unique index. The expiry is local midnight at the start of the day
`expiryDays` after the later of the local paid date and the grant's own local date,
computed through shared time helpers in the gym's timezone; null expiry never
expires. A backdated manual payment therefore never grants credits that have
already expired. A grant marks the buyer's lead `won` (`leads/stages.ts`), as a
membership that starts does. A sale whose member was erased before it was paid
grants nothing: it audits `billing.credits.not_granted` once and queues a
`credits_not_granted` staff notice naming the invoice and the credits, so staff can
refund the payer.

A pack invoice's transition to fully refunded records `reverse_credits` in the same transaction.
That effect locks invoice then member and reverses the lot's remaining balance
(grant plus every entry on that lot). Used or expired credits stay consumed;
zero remaining writes no ledger row. Partial refunds change no credits. A failed
full refund does not restore credits, even when it fails before the queued reversal
runs. A grant delayed past a full refund stays suppressed, including after a failed
refund returns the invoice to paid; the `refund_failed` staff notice then names the
credits the reversal took back, which staff add back by adjustment if the payer is
still owed the pack. Credits follow the member after a household move;
the invoice and sale keep the original payer. Unique grant/reversal indexes and
transactional `billing.credits.granted` / `billing.credits.reversed` audits make
effect replays and crashes before completion safe.
The durable `reverse_credits` command suppresses late grants; refund audit
snapshot fields are not used as billing state. Non-pack invoices skip credit grants
and queue no credit reversal.

## Balance, draws and adjustments

`packs/index.ts` exports the helpers used inside a caller's existing gym
transaction. They never open a nested transaction or call external services:

* `lockMemberCredits(tx, memberId)` locks the member row `FOR NO KEY UPDATE` and returns
  it, or throws 404. Every credit writer takes this lock before reading the ledger.
  Callers that also lock an invoice or household take those locks before the member.
  Foreign-key share locks for bookings and check-ins can proceed while it is held.
* `usableLots(tx, memberId, now)` returns positive remainders in draw order:
  earliest expiry, then oldest creation time, then ID; never-expiring lots come
  last. A lot is unusable at its exact expiry instant, without waiting for a job.
  Each result includes the opening entry's fields and `remaining`.
* `drawCredits(tx, input)` requires the member lock. Input contains `gymId`,
  `memberId`, positive `credits`, `now`, and either `kind: 'use'` with an
  `attendanceId` (exactly one credit), or `kind: 'adjust'` with `adjustmentId`,
  `reason` and nullable `createdBy`. It inserts one negative entry per drawn lot
  in draw order and returns `{ outcome: 'drawn', entries }`. If insufficient, it
  returns `{ outcome: 'insufficient_credits', balance }` and writes nothing.
  The caller owns command replay detection and the audit in the same transaction.
* `hasActiveMembership(tx, memberId)` counts `active` and `trial` memberships;
  `pending`, `frozen` and `cancelled` do not count.
* `isPackHolder(tx, memberId)` checks for a lot, including exhausted or expired
  balances and credits staff added. A pack refunded in full (a sale `reverse` row,
  or its invoice `refunded`) doesn't count, so a sale undone that way leaves the
  member as before it.
* `returnCredit(tx, { gymId, memberId, attendanceId, now })` requires the member
  lock. It returns the credit an undone visit spent to its lot (a `reverse` +1 row)
  and answers `true`; `false` when that lot's pack was refunded in full, so the
  credit stays spent; `null` when the visit spent no credit.

`createCreditLedgerService` implements GET
`/api/billing/members/{memberId}/credits` (`billing.read`) and POST
`/api/billing/credits/adjust` (`payments.record`). Both allow owner, admin and
front desk and return `Cache-Control: no-store`; coaches receive 403 and foreign
members receive 404. These routes mount through the existing pack route export
and use the default gym scope and clock, with injectable options for tests.

Reads lock the member to return a consistent balance, positive lot remainders
(including expired remainders until their expiry entry is written), and a page of entries ordered
by creation time and ID, newest first. `limit` defaults to 50 (maximum 100) and
`offset` to zero; pagination includes the total entry count. The usable balance
excludes expired lots. Grant, draw, refund and expiry entries carry the sale's
invoice number through their sale or lot; manual lots have no invoice number.

Adjustment input is `{ memberId, credits, reason, adjustmentId }`: a nonzero
integer from -100 to 100, a trimmed 1–500-character reason and a client-generated
UUID. Reuse that UUID when retrying the same command. A transaction-scoped advisory
lock on the gym and adjustment UUID comes before the member lock, so the same UUID
cannot adjust two different members concurrently. Under these locks, a
retry returns its existing entries without another write or audit. Entries in
the adjustment response have stable ID order and the same invoice numbers as a
ledger read; its balance is the current balance.
Reusing a recorded UUID with a different member, count or reason returns 409
with `error.details.reason: ['adjustment_id_reused']`. Positive adjustments open
never-expiring lots; negative adjustments use `drawCredits` and return 409 with
`error.details.reason: ['insufficient_credits']` when the balance is too low.
Erased members cannot be adjusted.

`billing.credits.adjusted` audits record actor, time, command, signed credits and
entry IDs, including `reasonEntryId` references to the reason on each ledger row.
Free text is kept only on those redactable rows, so erasure clears the member's
adjustment reasons in its transaction while retaining the ledger and audit.

## Daily expiry

`createCreditExpiryJobs` registers `billing.credits.expire` through the billing
jobs barrel. The existing per-gym scheduler runs it at 00:07 in each gym's
timezone, including across DST changes, in the gym's batch lane so its other
jobs don't wait behind it. It uses the job context's clock and
needs no additional runtime configuration. `createCreditExpiryService().expire(gymId)`
scans candidate members in bounded pages, selecting only past-expiry openings
with a positive remainder and no expiry entry. It takes a separate short transaction
and member lock for each. It inserts an `expire` row for each expired lot's
remaining credits and a `billing.credits.expired` system audit. The unique
one-expire-per-lot index makes replays safe. A returned credit retains its lot's
expiry and stays unusable even if that lot already has its single expiry entry.
