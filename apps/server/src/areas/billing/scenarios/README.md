<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing scenarios

Run from the repository root with Node 24.22.1:

```sh
pnpm exec vitest run apps/server/src/areas/billing/scenarios
```

Leave `DATABASE_URL` unset. The normal Vitest integration setup starts disposable
PostgreSQL and clones a migrated database per test file. Fixtures use a separate
gym per scenario, `forGym`, the real catalog and membership services, the frozen
`MembershipLifecycle`, and an injected `TestClock`. No wall-clock sleeps, live
Stripe credentials, database mocks, new production endpoints or runtime wiring.

| File | Runnable coverage | Dependencies still pending |
| --- | --- | --- |
| `calendar-pricing.test.ts` | Catalog → persisted membership → invoice calculation: leap/non-leap month ends, year rollover, gym-local trial expiry, DST-spanning daily proration, consolidated family and independent annual dates, freeze/resume/cancel, discounts and inclusive/exclusive noncompounded tax, snapshot isolation from catalog edits, household/gym isolation | Durable issuing, numbering, catch-up and concurrent runs: C2.1; imported leap-day anniversary: C1.8 |
| `payment-provider.test.ts` | Calculated invoice → `Payments` fake: create/confirm idempotency, decline and all SCA normalization shapes, lost-response lookup, payment/setup Checkout and saved method, partial/full refunds, signed provider event and current-object lookup | Actual activation/state writes: C1.6; inbox/handler delivery: C1.5/C2.2; scheduled retries/reconciliation: C2.1 |
| `transitions.pending.test.ts` | All scenarios deliberately skipped or todo | C1.6 transition assertions compile against its frozen fake; workflow todos name their C1.5/C1.8/C2.x dependencies |

The invoice engine is pure. `invoiceDetail` projects its output into the shared
`InvoiceDetail` contract and checks that lines sum to the total; it does **not**
issue or store an invoice. Calendar tests explicitly advance memberships through
the real revision-checked lifecycle. That is not an implementation of a runner.
Likewise provider success does not activate a membership in this fixture.

Before enabling the transition cases, replace their frozen fake fixture with the
real C1.6 PostgreSQL service, persist invoice/attempt fixtures, and observe durable
payment, refund, audit and job rows. The two delivery-order cases currently specify
transition idempotence only: enable the separately listed inbox/runner scenarios
through their real entry points when C1.5, C2.1 and C2.2 merge. Merely removing
`describe.skip` would test the reference fake, not the implemented workflow.

The workflow todos are acceptance specifications where no current callable contract
can drive the whole path. Their titles record concrete outcomes and dependency IDs.
In particular, the retry timeline is March 1 → March 4 → March 8 (days 3 and 7
measured from the original failure), with checks just before each deadline,
at the deadline, on replay, and after final exhaustion/success. The runner should
use the injected gym-local clock, including the daylight-saving transition.

Contract requests raised for integration:

* Charge outcomes now carry the processor's `latestChargeId` next to the
  PaymentIntent ID, which `CardSuccess` needs. Checkout's `chargeId` is still a
  PaymentIntent ID; read the charge through `findCharge`. Tests must not invent a
  charge ID from a PaymentIntent ID.
* Publish controllable runner/retry/reconciliation and inbox/handler entry points
  with observable durable effects. No frozen service signature currently expresses
  scheduled retries or webhook delivery, so those workflows remain todo instead of
  adding a test-only billing engine.
* Persist the imported annual anniversary (C1.8), distinct from `startsOn` and the
  advancing `nextDueOn`, before enabling the imported leap-year renewal scenario.

The provider event test uses the fake provider's normalized, signed envelope, not
a recorded Stripe payload. Handler/inbox scenarios must reuse the adapter's recorded
Stripe fixtures when enabled. No passing fake test is counted as webhook integration.
