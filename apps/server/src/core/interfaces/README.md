<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Internal service interfaces

These signatures are the contracts between server areas. They expose projections
and aggregates, with no database handles or provider SDK objects. `index.ts`
exports each interface and its in-memory fake. No routes or production services
are implemented here.

- `AttendanceQueries` uses inclusive `since`, exclusive `until`, offset pagination,
  and materialized session programs and class tags. Portal calls carry a household
  identity and use forHousehold in the implementation, while staff/jobs use gym scope. Imported attendance may have
  a direct program and no session. Joining several programs never multiplies a count.
- `MembershipLifecycle` records the original commitment with clamped calendar
  months and retains it across plan changes. Freeze/resume/cancel reject invalid
  transitions; edits compare the client's revision. Assignment only records the
  selected first-period policy; the caller coordinates invoicing and charging.
  HTTP membership PATCH maps to update (price and due-date edits, one revision
  increment). Plan and interval changes use changePlan, which schedules the quoted
  terms for the next cycle billed as active and retains current terms until then.
  The fake retains those scheduled terms too. Resume maps to activate with
  nextDueOn. A null freeze resumesOn means no scheduled resume.
- `InvoiceTransitions` owns payment state changes. Processor intent/charge IDs
  deduplicate card payments; local payment/refund UUIDs deduplicate commands.
  The fake's `effects` describe work a production implementation must persist
  atomically (receipt, membership activation, dunning, duplicate refund and staff
  notice). No fake performs network calls, schedules retries, or calculates tax.
  Issued invoices and attempts are seeded explicitly. Late failures cannot reopen
  paid invoices, and one-off failures never schedule retries (the fake also sends
  no staff-charge notice). A provider canceled
  outcome is stored as failed: with declineCode confirm_abandoned when the attempt
  was still pending (its intent was never confirmed, so the invoice, dunning and
  retries are untouched), otherwise with intent_canceled as a decline. Both codes
  preserve terminal cancellation through the locked schema and after reloading a
  fake fixture. Refunds reserve pending amounts and only successful refunds change
  the invoice's refund state, with one backward move: a processor refund that fails
  after it succeeded (same processor ID) releases its amount, recomputes the
  invoice's refund status (back to partially refunded or paid) and notifies staff.
  Every processor refund that ends failed (first recorded failed, pending to failed,
  or reversed) notifies staff once. A canceled refund (cancelled at the processor
  before it completed, usually by staff) is final like a failed one and releases
  its amount; staff are notified once when the app created it. Tags, request or duplicate
  reservation audits, and the original pending-without-processor audit establish that
  provenance. Cash and check refunds never reverse. `processorRefund` accepts processor
  reports and pending reads separately from plain `refund`, refuses as not found a report
  whose gym metadata, charge or currency is not the payment's, matches recorded IDs or app
  reservations and makes room for an external refund atomically. The optional
  `missingRefunds` lists processor IDs of pending refunds that the processor reported
  missing. The transition releases them newest first, only as needed, and queues
  a staff notice for each release. Unread processor rows still reserve their amounts and
  force a retry if the external refund needs more room after those releases. For a refund
  released as missing, the real transition and the fake handle both commit orders alike.
  A verified failure that commits first is recorded once and answers `ignored`: a later
  success for that refund then records nothing and queues no notice, and the original
  missing notice stays the only one. The failure can come from the refund's own processor
  report or from a `failed` read in `pendingRefunds` sent with another refund's report,
  when its amount, currency, gym metadata and charge match the released row; such reads
  apply before that report's own write and roll back with it. A cancellation, a mismatched
  read, an ordinary failed refund and a plain `refund` call never count. When verified
  success commits first, it queues one staff notice for manual reconciliation and leaves
  the refund and invoice unchanged; the first matching failure after that success queues
  one staff follow-up, again keeping the refund and invoice unchanged. The real transition
  also skips any found notice still queued and asks staff to recheck the payment.
  The fake's `seedRefund` accepts persisted provenance for fixtures. Its plain `refund`
  sends a staff notice when it fails a reservation without a processor ID if the reservation
  is marked as a duplicate or a system actor releases it past `refundRetryWindowMs` (23 hours,
  exported here). `processorRefund` uses that same rule when it releases unsent reservations.
  `invoice-transitions.contract.ts` runs the same cancellation, processor ownership and
  matching, reservation, release-notice and rollback cases against the fake and the real
  transitions.
- `MemberHouseholdContext` accepts authenticated user/gym IDs and a selected
  household, then reloads the link. Payers may see the household; non-payers see
  their linked member. Its context carries IDs only. It does not replace
  `forHousehold`: production portal queries and writes still use that boundary.
- Extension providers fit the existing `Registry` and its module filtering.
  Promotion providers own a config schema. Dashboard and health providers take
  the shared area's response schema and preserve its exact typed payload; no
  second wire shape or UI renderer is introduced. Dashboard providers may return
  `null` to omit an empty widget; non-null payloads still require schema validation.
  Standing reasons are internal
  staff diagnostics; kiosk responses must map every failure to the neutral front-desk message.
- `GymSettingsAccessor`, `JobStatsQuery`, and `WebhookHealthQuery` replace direct
  system-table reads. Empty job/webhook histories return zero counts and null
  timestamps. Gym jobs exclude install-level jobs. No webhook payloads, job
  payloads, raw errors or encrypted configuration are returned.

All mutation implementations must write audits and idempotency records with the
state change in a short transaction, then perform external I/O after commit.
Fakes model these interfaces for consumer tests; real database implementations
must also pass database isolation, concurrency and billing scenario tests.
