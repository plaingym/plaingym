<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing webhook handlers

`registerBillingWebhookHandlers(inbox, { transitions, scope?, clock? })` registers
intent success/failure/action-needed events, completed Checkout, successful setup,
manual and automatic payment-method updates, Charge refunds, refund lifecycle
events, and dispute created/updated/closed events. Call it before starting the
worker. Handlers retrieve current provider objects from verified references;
unknown or ambiguous dependencies remain retryable.

Intents use `applyChargeOutcome`; payment Checkout uses `cardSucceeded` without
an attempt ID. Charge IDs come from `latestChargeId`. Both paths request
`findCharge(reference, { includeSuccessTime: true })` and use the returned
`succeededAt` for payment and invoice timestamps, including delayed delivery and
replay. A missing success timestamp is retryable, never replaced by processing
time. Matching checks the gym, invoice, stored attempt/payment identities and
household customer. Missing invoice metadata can be recovered from the stored
payment or attempt. Failures without a runner attempt do not start dunning.

Dashboard refunds and disputes match through their parent PaymentIntent, not
their own metadata. `charge.refunded` uses the intent-scoped, paginated
`Payments.listRefunds(intentId)` and re-reads each returned refund before applying
it. No handler calls `listChangesSince`. A refund arriving before success first
applies the current successful payment with its provider timestamp. Refunds use
the transition service, retaining an existing local refund/reservation ID or a
deterministic UUIDv5 for a new processor refund. Duplicate-payment refunds reuse
the worker's reservation.

Disputes update only the invoice's dispute ID/status, under its row lock, with an
audit. `won`, `lost`, and `closed` are terminal and cannot be reopened. The adapter
normalizes closed inquiries, refunded disputes, and prevented disputes to
`closed`; this does not assert that either party won. Multiple dispute IDs on one
invoice require staff resolution rather than overwriting the earlier dispute.

Completed setup collects the attached card for the existing household customer.
Payment Checkout collects only when `session.savesCard` is true; a payment that
does not save a card can complete without an attached method. A card-saving
session whose method has not attached remains retryable after its payment commits.
Replaying it does not pay twice.

The method's immutable processor creation time is stored in nullable
`payment_methods.processor_created_at`. Under the household row lock, a collected
card becomes default only when its processor time is newer than the current
default's; null counts as older, and processor ID breaks equal-time ties. There
is no collection audit watermark or payment-history lookup. Reverse and concurrent
deliveries converge on the newer card. `payment_method.updated` and
`payment_method.automatically_updated` refresh only known cards, including expiry
and processor time, without changing the selected default. No event re-enables a
revoked card. Changes retain ordinary payment-method audits.

## Production composition

`composeBillingWebhooks` constructs one `createInvoiceTransitions` service with
`afterCommit: gymId => effects.publish(gymId)`, the real membership lifecycle,
`createTransitionNotifications` and `createTransitionEffects`. It registers the
handlers and calls `configureTransitionEffects`. Its return value contains
`transitions`, `effects`, and `attachRetry`.

Runtime creates the composition first, constructs its runner using the returned
transitions, and then calls `billing.attachRetry(runner.retry)`, all before worker
startup. Until attached, retry execution throws
`Billing retry runner is not configured`; it never silently completes. Other
billing consumers share the returned transition service.

Supply the same payments resolver, Postgres jobs, gym settings, clock,
`prepare(gymId)` for gym SMTP or demo outbox and canonical origin, and
`staffRecipients(gymId)` for owner/admin notices. The existing transition job
barrel already registers the effect worker and hourly recovery publisher; do not
register those jobs twice. Runtime wiring lives in `core/runtime.ts`.

Events processed before handlers are installed have no billing side effects.
Use the existing `replay --gym` command for those events after wiring the handlers.

## Verification

`handlers.test.ts` uses isolated PostgreSQL, the real transitions and effects,
the adapter's recorded intent tapes and `stripe.handlers.synthetic.json`.
The latter records synthetic `StripeFixtures` API exchanges, not a live Stripe
account. Strict replay has no network fallback. To regenerate it intentionally,
set `RECORD_C22_FIXTURES=1` for this test file, then rerun without that variable.
Every direct handler test rejects any call to the payment change feed. The
composition test uses production `createApp`, real inbox route/job registrations,
and a signed stale failure delivery that resolves to a current successful payment;
it asserts one paid invoice, payment and receipt after replay.
