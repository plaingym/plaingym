<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Staff payments

`createPaymentService` implements the staff invoice list/detail, one-off invoice
issuance, saved-card collection, cash/check recording, refunds, masked saved-card
management, and receipt resend. `createPaymentRoutes` mounts the shared billing
contracts. The invoice navigation and member profile tab are registered by
`features/billing/invoices/registrations.ts`.

One-off charges use `calculateOneOffInvoice`, including immutable tax snapshots,
and allocate a gym-local invoice number. They never join a household billing
cycle. Only `manualPayment`, `refund`, and `applyChargeOutcome` change an issued
invoice's state. A failed or action-required one-off stays open without dunning.

Card collection calls the injected runner with `{ mode: 'staff', context }`.
The runner owns reservations, provider calls and reconciliation; a staff click
never adopts or drives an existing pending attempt. All skip reasons use the
existing error envelope's `details.reason` array. A zero-value invoice is refused
because the charge response requires an attempt. Without a runner, collection
returns unavailable. Card charges still require billing enabled, an active saved
card and no review hold or open dispute.

Cash/check and runner collection share `releaseActionNeeded` and
`releaseCheckout`. They cancel action-needed intents and expire open Checkout
sessions outside transactions, applying outcomes through reconciliation and the
invoice transitions. Reconciliation clears an expired Checkout reference under
the invoice lock, so cash works immediately without a webhook. A cancellation or
expiry that reveals success pays the invoice and refuses cash as already paid.
Pending attempts still block cash; unavailable Stripe blocks any required release.

Owners and admins may release a review hold through the audited `release-hold`
action, which only clears `needsReview` under the invoice lock. It never charges.
Any staff member with `payments.record` may record cash/check on a held invoice;
the recorded payment confirms and clears the hold with an audit linked to that
payment. The transitions handle a card outcome that races another payment.

Refunds reserve their balance through the transitions before calling Stripe;
pending refunds count against the refundable balance. A lost response leaves the
reservation pending, and an explicit retry reuses that reservation's key inside
the 23-hour window. Older pending refunds require reconciliation. A pending refund
with a null reason can resume after a crash and save the requested reason.
Manual refunds record money already returned to the payer. Routes restrict refunds to owners and
admins; front desk may collect payments and remove a card.

Removing a card first revokes it locally and clears its default flag, then queues
a detach retry and attempts detachment outside the transaction. Revoked rows
remain visible so staff can retry removal after an outage. No processor IDs leave
the staff API. `detachCard(gymId, processorId)` delegates to the gym's
`Payments.detachPaymentMethod`, idempotent for missing and already detached cards.
Without that operation removal returns unavailable.
The Jobs interface rejects enqueue inside a transaction and provides no
transactional enqueue. If a crash or enqueue failure occurs after local revocation,
staff can use "Retry card removal" on the retained revoked card; that queues the
same deduplicated detach job again before the immediate provider call.

Pay links use the existing signed-link creation/send contracts, with purpose
`pay_invoice`, household ID, invoice ID, and a seven-day expiry. Creation can show
a link to copy; sending uses the configured gym mail delivery. No Checkout session
identifier is substituted for a signed-link identifier. Redemption belongs to the
signed-link public pages.

Receipt view uses the invoice's stored lines, payments, and refunds. Resend queues
`billing.payments.receipt`; `createPaymentJobs` delegates delivery to the shared
transition notifications, honoring the gym's email switch and member preferences.

## Composition

Runtime composition supplies `configurePayments(createPaymentService({ settings,
clock, jobs, paymentsFor, transitions, detachCard, runner }))`, constructed after the
runner and sharing the payments resolver
and invoice transitions with the webhook composition. It also supplies
`configurePaymentDelivery({ notifications, detachCard })` before starting jobs.
Both routes and jobs already contribute through their existing area parts.
The card-detach adapter operation and production wiring require integration-owner
changes outside this area's ownership. Tests exercise the real area registrations
through `createApp`, the real PostgreSQL transitions, and the receipt/detach jobs;
the Stripe decline path also exercises synthetic Stripe API fixtures.
