<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing scenarios

Run from the repository root with Node 24.22.1:

```sh
pnpm exec vitest run apps/server/src/areas/billing/scenarios
```

Leave `DATABASE_URL` unset. The normal Vitest integration setup starts disposable
PostgreSQL and clones a migrated database per test file. Fixtures use a separate
gym per scenario, `forGym`, real area services, and an injected `TestClock`.
Transition and inbox scenarios use `PostgresJobs` and read durable rows. No
wall-clock sleeps, live Stripe credentials, or database mocks are needed.

| File | Runnable coverage | Dependencies still pending |
| --- | --- | --- |
| `calendar-pricing.test.ts` | Catalog → persisted membership → invoice calculation: leap/non-leap month ends, year rollover, gym-local trial expiry, DST-spanning daily proration, consolidated family and independent annual dates, freeze/resume/cancel, discounts and inclusive/exclusive noncompounded tax, snapshot isolation from catalog edits, household/gym isolation | Durable issuing, numbering, catch-up, concurrent runs, and imported leap-day renewals wait for the charge runner |
| `payment-provider.test.ts` | Calculated invoice → `Payments` fake: create/confirm idempotency, decline and all SCA normalization shapes, lost-response lookup, payment/setup Checkout and saved method, partial/full refunds, signed provider event and current-object lookup | Full delivery and activation wait for webhook handlers; scheduled retries/reconciliation wait for the charge runner |
| `transitions.test.ts` | Real PostgreSQL transitions and worker: sequential/concurrent success, receipt and activation once, cycle decline/SCA with dunning mail, retry scheduling, one-off failures, paid finality, older attempts, canceled intents, cash/check plus duplicate card refunds and staff notices, partial/full/pending/failed refunds from card success and restored payments | Retry jobs stay pending; charging needs the charge runner |
| `inbox.test.ts` | Real Stripe signature verification → inbox → PostgreSQL dispatcher: invalid signatures and tampered bytes leave no rows; concurrent delivery/replay creates one dispatch per event ID | Payment outcomes through the inbox wait for webhook handlers |
| `workflows.pending.test.ts` | Acceptance todos only | Each title names the charge runner, webhook handlers, signed-link pages, membership import, or payments UI it needs |

The invoice engine is pure. `invoiceDetail` projects its output into the shared
`InvoiceDetail` contract and checks that lines sum to the total; it does **not**
issue or store an invoice. Calendar tests explicitly advance memberships through
the real revision-checked lifecycle. That is not an implementation of a runner.
Likewise provider success does not activate a membership in this fixture.

The transition fixture creates invoices, attempts and existing payments through
database factories. It calls `createInvoiceTransitions` with an `afterCommit`
hook that publishes through `createTransitionEffects` into `PostgresJobs`.
Assertions read payments, refunds, attempts, invoices, audit effects and their
published jobs from PostgreSQL. The real `PostgresJobs.runNext` worker runs the
registered transition handlers for receipt, activation, dunning, duplicate refund
and staff notice work. Each fixture keeps one `FakeEmail` and one `FakePayments`:
assertions check the actual messages, refund request, completed jobs and effect
audits, and one persisted activation of a pending membership linked to the invoice.
Replaying the transitions and draining again produces no duplicate side effects.
Retry jobs stay scheduled in the future. The queue is cleared between scenarios
in this file's isolated database so workers cannot claim earlier scenarios' jobs.
Both refund stories run from a normal `cardSucceeded` payment and a factory-written
payment without an attribution audit, as after a restore or upgrade.

The sequential success case preserves the first writer's local payment ID; the
concurrent case sends both caller results with `Promise.all` and checks that one
applies and one is ignored, with one payment, receipt and membership activation.
Full inbox/runner races remain todos until the charge runner and webhook handlers
can drive them. The inbox cases
mount its real public route and execute its real dispatcher through the durable
queue, using an observation handler that performs no billing work.

The workflow todos are acceptance specifications where no current callable contract
can drive the whole path. Their titles record concrete outcomes and the missing
service or screen, including dispute flags, owner email, one dashboard alert,
replay, and stale dispute outcomes waiting for webhook handlers. Another todo
checks that editing the gym's retry schedule preserves an invoice's original
dunning schedule.
In particular, the retry timeline is March 1 → March 4 → March 8 (days 3 and 7
measured from the original failure), with checks just before each deadline,
at the deadline, on replay, and after final exhaustion/success. The runner should
use the injected gym-local clock, including the daylight-saving transition.

Charge outcomes carry the processor's `latestChargeId` next to the PaymentIntent
ID, which `CardSuccess` needs. Checkout's `chargeId` is still a PaymentIntent ID;
read the charge through `findCharge`. Tests must not derive a charge ID from a
PaymentIntent ID. Annual memberships already persist an anniversary independent
of `startsOn` and the advancing `nextDueOn`; its renewal through a daily run still
waits for the charge runner.

The provider event test uses the fake provider's normalized signed envelope. The
inbox tests use synthetic Stripe envelopes and API fixtures with the real Stripe
adapter's raw-byte verification. Neither is a recording from a live Stripe
account. Payment-handler scenarios should reuse the adapter's recorded API
fixtures when enabled. No passing fake test is counted as webhook integration.
