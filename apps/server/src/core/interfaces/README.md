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
  HTTP membership PATCH maps to update (plan defaults first, explicit price/interval/
  due-date overrides second, one revision increment). Resume maps to activate with
  nextDueOn. A null freeze resumesOn means no scheduled resume.
- `InvoiceTransitions` owns payment state changes. Processor intent/charge IDs
  deduplicate card payments; local payment/refund UUIDs deduplicate commands.
  The fake's `effects` describe work a production implementation must persist
  atomically (receipt, membership activation, dunning, duplicate refund and staff
  notice). No fake performs network calls, schedules retries, or calculates tax.
  Issued invoices and attempts are seeded explicitly. Late failures cannot reopen
  paid invoices, and one-off failures never schedule dunning. A provider canceled
  outcome is stored as failed with declineCode intent_canceled, preserving terminal
  cancellation through the locked schema and after reloading a fake fixture. Refunds reserve
  pending amounts and only successful refunds change the invoice's refund state.
- `MemberHouseholdContext` accepts authenticated user/gym IDs and a selected
  household, then reloads the link. Payers may see the household; non-payers see
  their linked member. Its context carries IDs only. It does not replace
  `forHousehold`: production portal queries and writes still use that boundary.
- Extension providers fit the existing `Registry` and its module filtering.
  Promotion providers own a config schema. Dashboard and health providers take
  the shared area's response schema and preserve its exact typed payload; no
  second wire shape or UI renderer is introduced. Standing reasons are internal
  staff diagnostics; kiosk responses must map every failure to the neutral front-desk message.
- `GymSettingsAccessor`, `JobStatsQuery`, and `WebhookHealthQuery` replace direct
  system-table reads. Empty job/webhook histories return zero counts and null
  timestamps. Gym jobs exclude install-level jobs. No webhook payloads, job
  payloads, raw errors or encrypted configuration are returned.

All mutation implementations must write audits and idempotency records with the
state change in a short transaction, then perform external I/O after commit.
Fakes model these interfaces for consumer tests; real database implementations
must also pass database isolation, concurrency and billing scenario tests.
