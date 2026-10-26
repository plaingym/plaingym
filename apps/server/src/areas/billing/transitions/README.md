<!-- SPDX-License-Identifier: AGPL-3.0-only -->

`createInvoiceTransitions({ scope?, clock? })` implements the frozen
`InvoiceTransitions` interface. Issued invoices are locked for every payment,
failure and refund. Processor intent/Charge IDs and local payment/refund UUIDs
deduplicate commands. Reusing an identity with different money or ownership is
a conflict. Payment timestamps can differ between a runner result and a webhook;
the first accepted timestamp is retained. A missing attempt ID on a Checkout or
webhook does not bypass a stored intent cancellation.

`settleZero(context, { invoiceId })` settles an open or past-due zero-value invoice
under its invoice lock, provided it has no accepted payments. It sets `paid` and
`paidAt`, audits `billing.invoice.settled_zero`, and queues the same membership
activation effect as a payment. It creates no payment row and no receipt email.
Replay and concurrent settlement are ignored after the first commit; non-zero,
draft, void and processing invoices are refused. The in-memory fake implements
the same transition and accepts an optional clock as its third constructor argument.
The runner checks billing enablement and review holds before calling it, without
resolving a payment provider, checking a saved card, reserving an attempt or
touching Checkout. Thus free plans and full family discounts can activate pending
memberships through the ordinary effect job.

Failures update attempt diagnostics, but cannot reopen paid, refunded or void
invoices, or change the invoice for an older attempt. Authentication-needed
attempts ignore generic failure snapshots. `applyChargeOutcome` accepts the
normalized `Payments` outcome, maps every `action_required` to `requires_action`,
and ignores pending/unknown outcomes. Consumers must obtain current provider
state, rather than apply old event snapshots. A success requires the actual
processor Charge ID as well as the PaymentIntent ID: `applyChargeOutcome` takes
it from the outcome's `latestChargeId` unless the caller passes one. Never derive
a Charge ID from a PaymentIntent ID.

Payments, attempt resolution, invoice changes, audits and follow-up instructions
commit together. Work is written as append-only `billing.transition.effect.*`
audit records because the frozen Jobs interface cannot enqueue in a transaction.
An explicit `accepted` marker in the payment audit distinguishes an excess card
payment from the invoice's settlement. Legacy payments without that marker count
as accepted. These are local `TODO(CCR)` workarounds for a dedicated effect table
and payment attribution field; no frozen schema, infrastructure or interface is
changed by the outbox implementation. The action/target audit index accelerates
these lookups; it does not replace the audit-row outbox. Audit retention must
preserve these records until the dedicated storage migration exists.

`createTransitionEffects` takes Jobs, gym settings, the same transition service,
MembershipLifecycle, a per-gym Payments resolver, notifications and a retry
callback. `publish(gymId)` dispatches up to 100 unpublished instructions from the
last 30 days with durable job idempotency keys. Publishing again after a lost
queue acknowledgement does not duplicate work. Pass
`afterCommit: (gymId) => effects.publish(gymId)` to `createInvoiceTransitions` so
work is published as soon as its transition commits; a failed publish is logged
and never fails the committed transition. `createTransitionJobs` supplies an
hourly recovery sweep and the effect handler; both are already included through
the existing billing job barrel.
The production publisher is inert until `configureTransitionEffects(effects)` is
called. No HTTP route is added by this service.

Activation uses MembershipLifecycle after committing a payment or zero-value settlement. It activates
pending/trial memberships on membership line items, and skips active, frozen and
cancelled memberships; a sign-up fee alone does not end a trial. Revision checks
protect concurrent membership edits. Replaying a partially completed activation
does not activate a membership twice.

Cycle failures enqueue dunning and one schedule per invoice: days 3 and 7 at
09:00 in the gym's timezone, including DST changes. Repeated failures never reset
that schedule. Each failure of the latest attempt sends one dunning email, so a
member gets up to three. Dunning for an older attempt is suppressed. Retry jobs recheck
unpaid state and billing enablement; the injected runner must also check these
when reserving the attempt and expire/reconcile open Checkout sessions before
charging. A completed Checkout reconciled to paid is a skip, not a failed retry.
The runner also cancels an older action-needed intent before reserving another
attempt and applies the cancellation result; if the old intent succeeded, it
settles the invoice instead of creating another charge. Paid invoices suppress queued dunning/retries. The last unpaid retry
leaves the invoice past due. One-off failures return the invoice to open and
never enqueue dunning or retries.

Runner collection is explicit for staff one-offs. Daily collection includes only
cycles and assignment one-offs; the assignment route invokes `collectAssigned`
after commit for immediate proration/fee collection. Staff may deliberately
retry a declined one-off through the runner's user-attributed charge option.
Provider failures remain pending for reconciliation; skips carry reason codes,
and daily failures retain their invoice ID and message. Dispute reconciliation
matches webhook rules (reject a different dispute, preserve won/lost, audit
`billing.invoice.disputed` before/after); it does not change payment state here.

An additional card payment reserves its full duplicate refund and queues a staff
notice. The worker reconciles existing refunds before calling Payments.refund,
using one stable idempotency key and the PaymentIntent ID expected by that
interface. A lost response is recovered from provider changes. It never retries
a create outside a conservative 23-hour idempotency window; ambiguous, missing,
failed or mismatched provider outcomes remain errors for staff resolution. A
pending processor refund is stored for subsequent webhook/reconciliation updates.
Refunds of excess payments never reduce the original invoice's paid balance.
Pending refunds reserve their amounts, failed reservations release them, and
successful refunds advance accepted payments to partial/full refund only.

`createTransitionNotifications` sends localized receipts, signed pay/update-card
links, and staff notices. Runtime must supply a gym SMTP resolver (or demo
outbox), trusted canonical origin and staff recipients. Household email respects
the gym's email switch and matching member opt-outs/deliverability. Tokens are
never persisted in effect/audit payloads; failed deliveries revoke their links.
Messages live in `locales/en/billing/transitions.json`; a supplied translator
falls back to the English catalog for missing keys.
SMTP delivery is at least once if a process dies after SMTP accepts a message but
before the completion audit commits; transport-level exactly-once delivery is not
provided by Email. Ordinary transition/webhook replay creates one delivery job.

Runtime wiring: nothing in the runtime calls the transitions yet, so
`configureTransitionEffects` is not called and the hourly sweep does nothing.
The first consumer to be wired (charge runner, webhook handlers, manual payments
and refunds) constructs one transition service with `afterCommit`, injects it
into every consumer and the effect worker, gives the worker the real membership
lifecycle, per-gym payment and email resolvers and the runner's retry callback,
and calls `configureTransitionEffects`. Tests compose the real membership service, notification helper,
signed-link service and job registrations with FakePayments/FakeJobs/FakeEmail
against PostgreSQL, plus recorded synthetic Stripe fixtures through StripePayments.
