<!-- SPDX-License-Identifier: AGPL-3.0-only -->

`createTransitionNotifications` accepts optional `sms` from
`createTransitionSmsNotifications({ settings, resolver, prepare, scope?, clock? })`.
Its receipt and dunning calls deliver both channels independently: one channel's
failure does not prevent the other, and retries use each channel's durable state.
Staff notices and staff-requested receipt resends remain email only; the resend
job passes `{ emailOnly: true }` to `receipt`.

Texts select `householdNoticePhones` for this invoice's household only: a consented
billing phone wins (including a parent without a member record); otherwise only
notices-consented members at the billing email are selected. A shared phone gets
one text for the household's children. `MemberSms` rechecks notices consent, the
phone, the gym's member-SMS switch, provider and daily cap at delivery.
`prepare(gymId)` supplies a trusted canonical origin and optional translator
independently of SMTP. Text amounts use shared minor-unit formatting.

SMS keys are `billing.sms.<purpose>:<invoiceId>:<generation>:<recipientId>`
(`receipt` or `dunning`). The suffix is the household's ID for its billing phone, so
erasing or adding a covered member never changes it, and the consented member's ID
for a fallback phone. The final check before sending supplies the covered members.
After selection, each recipient group checks the notice is still due, then commits
its own reservation, signed pay/update-card links and remembered link IDs just
before preparing its send. A group already in flight is skipped so the other
groups can proceed, and the effect then fails so a retry can send that group if
its attempt ends in a definite non-send. No token,
phone or message body goes in delivery state. Accepted
and uncertain sends never mint or send again. A `cap_reached` or `no_provider`
suppression is recorded with the link IDs, revokes its links and completes the
effect without retry or next-day delivery. An email failure cannot revive that
text on an effect retry; only its cleanup is repaired. Other definite non-sends revoke their
links and permit retry; a retry repairs any failed revocation before creating
fresh links. A crash after reservation commit keeps that attempt uncertain and
its links usable. Later groups remain available on retry. SMS never reuses email's token.

Dunning notices use the shared card minimum and currency-step check. If an invoice
cannot be charged, its email and text ask the payer to contact the gym for a manual payment,
without minting pay or card-update links. Receipts and staff notices keep their usual
behavior. Billing skips recipients whose key is already accepted or uncertain.
An in-flight key reports a conflict before SMTP preparation. Billing shares one
SMTP lookup across recipients eligible for a send and checks the origin before
reserving each key. A broken SMTP setting or origin reserves no key and mints
no link. Definite non-send cleanup
(`releaseUndisclosed` in `infra/email/deliveries.ts`) tries both revocations and
releases the reservation even if a revocation fails, since no credential was disclosed.

Every notice sends through `createEmailDeliveries`, under the key
`billing.<purpose>:<object>:<generation>`, and a staff notice under one key per recipient,
`billing.<purpose>:<object>:<generation>:<recipient hash>`. Member notices use `receipt` or `dunning`.
Staff notices use the purpose for that notice, such as `refund_missing` with the missing refund's ID.
The object is the invoice, payment or refund the notice concerns. The generation is the persisted
work that asked for it: the effect, or the receipt job for a requested resend. So a repeated job sends
nothing more, each new failure or resend has its own key, and a member's address changed between retries
gets no second notice. A member notice's key holds no address, so an erased member's address leaves
nothing in delivery records (`infra/email/README.md`). A staff notice tries every recipient before it fails, so one refused address
doesn't hold up the others, and its retry reaches only the staff it provably did not reach. A notice already accepted, or possibly
accepted, mints no links. A refused or suppressed dunning attempt revokes its links.
A worker that finds the key in flight leaves the sending worker's links alone.
A link that may have been delivered stays usable and is never sent again.

`paymentProcessing` records the intent on the invoice's processing audit and timestamps
its pending attempt when present. On a terminal invoice it updates and audits a matching
pending attempt, or writes a late processing audit for an unrecorded Checkout
intent without an attempt. The invoice keeps its terminal state. `cardSucceeded` records a settled debit as
`bank_debit`. A cycle or assignment invoice returns to past due after a bank
failure, and a past-due assignment invoice stays past due on a later card
decline. A one-off charge returns to open. A closed account is revoked by its
processor method ID and the household receives an update-method link. The
transition records `billing.payment_method.unsaved_revoked` with the invoice ID
and processor method ID when the household has no saved row for the account. The
invoice's stopped-retry audit also cancels work already queued. `processingFailed`
handles a reported failure or cancellation for the current processing Checkout
intent. It records the normalized failure code in the invoice audit. For an
unusable Checkout method it retrieves the failed intent before starting the
transaction.

`createInvoiceTransitions({ scope?, clock?, paymentsFor? })` implements the frozen
`InvoiceTransitions` interface. Its billing-local type, `BillingInvoiceTransitions`,
widens `processingFailed` to accept every normalized Checkout failure code. Issued invoices are locked for every payment,
failure and refund. Processor intent/Charge IDs and local payment/refund UUIDs
deduplicate commands. Reusing an identity with different money or ownership is
a conflict. Payment timestamps can differ between a runner result and a webhook;
the first accepted timestamp is retained. A missing attempt ID on a Checkout or
webhook does not bypass a stored intent cancellation, except that a void invoice
records a late success as a duplicate to refund it.

`voidInvoice(context, { invoiceId, reason })` voids an open or past-due invoice.
Owners and admins use the payments area's `POST /api/billing/invoices/{invoiceId}/void`
route (`refunds.create`), supplying a nonblank reason of at most 1,000 characters.
The transition locks the invoice and its pay links in Checkout's lock order,
refuses any pending or authentication-needed attempt and any stored Checkout
session or unexpired reservation, and audits `billing.invoice.voided` with the
reason and before/after state. It revokes unused pay links in the same transaction.
Link creation shares the invoice lock and refuses void invoices; a link created
while voiding waited causes a conflict so staff can retry with that link locked.
Repeating a completed void is ignored. It changes no membership or future bill;
cancelling a membership also leaves its unpaid invoices owed.

Voided invoices suppress queued dunning and retries and cannot be collected by
the runner or paid manually. A late card success, including one for an attempt
previously marked canceled, is recorded with `accepted: false`, reserves a full
duplicate-payment refund, and queues the existing durable refund and staff notice
effects. Replay creates neither another payment nor another refund. The invoice
stays void after the refund; it sends no receipt and activates no memberships.

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

Besides `voidInvoice`, `join-cleanup.ts` voids invoices for the public join's cleanup
(`public/pages/join.md`). `voidAbandonedJoinInvoice` covers an admission that was never
submitted. For a submitted join unpaid after seven days, `submittedJoinSessions` lists
the Checkout sessions the household's links started for the caller to confirm expired
with the provider, `checkSubmittedJoin` (under the caller's household lock) locks the
household's links, then its invoices, and answers `ready`, `wait` (a paid invoice, a
link that can still start Checkout, an unended reservation or a session not confirmed
expired) or `keep` (another link but a spare revoked before use, which `joinFollowedUp`
also reports before any provider call, or another invoice, a used link, a payment, attempt or saved
card, or a review hold whose latest hold audit is not the runner's overdue hold,
or one staff released),
and `voidSubmittedJoin` voids the open invoice (`billing.invoice.voided`, lines kept)
and revokes the join's link in the caller's transaction. As on any void invoice, a
manual payment recorded later is refused as a conflict, and a late card success is
recorded as a duplicate and refunded.
The cleanup stops retrying a `wait` on the 21st local day after submission and
writes `public.join.void_stalled` for staff follow-up, leaving billing intact.

Switching Stripe from test to live closes action-needed test attempts as `failed`
with `test_cleared`, clears their error, updates `resolvedAt`, and audits each as
`billing.attempt.resolved` in the switch's transaction. These attempts count as
abandoned, so they never represent a card decline or consume a retry window.

Failures update attempt diagnostics, but cannot reopen paid, refunded or void
invoices, or change the invoice for an older attempt. A cancellation is a decline
only when the member could have acted on the payment. Cancelling a still-`pending`
attempt (its intent was never confirmed) closes it `failed` with `confirm_abandoned`
and changes nothing else: no invoice status, dunning or retry effects (on the last
retry day the runner queues one more retry itself; `../runner/README.md`). Cancelling an
action-needed attempt records `intent_canceled` and is handled as a failure. Neither
cancelled intent can later record a success or another outcome. `applyChargeOutcome`
records a cancelled intent that carries a processor Charge (`latestChargeId`) as a
decline first: its confirmation reached the card and was declined before the
cancellation, even if that response was lost and the attempt is still pending. Authentication-needed
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
as accepted. TODO: replace these audit records with a dedicated effect table
and payment attribution field. The action/target audit index accelerates
these lookups; it does not replace the audit-row outbox. Audit retention must
preserve these records until the dedicated storage migration exists.

`createTransitionEffects` takes Jobs, gym settings, the same transition service,
MembershipLifecycle, a per-gym Payments resolver, notifications and a retry
callback. `publish(gymId)` dispatches up to 100 unpublished instructions from the
last 30 days with durable job idempotency keys, oldest occurrence first (audit ID
breaks timestamp ties). The query uses the gym/time index to bound history reads
to that gym's window. Publishing again after a lost
queue acknowledgement does not duplicate work. Pass
`afterCommit: (gymId) => effects.publish(gymId)` to `createInvoiceTransitions` so
work is published as soon as its transition commits; a failed publish is logged
and never fails the committed transition. `createTransitionJobs` supplies an
hourly recovery sweep and the effect handler; both are already included through
the existing billing job barrel.
The runtime supplies `recovery`, the queue's `failedJobs` and `retryFailed`
capability, to `composeBillingWebhooks` (and so `createTransitionEffects`). After publication the
hourly sweep also checks published, incomplete effects, including those older
than the 30-day publication window, in pages of 100. A job that exhausted its
twelve attempts is reset in place, preserving its ID, payload and idempotency key;
recovery never enqueues a second effect job. Recovery waits 15 minutes after the
first failure, then 30, 60, 120 and 240 minutes after subsequent exhausted batches.
Within the first 15 minutes the sweep skips the invoice lock and job reread if
the effect still has resets left. The reset count survives process restarts in
`billing.transition.effect.retried` audits. After five resets, recovery records
`billing.transition.effect.recovery_exhausted` once per recovery budget. Health's
Invoice effects tile and list read this durable audit, so they remain in error
even after queue retention removes the failed job after 90 days. Completed,
dismissed and currently recovery-exhausted effects are excluded using correlated lookups on the
`(gym_id, action, target_id)` audit index, so later sweeps do not lock an exhausted
effect's invoice again. A per-effect error is logged safely and does not stop the
remaining recoveries. Recovery rechecks the failed job under the invoice lock;
the reset and its retry audit commit in one caller-owned job transaction. The
handler checks completion and dismissal after taking that same invoice lock.
Recovered retry work
still calls the charge runner, which checks current invoice state and retry windows.
Settlement or publication failure does not stop this recovery pass.

Owners and admins can Retry or Dismiss any exhausted effect from Health, however
old it is. Retry uses that invoice lock and transaction to reset a retained failed
job or enqueue a missing job under the original effect key, and writes
`billing.transition.effect.staff_retried` with the staff actor and the ID of the
exhaustion it closes. A concurrent Retry while already queued does nothing.
Completed and dismissed effects refuse Retry.
Each staff retry starts a fresh five-reset automatic recovery budget. Recovery
counts reset audits whose occurrence time follows the staff retry. The list shows
the effect again only after a new exhaustion. Dismiss writes
`billing.transition.effect.dismissed` (handled by hand) with the staff actor
and acknowledges the effect's retained failed job in the same transaction. The
failed-jobs tile stops counting the job, and retention deletes it on its usual
schedule. A job whose effect was dismissed by a release that did not yet
acknowledge jobs on Dismiss stays counted until retention deletes it or an owner
or admin uses **Acknowledge failed jobs** on the Background jobs tile. The sweep
leaves dismissed effects alone.
Duplicate refunds keep their existing reservation, reconciliation and processor
idempotency key; a staff retry cannot reserve or refund the money a second time.

Before publishing, the hourly job settles up to 100 due, open or past-due
zero-total one-off invoices without a Checkout session and not held for review.
This recovers a crash or failed settlement after issuance, including a pack sale.
It uses `settleZero` and its usual idempotent activation effect; it creates no
payment or card attempt. An invoice that fails to settle doesn't stop the others
or the effect recovery; the job then fails and runs again next hour.
The production publisher is inert until `configureTransitionEffects(effects)` is
called. No HTTP route is added by this service.

Activation uses MembershipLifecycle after committing a payment or zero-value settlement. It activates
pending/trial memberships on membership line items, and skips active, frozen and
cancelled memberships; a sign-up fee alone does not end a trial. Revision checks
protect concurrent membership edits. Activation derives the member's status from
all their memberships in the same revision-guarded, audited transaction: any
active membership takes priority, even while another trial remains. See the
[membership status rule](../memberships.README.md#member-status).
Replaying a partially completed activation
does not activate a membership twice. When its loaded invoice has a pack sale,
the effect then calls the packs grant directly,
which grants a paid or partially refunded pack sale once, including zero settlements.
The optional `afterInvoicePaid(gymId, invoiceId)`
then runs for every paid or zero-settled invoice, however it was paid; it must be
idempotent, since the effect runs it again until it completes, and a throw retries the
effect job.

The separate hourly `billing.payments.settle_lapsed` sweep can settle a dead
`refund_duplicate` reservation once its 23-hour retry window and five-minute clock-skew margin have elapsed, provided
it is tagged, still pending, and has no processor ID. It reads Stripe refunds and
records a match or releases an unsent reservation; it does not issue a new refund.
Reservations with a processor ID, older untagged reservations, and work inside the
window still depend on their effect or webhook processing. Effect recovery retains
the existing reconciliation and idempotency-window checks before any refund call.

A refund that changes a pack sale's invoice to `refunded` queues `reverse_credits` in its
transaction. It reverses only unused credits from that sale's lot. Partial refunds
queue no reversal. Both credit operations lock invoice then member and audit with
the ledger write. A reversal still runs if the refund later fails and reopens the
invoice; that failure never restores credits. A delayed grant after a full refund
is suppressed by the durable reversal command, independently of the refund audit
snapshot. Other invoices queue no credit reversal. See [class packs](../packs/README.md)
for expiry and replay rules.
The lookup first finds the invoice's indexed `billing.invoice.refunded` audit time,
then searches commands from that time onward; it never reads the audit snapshot's payload.

Cycle failures enqueue dunning and one schedule per invoice. The first failure
reads the gym's billing retry days (default `[3, 7]`) and saves them with
`billing.invoice.dunning_started`. The gym can choose 0 to 4 strictly increasing
whole days from 1 to 28. An empty list leaves the invoice past due with one
dunning email and no retry jobs. Retries count from the first failure at 09:00
in the gym's timezone, including DST changes. Repeated failures and settings
edits never reset that schedule or move queued jobs. Legacy invoices keep their
original effects and jobs; the runner uses `[3, 7]` when their audit has no saved days.
Each failure of the latest attempt sends one dunning email, up to five from the
first failure and four automatic retries when member emails are enabled.
Dunning for an older attempt is suppressed; an abandoned newer attempt
(`create_abandoned` or `confirm_abandoned`) doesn't count as newer. Retry jobs recheck
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

An additional card payment reserves its full duplicate refund, tagged in the same
transaction, and queues a staff notice. The worker reconciles existing refunds before
calling Payments.refund, using one stable idempotency key and the PaymentIntent ID
expected by that interface. A lost response for a tagged reservation is recovered
from `Payments.listRefunds(paymentIntentId)`, taking only the refund that names its
row. A reservation from before `refunds.tagged_at` keeps taking the payment's single refund and is sent with
no reservation ID, as it was, and still scans provider changes. It never retries
a create outside a conservative 23-hour idempotency window. Past it, a tagged
reservation uses the staff refund settlement rule: record the refund naming the
row, or release the row when none matches. The effect then completes without
sending a new refund. A refund that names the row but has other money counts as
external past the window, as it does for the webhook, so the row is released; inside
the window it stops the effect. Ambiguous outcomes remain errors for staff resolution;
untagged rows retain their existing reconciliation behavior. A failed
automatic refund is recorded as failed, which queues the failed-refund staff
notice below, and the effect completes. A reservation released with no processor
refund (a dashboard refund left it no room, or the worker, hourly job or a staff
request settled it past the window) also ends the effect, and queues a `notice: 'duplicate_released'` staff
notice. It runs without a delay and names what the payment's succeeded refunds leave
unrefunded. An external refund's identity, reservation releases and recording share
one invoice lock and transaction, so the notice counts the refund that caused the
release once it has succeeded. If recording fails, all releases and their notices roll back too.
Processor-bound pending refunds are read outside the transaction and terminal outcomes
are reconciled under the lock before deciding which unsent reservations no longer fit.
A pending row the processor reports missing (the read answers unknown with `missing: true`:
Stripe answered not found for the refund itself, because it was deleted or the Stripe
account changed) is released only when the external refund needs
its room, newest first and before any unsent reservation, and only as far as that need
goes. Each such release records the row `failed` and queues one `notice: 'refund_missing'`
staff notice naming the invoice and amount; a replayed webhook finds the row failed and
queues none. A missing row the external refund fits beside stays `pending`. A read that
throws fails the whole write, so a network error never releases anything.

New failure audits on the refund record `releasedMissing` and, for a release as missing,
the notice's `missingEffectId`. Success and verified failure reports check the found and
failure-first markers before looking up provenance. They read the indexed refund audits
for new failures and search for the matching `refund_missing` effect for older failures.

A release as missing stands if Stripe later reports the released refund `succeeded`: the row stays `failed`
and the invoice keeps its status and refunded total, even when the two refunds together
exceed the payment. The first such report writes a `billing.refund.missing_found` audit,
queues one `notice: 'refund_found'` staff notice naming the invoice and amount, and logs
`billing.refunds.missing_found` at warn with the gym, invoice and refund row IDs. The report
counts as handled (the transition answers `ignored`), so the webhook completes, and staff
reconcile the payment by hand; a replay writes, queues and logs nothing more. A pending
`refund_missing` notice checks for that success before delivery and skips the obsolete email.
If Stripe then reports the same refund `failed`, the found notice's correction is no longer
due. Billing still leaves the row `failed` and the invoice, its refunded total, reservations
and credits as they are; the first such report writes a `billing.refund.missing_found_failed`
audit, queues one `notice: 'refund_found_failed'` staff notice in the same transaction, and
logs `billing.refunds.missing_found_failed` at warn with the gym, invoice and refund row IDs.
Both of these warnings are logged after the transaction commits. A rolled-back transaction emits
neither of them (`billing.refunds.unverified`, below, reports a refusal and is logged before it rolls back). The audit remains the durable record if the process exits before logging,
and it prevents duplicate follow-ups and warnings on replay. A failure needs a `billing.refund.missing_found`
audit to create the follow-up, and a cancellation never creates it.
The webhook and reconciliation writers read Stripe before they take the invoice lock, so two
reads of the same released refund can commit in either order. A verified `failed` report
that commits before any `billing.refund.missing_found` audit confirms the release: the
first one writes a `billing.refund.missing_failed_before_found` audit (`processorId`,
`amountCents`, `currency`) under the invoice lock and answers `ignored`. It queues no
notice and changes neither the row nor the invoice, reservations or credits, and the
release's own `refund_missing` notice still goes out. A later `succeeded` report for that
refund, such as one Stripe returned before the failure but whose write commits after it,
finds this audit and records nothing: no found audit, no `refund_found` notice and so no
follow-up. Only the processor refund path writes this audit, and only for a row released
as missing whose processor ID matches the report; a cancellation, a failure for an ordinary
failed refund, and a plain `refund` call never do, and a replay adds nothing. A `failed`
read in `pendingRefunds` counts as such a report too: a write for another refund may read a
row while it is still pending, and a concurrent external refund may release that row as
missing before the write takes the lock. Under the lock, before its own write and on every
path (including a report for a refund already recorded), the transition applies each read
whose processor ID, amount, currency, gym and charge match a failed row: a released row
with no found audit gets the failure-first audit above, one with a found audit gets the
follow-up above, and any other failed row is left alone.
When success commits first, it records the found audit and queues `refund_found`. The failure
that commits after it records the follow-up audit and queues `refund_found_failed`. A queued
`refund_found` notice checks under the invoice lock for the failure audit and skips its email.
One already past that check may still reach staff, so
the follow-up stands on its own: it names the invoice and amount, says Stripe now reports
the refund failed and billing never changed the invoice, and asks every recipient to check
the payment in Stripe and billing and recheck any earlier manual correction. Each staff
recipient gets it once, under the usual per-recipient delivery key.
An unread, unverified or mismatched pending row still reserves its full amount. Unverified
means any other unknown read: the refund's charge or parent intent is missing, its gym
metadata isn't this gym's, or the read is uncertain. Such a row forces a retry whenever
the external refund still needs room after any missing rows are released, whether or not
an unsent reservation could make that room, and each refusal logs
`billing.refunds.unverified` at warn with the gym, invoice and refund row IDs; once the
processor confirms the refund, its outcome is recorded as usual. An external refund
that fits records normally, including when a pending row was linked after those reads.
The named `InvoiceTransitions.processorRefund` method accepts the processor refund,
those reads and the processor IDs reported missing; it first refuses as not found a refund whose gym metadata, charge or
currency is not this payment's, then selects an existing processor ID or matching app
reservation and records the outcome atomically. Plain `refund` handles local reservations and their outcomes;
processor reports cannot be passed to it. The fake and real transitions run the same
processor ownership, identity, reservation, cancellation provenance, release-notice and rollback contract cases.
A pending refund doesn't count, because it can still be canceled; if nothing is
left, no email is sent. The worker's refund is never reduced to the remainder,
since that would change a retried request. A pending processor refund is stored for
subsequent webhook/reconciliation updates.
Refunds of excess payments never reduce the original invoice's paid balance.
Pending refunds reserve their amounts, failed and canceled reservations release
them, and successful refunds advance accepted payments to partial/full refund.
Refund states move forward only, with one exception: when the processor reports
that a refund it reported as successful has failed (the stored refund has the same
processor ID), the refund moves from `succeeded` to `failed`, releasing its amount.
The invoice status is recomputed from its remaining successful refunds (back to
`paid` or `partially_refunded`) and audited as `billing.invoice.refund_reversed`;
the refund change is audited as `billing.refund.reversed`. A refund without a
processor ID (a cash or check refund) never reverses, and a failed or canceled
refund never moves again. A processor cancels a refund only before it completes,
so a canceled report for a successful refund is ignored.
Every processor refund that ends `failed` (recorded failed from the start, moved
from `pending`, or reversed after success), apart from a pending row released as
missing (above), queues one `staff_notice` effect with
`notice: 'refund_failed'` in the same transaction, which tells the gym's staff
recipients (owners and admins at runtime) that the payer was not refunded; a
reversal's email says the refund had been reported successful. For a class pack
sale whose full refund had already reversed unused credits, the email also names
those credits, which staff add back by adjustment if the payer is still owed the
pack. A class pack paid after its member was erased grants no credits and queues a
`notice: 'credits_not_granted'` staff notice (once per sale) so staff can refund
the payer. Any other reservation the app releases on its own (a system actor, with no
processor refund) once its 23-hour retry window has passed queues a
`notice: 'refund_released'` staff notice naming the invoice and the amount, and saying
the request never reached Stripe: staff last saw it pending, and the payer may still be
owed it. That covers the hourly job settling a staff refund no Stripe refund names,
including one on a payment marked as test, and a dashboard refund that outran a staff
refund past its window. A duplicate payment's reservation released this way gets the
`duplicate_released` notice instead. A staff request that releases one
is answered directly and queues none, and a reservation a dashboard refund outran inside
the window queues none either. The fake sends its release notices from plain `refund`,
as the real transitions do, so a release through `refund` and one a processor refund
forces notice the same way. The window
constant lives in `core/interfaces/invoice-transitions.ts` and is re-exported by
`lapsed-refunds.ts`; the send records that keep a staff retry
still in flight from being released, and the settling rule, live in `lapsed-refunds.ts`
(see the payments README). Because a failed
refund never moves again, a replayed webhook or rerun reconciliation queues no
second notice. A refund canceled at the processor (the Stripe adapter reports it as
`canceled`) is recorded as `canceled` and released like a failed one. If the app created
it (a staff refund or an automatic duplicate-payment refund), one `refund_canceled`
staff notice names the invoice and amount and asks staff to check what the payer is
still owed. Stripe does not identify who canceled it. A refund created outside the app
sends no cancellation notice, including one first recorded as pending. A canceled
automatic duplicate-payment refund completes its effect without retrying the refund.

A refund that names a tagged reservation released before it had a processor ID and later succeeds is recorded
as an external refund. `notice: 'refund_arrived'` tells staff it reached Stripe,
correcting the release notice once; a durable audit marker deduplicates this follow-up.
A terminal invoice never moves for failed, action-needed and cancellation outcomes.
An attempt already resolved on it stays as recorded. An attempt still pending, processing or action-needed
(a charge that crossed a manual payment, say) is closed, so reconciliation stops
listing it. Late card successes still record and refund duplicates.

`createTransitionNotifications` sends localized receipts, signed pay/update-card
links, and staff notices (a duplicate card payment, a failed processor refund, a
canceled app-created refund, a missing processor refund, a later success for one and a failure after that success, a duplicate payment's released reservation, or a staff refund released after its window).
Runtime must supply a gym SMTP resolver (or demo outbox), trusted canonical origin and staff recipients; `prepare` may also
return the gym's name. A receipt uses the shared email layout (`renderReceipt` in `emails/billing/transitions.ts`)
headed with that name, or "Your gym" without one; dunning and staff notices stay one plain paragraph. Household email respects
the gym's email switch and matching member opt-outs/deliverability, through the
household recipient helper shared with signed-link delivery and billing alerts. Receipts and
dunning recheck the persisted switch immediately before each send, after preparing
the transport and links. Suppression revokes undisclosed dunning links. Staff
notices remain exempt from the member-email switch. Tokens are
never persisted in effect/audit payloads; definite non-sends revoke their undisclosed links.
Messages live in `locales/en/billing/transitions.json`; a supplied translator
falls back to the English catalog for missing keys.
The durable delivery key prevents another attempt after an accepted or uncertain
send. Dunning reserves that key and creates both signed links in the same short
transaction, remembering only their IDs. A crash before commit leaves neither
link nor reservation. A definite non-send revokes the links; an uncertain send
keeps them usable and a retry mints no new pair. Outcome-write failures are
reported rather than swallowed. Ordinary transition/webhook replay creates one
delivery job.

At startup, `composeBillingWebhooks` calls `configureTransitionEffects` and shares the
transition service with the webhook handlers, charge runner, staff payments and effect worker.
Its `afterCommit` callback publishes queued work, including missing-refund staff notices.
The runtime supplies the gym’s mail transport and resolves owner and admin email addresses.
Tests compose the real membership service, notification helper,
signed-link service and job registrations with FakePayments/FakeJobs/FakeEmail
against PostgreSQL, plus recorded synthetic Stripe fixtures through StripePayments.
