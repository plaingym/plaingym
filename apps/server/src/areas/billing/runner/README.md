<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Charge runner

Each completed restore report records `stripeMode` from the provider's `keyMode`
(or null without a known mode). Go live accepts a Stripe report only for the mode
currently saved, so checking a test account does not clear live billing. Account
IDs are not exposed by the payments interface.

`createChargeRunner({ scope?, clock?, settings, transitions, payments, jobs, staleAfterMs? })`
exposes the same controllable entry points used by the jobs and PostgreSQL scenarios:

| Entry point | Behavior |
| --- | --- |
| `daily(gymId, run?)` | Generate household/date cycle invoices oldest first, then collect eligible cycles and assignment one-offs. Returns generated-period and collection counts, each failed invoice's ID and cause (`provider_outage`, `needs_reconciliation` or `unexpected`), and whether an outage stopped the collection (`stopped`). Logs contain identifiers and safe error classifications, without raw error messages. `run.runId` keys a stopped run's failure report (the job passes its ID). |
| `charge(gymId, invoiceId, options?)` | Collect an eligible issued invoice. Returns an outcome object, or `{ status: 'skipped', reason }`. Provider errors propagate and leave any committed reservation for reconciliation. |
| `collectAssigned(gymId, householdId)` | Immediately collect that household's open, unattempted assignment one-offs after the assignment transaction commits. Returns collection counts and errors; never call it from `onAssigned`. |
| `retry(invoiceId, jobContext)` | Transition-effects callback. Recheck the original first-failure date and the invoice's saved retry windows at 09:00 gym time, then expire/reconcile Checkout before reserving another attempt. |
| `reconcile(gymId)` | Reconcile stale pending attempts by ID. Returns unresolved references. Works while billing is disabled. |
| `postRestore(gymId, snapshotAt)` | Require billing disabled; refresh unresolved IDs and enumerate provider changes with a five-minute overlap. Return `readyForOwnerReview`, unresolved references and `stripeConfigured`; record the report in an immutable audit event. Never enable billing. A gym with no payments provider is checked against the database only (below). |
| `chargeFailures(gymId)` | The last 90 days' stopped-run failure reports, oldest first, each with only the invoices that still need staff. |
| `dismissChargeFailures(context, runIds)` | Staff (a user actor) dismiss what the named reports still list, with an audit per report; a report written after the caller read the list is not named, so it stays open. The gym's dismissals run one at a time (a transaction-level advisory lock), so two at once write one audit per report; the lock is the gym's `chargeFailures` entry in `gymAdvisoryLocks` (`packages/db/src/locks.ts`), and the dismissal reads only the named runs under it. Another gym's, an unknown, or a report older than the 90 days listed is `not_found`, and nothing is dismissed. |
| `onAssigned` | Inject into `createMembershipService`: issue calculated first-period proration and sign-up-fee invoices in the assignment transaction. Never call the provider there. |

Generation locks one household and its due memberships in each short transaction.
It commits invoice lines, numbering, date advances and audits together. Membership
lines store the full-period `billedUnitAmountCents` and named `billedDiscount`
before a final discount cycle is consumed, including first-period and upgrade
invoices. These immutable terms supply later upgrade credits. Cycle generation
passes its existing pricing snapshot to invoice issuance,
preserving those terms without rereading memberships or live applications. Independent
due dates get separate invoices; the cycle uniqueness constraint backs up the lock.
The calculator receives `annualAnchorOn` only for non-null persisted anniversaries;
legacy rows retain the calculator's fallback. Frozen periods advance without charges;
a due scheduled resume waits for the membership lifecycle job. A membership assigned
onto an already-issued period gets a separate one-off for that period with
`needsReview`; its due date advances and later household cycles continue. The
existing cycle, including paid and void invoices, stays unchanged. An audit links
the held invoice to the conflicting cycle and records the period.

Before pricing each membership due in a cycle, generation passes the locked row
to `applyScheduledSwitch` (`../memberships.plan-change.ts`) and prices the row it
returns. An active membership whose scheduled switch is dated on or before its due
date takes the switch's plan, quoted price and interval in the same transaction,
so the cycle bills the new plan's price and taxes and its line records the new
plan. A frozen membership's skipped cycles leave the switch in place; the first
cycle billed after the resume applies it. Missed days catch up cycle by cycle, so
a cycle before the switch date still bills the old plan. The household lock makes
a second or concurrent run that day find the cycle already built, so a switch
applies once.

Cycle and assignment invoices over seven days overdue are held with `needsReview`
on the next daily run, including first-period proration and sign-up fees. Staff
confirmation uses the staff invoice `release-hold` action (owners/admins). The
release audit is the confirmation: released invoices are never held again, and
the next daily run collects them unless staff charge or record a payment first.
The overdue query selects only cycle and assignment invoices and excludes released
invoices using the gym/action/target audit index. Recording cash/check also
confirms a held invoice and audits the payment that cleared it. Merely rerunning
the daily catch-up sweep does not confirm it.
The daily due query filters cycle and assignment invoices in SQL with the same
assignment predicate as the overdue query.
Zero-value invoices settle through `InvoiceTransitions.settleZero`. They require
no saved card, attempt, provider resolution, customer adoption or Checkout calls.
Billing enablement and review holds still apply. Settlement records no payment
and sends no receipt, but queues normal membership activation.

Cycle pricing reads each membership's live discount snapshot. A billed full
cycle consumes one `once` or `cycles` allowance in the same transaction as its
invoice and due-date advance; the last marks the snapshot `completed`. An
off-day monthly stub gets its prorated discount without using a cycle. Frozen
skips and trials consume none. First-period assignment invoices also receive
the snapshot's discount; a prorated one consumes no cycle, while one that bills
a whole period consumes one in the assignment transaction. A signup fee waiver
suppresses the fee invoice. Catalog edits do not alter locked-in terms.

Automatic collection includes cycles and one-offs with at least one line whose
lines are all membership, sign-up fee, discount or tax. Staff one-offs with a
`charge` line, including mixed invoices, never auto-charge. The assignment route
must call `collectAssigned` after commit to collect proration and fees immediately;
the daily sweep recovers uncollected assignment invoices after downtime.

`charge(..., { mode: 'staff', context })` is the authorized staff caller's
"charge saved card" path. The context must contain this gym and a user actor;
the route still owns permission enforcement. It allows another attempt after a
decline, and an explicit charge before the due date, while retaining billing,
review, unpaid-state and pending-attempt guards. Reservation, intent and result
audits use that user. One-off failures remain open and never enter dunning.
The default mode is automatic; the retry callback selects `{ mode: 'retry' }`.

Skip reasons include `billing_disabled`, `not_payable`, `needs_review`,
`pending_attempt`, `no_saved_card`, `already_attempted`, `outside_retry_window`,
`not_auto_collectable`, `not_due`, `checkout_changed`, `reservation_lost`,
`action_required`, `collection_changed`, `below_minimum` and `off_step`. A card charge Stripe would
refuse reserves no attempt and reaches no provider: `below_minimum` when the total is under
Stripe's minimum charge for its currency (`minimumChargeAmount` from `@plaingym/shared/money`:
$0.50, ¥50, ...; currencies without a fixed minimum are left to Stripe), and `off_step` when
the total is finer than the currency's charge step (an amount stored before prices were
checked). Either invoice stays open for a cash or check payment. A read-only eligibility check runs before resolving the
provider or touching Checkout; reservation repeats the same checks under the
invoice lock. A skip is observable and is not a collection error.

`cardChargeIssue` in `@plaingym/shared/money` centralizes these two amount checks
for the runner, Checkout and payment emails. Zero invoices still settle locally.
The dashboard's `billing.skipped-collections` provider lists due cycle and
assignment invoices needing manual payment; this does not create a staff email.

A switch from Stripe test mode to live (Settings → Payments) holds the gym row for
its whole save. The reservation first takes `holdGymSettings` (before the invoice
lock, in the switch's order), so it waits for a switch in progress, and compares the
gym's latest `integrations.stripe_test_cleared` audit with the one read before the
provider was resolved. If a switch committed in between, the provider may hold the
old test key: nothing is reserved, and the charge starts again once with the
provider resolved again (a second change skips with `collection_changed`). Before
releasing an invoice's Checkout session or action-needed PaymentIntent, the charge
reads the latest switch again once the provider is resolved: a switch that committed
since the invoice was read cleared those test objects, and the live key can't release
them, so the charge starts again the same way.

Each charge commits immutable amount, currency, customer and saved-method fields
before adopting the stored customer or creating an unconfirmed PaymentIntent.
Keys are `<invoiceId>:<attemptNumber>:create` and `:confirm`. An exit before
`createCharge`, including failed customer adoption or billing being disabled,
immediately marks the unstarted attempt `failed` with `create_abandoned`.
Once create starts, an unknown result stays pending for reconciliation.
The intent ID is saved
only if the attempt is still pending, unresolved and has no ID. A worker losing
that compare-and-set never confirms it, and cancels only when the attempt does
not already hold the same intent ID. Before confirming a saved ID, the runner
rechecks invoice state, Checkout, review hold, the household customer, saved-card
ownership/revocation and billing enablement. A changed collection (or billing
paused mid-charge) is cancelled and its result reconciled.

Cancelling an intent that was never confirmed (the attempt is still `pending`) is
not a decline: the member's card was never asked. The transitions close that
attempt `failed` with `confirm_abandoned` and leave the invoice status, dunning
and retries untouched. This covers the runner's `collection_changed` and
`billing_disabled` cancels and the hourly reconciliation cancelling a stale
unconfirmed intent (a confirm that never reached Stripe). Like `create_abandoned`,
these attempts never block the daily run (`already_attempted`) or consume a retry
window, so the next daily run, or the next retry day if one remains, collects the invoice.
A past-due invoice is collected only by its retries, so when a retry on the last retry
day gives up on the attempt it reserved (`collection_changed` or `billing_disabled`:
the card was removed or billing paused mid-charge, before or after the intent was
created), the runner queues one more `billing.runner.retry` at 09:00 the next local
day. It doesn't for an invoice that was paid, held for review or given a pay link
meanwhile, nor for a retry that skipped before reserving anything. A retry's
`billing.runner.reserved` audit names its callback's job, so only an attempt that job
reserved counts, never a concurrent staff charge's; a replay of a callback that failed
after abandoning its charge (a settings read or lock error) skips before reserving and
still finds it. The `billing.runner.retry_extended` audit allows one per invoice and
stores the run time: a replay whose enqueue failed after the audit committed queues
the job again with it, and the key (`extend:<invoiceId>:<window>`) keeps a replayed
callback from queueing a second job.
That retry still falls in the unconsumed last window and goes through the normal
eligibility checks, so a paused gym or a still-removed card stops it, and a decline
sends that window's dunning email as usual; the runner sends no dunning for the
abandoned charge. A retry the hourly reconciliation abandons needs nothing extra: its
continuation (below) retries it.
Cancelling an action-needed attempt stays a decline (`intent_canceled`), so an
assignment invoice awaiting authentication isn't charged again every day.

`releaseActionNeeded` and `releaseCheckout` are shared with staff cash/check
collection. Provider calls run outside transactions and all results use
reconciliation and the transitions. Expired Checkout references are cleared under
the invoice lock with an audit, without waiting for a webhook. All terminal
provider results use `applyChargeOutcome` with the provider's `latestChargeId`.
The runner does not set invoice processing, paid or failed states itself.

The default stale threshold is fifteen minutes, above the adapter's 20-second
request timeout. No-ID attempts are invalidated with a compare-and-set and an
audit; no charge could have been confirmed without saving the ID first. These
abandoned creates may be reserved again by the daily runner or within the same retry
window; they do not count as a collected retry. An empty stale-attempt sweep never
resolves the payments provider, so gyms without Stripe can run the hourly job.
No-ID reservations can also be abandoned without a provider; stored intent IDs
still require one, and resolution failures make the job fail loudly. With a saved ID,
reconciliation reads the provider and cancels stale pending work; Stripe's
cancel/confirm serialization decides the outcome. Unknown results remain pending
and block new attempts, including after the provider's idempotency window expires.
A stale intent the sweep cancels unconfirmed is closed as `confirm_abandoned` (above).

Retries read the anchor and saved `retryDays` from `billing.invoice.dunning_started`.
The gym chooses 0 to 4 increasing days from 1 to 28, defaulting to `[3, 7]`.
Only legacy audits without saved days fall back to `[3, 7]`; an empty schedule
never permits an automatic retry. Later settings edits do not change an invoice's windows.
The invoice lock and the creation times of attempts that weren't abandoned (`create_abandoned` or
`confirm_abandoned`) consume each retry window once. If
several retry jobs arrive late, only the latest due window is charged.
Failure never resets the anchor. Other Checkout
creators must honor pending attempts under the same invoice lock. A changed
Checkout ID fails the reservation check. Completed or uncertain expiry forces
reconciliation; if it reveals a paid invoice, the caller gets a `not_payable`
skip. A still-unresolved session throws. Before a retry or explicit staff attempt
replaces an action-needed PaymentIntent, the runner cancels the old intent and
applies its result. If confirmation already won, that success settles the invoice
and no new intent is created. Unknown cancellation outcomes block the new attempt.

A retry with a pending attempt commits a `billing.runner.retry` continuation before
returning, using the injected shared job queue. Provider errors also queue this
continuation when they leave a pending reservation, or one that reconciliation has
meanwhile abandoned, then propagate. So does a retry whose reservation reconciliation
abandoned before its intent ID was saved (`reservation_lost`), and a retry that gave
up on its charge (`collection_changed` or `billing_disabled`) when the cancel answered
`unknown`, leaving the attempt pending. That continuation carries the retry's job ID
(`{ invoiceId, owner }`) and acts for it, so once reconciliation settles the attempt as
`confirm_abandoned`, a continuation that finds billing still paused or the card still
removed can queue the extra retry day. A skip beside someone else's pending attempt
queues nothing. Default queue
retries (three attempts), and the transition effect's twelve attempts with one-second
exponential backoff, can finish before the stale threshold plus the hourly sweep.
The continuation runs after the stale threshold plus 61 minutes (76 minutes by
default), leaving time for the hourly reconciliation. Its key includes the invoice
and source job ID, so replaying that source job cannot duplicate the continuation.
If reconciliation is delayed, the continuation can defer again. Eligibility is
checked afresh each time; pending or unknown outcomes never permit a new charge,
and completed retry windows never charge again. A queue failure propagates instead
of acknowledging the callback without its continuation.

Restore refreshes stored unresolved intents, payment Checkout sessions on open or
past-due invoices, pending refunds, and open disputes on any invoice by ID, except
a dispute in Stripe's test mode, which the live key can't read: one whose own payment
is marked `Stripe test mode` (the dispute writer records the disputed payment as
`paymentId` in its `billing.invoice.disputed` audit), or, for one recorded without
it, one on an invoice paid only by marked payments. It reads
only reference columns and does not sweep historical paid-invoice Checkouts.
`Payments.listChangesSince` still discovers sessions changed since the snapshot,
including sessions on paid invoices. It supplies all pages of events and
creation-time intent/refund/dispute lists, including beyond event retention; its
adapter re-fetches objects at the pinned API version. The runner re-reads listed
references before applying them. Refunds and disputes match through PaymentIntent
or Charge identity, so dashboard objects need no invoice metadata. A snapshot
taken before an intent-ID commit can recover that ID on an unresolved reservation
before applying its success. Stored intent IDs also match when optional invoice
metadata is missing; conflicting metadata is rejected. Missing reservations, unmatched objects, unknown
results and pending refunds stay in the review report. Enumeration errors fail
the pass. There is no search-based outcome inference or automatic billing resume.
Refunds and disputes are recorded by the writer shared with webhook processing
(`../disputes-refunds.ts`): another dispute already attached to the invoice is a
manual-resolution issue, won/lost/closed states are terminal, each change records
`billing.invoice.disputed` with before and after values and publishes the owner's
alert, and refunds get the same local IDs as from webhooks. A refund or dispute
whose payment is already recorded costs no processor read. The optional
`disputeAlerts` option (the billing alerts service) receives those alerts; without it,
the hourly dispute scan still finds them.

A successful confirmation carries the processor's `succeededAt` (the adapter
expands the latest Charge), so recording it reads nothing more: a saved-card
charge makes five provider requests (customer adoption, the payment-method read
that also checks the payer, create, and the confirmation's read and request), and
six when adoption first tags an untagged customer.
Any other success, including after restore or a cancel/confirm race, calls
`findCharge(reference, { includeSuccessTime: true })` and records its
`succeededAt`. Missing or invalid success times remain retryable; the clock never
supplies a replacement payment date.

The daily collection stops after three consecutive provider outage errors
(`isProviderOutage`: unreachable or timed out, rate limited, a server error, or a
rejected key; not a permission the key lacks, which fails only some charges).
Without the stop, each remaining charge would wait out the adapter's
20-second timeout and fail the same way, and the failed job would then rerun the
whole collection after one and two seconds. A charge outcome resets the count, a
skip or a $0 settlement (which never reaches the provider) leaves it as it is, and
any other error resets it, so a few households whose charges fail on their own
never stop the run. A stopped run enqueues one continuation,
`billing.runner.daily` an hour later with the payload
`{ continues: <gym-local date> }` and that date in its key (`continue:<date>`), so a
replayed run reuses it, and returns `stopped` instead of failing its job. The
continuation runs the daily pass again and collects what is left, including the
stopped run's `create_abandoned` attempts; an attempt whose create had started
stays pending until the hourly reconciliation resolves it. A continuation that
stops again queues nothing (its log says `continuesAt: null`), so each daily run
gets at most one; the next daily run collects the rest. A continuation delayed
past local midnight collects only its own day, as that day's run would have, and
leaves the next day to its own 09:00 run. The charge-run health tile records a
stopped run as failed until a run completes.

A stopped run's job succeeds, so no job retry reruns the collection into the outage,
and its failures the outage didn't cause (a refused customer, a charge outcome that needs
reconciliation) go in the run's failure report (`failures.ts`): one
`billing.runner.charge_failures.reported` audit per run, targeting the run's job ID,
with `{ day, failures: [{ invoiceId, number, cause }] }`. A replayed run keeps its
first report, and a second stopped run on the same day (a rerun) has its own. An
invoice leaves its report once it is no longer open or past due, or once a later
charge of it gets the provider's answer (paid, declined or awaiting authentication);
`dismissChargeFailures` dismisses what is left (`billing.runner.charge_failures.dismissed`), and a report
older than 90 days drops off, as the failed jobs that listed these before did. While a
report lists an invoice, the charge-run health tile is an error naming the invoices
(`areas/health/charge-run.README.md`). Nothing fails on purpose, so the gym's
`failed_jobs` check stays clear; the continuation still collects what is left.
Dismiss all refreshes the list before each confirmation or retry and only sends
captured runs that are still listed, so a report aging out cannot block the rest.

The daily run is a batch job: its registration in `runner.jobs.ts` names the batch
lane (`infra/jobs/README.md`), so the run holds only that lane: webhook dispatch
(join completion included), transition effects and notices run while it collects; a
queue that registers it without the lane makes them wait for the run.

`core/runtime.ts` composes billing before starting the job worker:

1. It keeps the result of `composeBillingWebhooks` and shares its transition
   service and effect worker. It builds the runner from `billing.transitions`, then calls
   `billing.attachRetry(runner.retry)`; the composition has no `retry` option.
2. The runner receives that service, `jobs: queue`, and gym-scoped payments/settings
   resolvers; the payments resolver throws when Stripe is not configured.
   The membership service calls `runner.onAssigned` inside assignment, and the assign
   route calls `runner.collectAssigned(gymId, householdId)` after commit. Collection
   errors are logged; assignment still succeeds and the daily sweep recovers collection.
3. It calls `configureChargeRunner(runner)` before starting workers; the webhook
   composition already configures transition effects. The billing barrel includes:
   `billing.runner.daily` (09:00 local, and a stopped collection's continuation), `billing.runner.reconcile` (hourly at :17),
   `billing.runner.retry` (`{ invoiceId }`), `billing.runner.charge_failures` (a stopped
   run's other failures, queued by the previous release; it records them as that run's report), and `billing.runner.restore`
   (`{ snapshotAt, restoreId }`; legacy jobs may omit `restoreId`). Restore queues
   one durable job per gym/restore before completing its journal. The normal retry path is the transition effect job callback;
   do not independently schedule another set of retries.
   The daily and reconciliation jobs throw `Charge runner is not configured`
   for an enabled gym if composition was omitted; disabled gyms may remain inert.
4. Staff release overdue holds on the invoice page, confirming collection on the
   next daily run unless they charge or record a payment first. Released invoices
   are never held again. Restore reconciliation returns an operations report;
   owner confirmation to resume billing is a separate operation. Each started
   restore check targets its restore audit; its result targets that check's audit.
   Only the newest check for the newest restore can clear the go-live gate.
   Provider failures persist an unresolved report and fail the job. A gym with no
   payments provider (the resolver throws `AppError` `unavailable`, which the
   runtime's resolver does only when no Stripe settings are stored; any other
   resolver error is a provider failure) reads only the database: with no stored
   Stripe references the report is clear (`inspected: 0, unresolved: 0`); each
   stored reference is an issue with reason `stripe_not_configured`, resolved by
   connecting Stripe and checking again. Such a report never fails the
   `billing.runner.restore` job, since a retry would find the same references, and
   records `stripeConfigured: false`, which go-live stops counting once Stripe is
   connected. Saving Stripe after such a check pauses billing with an audit in
   the same transaction. The hourly reconcile also lists unread stored intents
   as `stripe_not_configured` without failing the job; a real provider error or
   another unresolved issue still fails it. The public `reconcile(gymId)` method
   always resolves the gym's provider itself. Managers can rerun via go-live
   while billing is paused, using `rerunRestoreReconciliation`, which resolves the
   same configured runner as the worker. Rerunning never enables billing.

The PostgreSQL suite is split by concern over `runner.fixture.test-helper.ts`:
`runner.collection.test.ts` (reservation visibility, replay, concurrent runs,
recorded synthetic Stripe adapter fixtures, customer adoption, catch-up, local
dates, leap-day anniversaries, cross-gym isolation), `runner.assignment.test.ts`
(assignment invoices and review holds), `runner.review.test.ts` (eligibility
changes mid-charge, Checkout identity, staff charges, job configuration),
`runner.reconciliation.test.ts` (lost responses, both cancel/confirm race winners,
delayed creation, restore refunds/disputes, a restore check without Stripe), `runner.retry.test.ts` (retry windows,
Checkout exclusion and transition job composition) and `runner.breaker.test.ts` (the
outage stop and its continuation, a stopped run's failure reports, and a webhook dispatch
running while the daily run holds the batch lane). `concurrency.test.ts` holds the daily
run inside a confirm on the worker's batch lane and meanwhile runs reconcile (before and
after Stripe charged the card), retries of the held invoice and of another of the
household's invoices, and a success webhook with the effects it queues; each asserts the
run's lease is still live, one payment per invoice and no second charge.
`last-retry.test.ts` covers a retry that gives up on its own charge on the last retry day
(card removed, billing paused before or after create), an invoice given a pay link or
review hold meanwhile, a retry that skips before reserving, and an earlier retry day.
The service composition test uses `composeBillingWebhooks` and `attachRetry` with
the real membership, transition, and runner services. `core/runtime.test.ts` covers
assignment through the API and the configured retry callback. To re-record the local synthetic adapter
tapes, set `RECORD_RUNNER_FIXTURES=1` when running `runner.collection.test.ts`. Ordinary runs
strictly replay the tapes with no network fallback.
