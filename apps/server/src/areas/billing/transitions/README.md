<!-- SPDX-License-Identifier: AGPL-3.0-only -->

`createInvoiceTransitions({ scope?, clock? })` implements the frozen
`InvoiceTransitions` interface. Issued invoices are locked for every payment,
failure and refund. Processor intent/Charge IDs and local payment/refund UUIDs
deduplicate commands. Reusing an identity with different money or ownership is
a conflict. Payment timestamps can differ between a runner result and a webhook;
the first accepted timestamp is retained. A missing attempt ID on a Checkout or
webhook does not bypass a stored intent cancellation.

Failures update attempt diagnostics, but cannot reopen paid, refunded or void
invoices, or change the invoice for an older attempt. Authentication-needed
attempts ignore generic failure snapshots. `applyChargeOutcome` accepts the
normalized `Payments` outcome, maps every `action_required` to `requires_action`,
and ignores pending/unknown outcomes. Consumers must obtain current provider
state, rather than apply old event snapshots. A success requires the actual
processor Charge ID as well as the PaymentIntent ID; the current payments
interface supplies only the latter (an open interface CCR). Do not invent a
Charge ID in production.

Payments, attempt resolution, invoice changes, audits and follow-up instructions
commit together. Work is written as append-only `billing.transition.effect.*`
audit records because the frozen Jobs interface cannot enqueue in a transaction.
An explicit `accepted` marker in the payment audit distinguishes an excess card
payment from the invoice's settlement. Legacy payments without that marker count
as accepted. These are local `TODO(CCR)` workarounds for a dedicated effect table
and payment attribution field; no frozen schema, infrastructure or interface is
changed. Audit retention must preserve these records until that migration exists.

`createTransitionEffects` takes Jobs, gym settings, the same transition service,
MembershipLifecycle, a per-gym Payments resolver, notifications and a retry
callback. `publish(gymId)` dispatches up to 100 unpublished instructions with
durable job idempotency keys. Publishing again after a lost queue acknowledgement
does not duplicate work. `createTransitionJobs` supplies the minute publisher and
effect handler; both are already included through the existing billing job barrel.
The production publisher is inert until `configureTransitionEffects(effects)` is
called. No HTTP route is added by this service.

Activation uses MembershipLifecycle after committing the payment. It activates
pending/trial memberships on membership line items, and skips active, frozen and
cancelled memberships; a sign-up fee alone does not end a trial. Revision checks
protect concurrent membership edits. Replaying a partially completed activation
does not activate a membership twice.

Cycle failures enqueue dunning and one schedule per invoice: days 3, 7 and 14 at
09:00 in the gym's timezone, including DST changes. Repeated failures never reset
that schedule. Dunning for an older attempt is suppressed. Retry jobs recheck
unpaid state and billing enablement; the injected runner must also check these
when reserving the attempt and expire/reconcile open Checkout sessions before
charging. Paid invoices suppress queued dunning/retries. The last unpaid retry
leaves the invoice past due. One-off failures return the invoice to open and
never enqueue dunning or retries.

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
The English catalog lives here temporarily because the locale/template stubs are
outside this task's ownership; moving it to `locales/en/billing/transitions.json`
is a CCR. A supplied translator falls back to these messages for missing keys.
SMTP delivery is at least once if a process dies after SMTP accepts a message but
before the completion audit commits; transport-level exactly-once delivery is not
provided by Email. Ordinary transition/webhook replay creates one delivery job.

Integration wiring: construct one transition service and inject it into the
runner, webhook handlers, manual-payment/refund consumers and effect worker;
inject the real membership lifecycle and per-gym payment/email resolvers; call
`configureTransitionEffects`. The retry consumer is injected when the charge
runner is assembled. Runtime composition is integration-owned and is unchanged
by this task. Tests compose the real membership service, notification helper,
signed-link service and job registrations with FakePayments/FakeJobs/FakeEmail
against PostgreSQL, plus recorded synthetic Stripe fixtures through StripePayments.
