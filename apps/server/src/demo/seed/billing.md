<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Demo billing seed

`billingSeed({ scope, clock, paymentsFor })` runs after `membersSeed`. Its provider
must belong to the current gym and declare test mode. `billingSeedPayments`
constructs that provider from a shared Stripe test account's secret/restricted key
and webhook secret. It rejects live keys before constructing a transport and live
objects before returning them. The Stripe SDK remains inside the payments module.

Customer creation uses `createCustomersService.ensureCustomer` and
`Payments.createCustomer`, including the reservation, gym/household metadata,
idempotency key, and compare-and-set. Card provisioning uses only Stripe's named
test tokens through the payments transport: `tok_visa` and
`tok_chargeCustomerFail` ([Stripe testing](https://docs.stripe.com/testing)).
The existing card handler saves the resulting processor ID and display fields;
the seed never stores a card number. Provider calls run outside transactions.
Customer and card preparation overlaps up to three households at a time. All
preparations finish before invoice generation and collection, which retain the
seed calendar and ordering. A failure drains in-flight preparations before the
billing switch is restored and sandbox rollback starts.

The seed adds three plans (adult monthly, youth monthly, annual), 21 memberships
with active/trial/pending/frozen/cancelled examples, and customers and cards for
the 14 fictional households. The runner's cycle generator creates three monthly
periods per active household, with one consolidated family invoice per period.
Elena has an annual plan. Older periods are paid in cash through the invoice
transitions; the current period is collected by the test-only runner. Grace
O'Neill and Owen Murphy have declining cards and past-due invoices. Their first
failure uses the existing default day-3/7 retry schedule. Annual renewals and the
next monthly dates remain in the future. Trial/prospect households have no invoice.

The existing go-live service enables billing for collection, confirming any
memberships an interrupted run left past due, and restores its
original value in `finally`. It leaves the member-email switch alone. The seed
sends no email or job itself: transitions record their usual auditable effects,
which the runtime publisher can deliver through the demo outbox and job queue.

An audit marker anchors the calendar to the gym's local seed date. Per-household
and final completion markers make reruns leave completed data alone even on a
later day. A card reservation blocks blind retries after 23 hours; within that
window card create/attach keys are stable. Unknown charge outcomes remain in the
runner's pending attempt for reconciliation; seeding stops instead of charging
again. The billing switch is restored when any of these steps fails.

## Composition

`createSeeds` instantiates the factory after members, passing scope, clock and
the shared test-account provider. `runSeeds` supplies it for sandbox creation and
the seed CLI from `DEMO_STRIPE_TEST_KEY` and `DEMO_STRIPE_WEBHOOK_SECRET`. Without
the key, the billing step logs a skip. The same install configuration resolves
ordinary gym-scoped payments and the install webhook; no shared key is stored
in a gym row and no per-sandbox Stripe webhook endpoint is created.

The integration tests run the factory through real sandbox creation and real
PostgreSQL, with `FakePayments`. Separate strict synthetic transport replays
exercise the real `StripePayments.createCustomer`, test-card creation/attachment,
and owned-card read. These are offline fixtures, not a live Stripe API run.
