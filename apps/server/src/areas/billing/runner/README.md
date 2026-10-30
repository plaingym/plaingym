<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Charge runner

`createChargeRunner({ scope?, clock?, settings, transitions, payments, jobs, staleAfterMs? })`
exposes the same controllable entry points used by the jobs and PostgreSQL scenarios:

| Entry point | Behavior |
| --- | --- |
| `daily(gymId)` | Generate household/date cycle invoices oldest first, then collect eligible cycles and assignment one-offs. Returns generated-period and collection counts, each failed invoice's ID, and whether an outage stopped the collection (`stopped`). Logs contain identifiers and safe error classifications, without raw error messages. |
| `charge(gymId, invoiceId, options?)` | Collect an eligible issued invoice. Returns an outcome object, or `{ status: 'skipped', reason }`. Provider errors propagate and leave any committed reservation for reconciliation. |
| `collectAssigned(gymId, householdId)` | Immediately collect that household's open, unattempted assignment one-offs after the assignment transaction commits. Returns collection counts and errors; never call it from `onAssigned`. |
| `retry(invoiceId, jobContext)` | Transition-effects callback. Recheck the original first-failure date and the invoice's saved retry windows at 09:00 gym time, then expire/reconcile Checkout before reserving another attempt. |
| `reconcile(gymId)` | Reconcile stale pending attempts by ID. Returns unresolved references. Works while billing is disabled. |
| `postRestore(gymId, snapshotAt)` | Require billing disabled; refresh unresolved IDs and enumerate provider changes with a five-minute overlap. Return `readyForOwnerReview` and unresolved references; record the report in an immutable audit event. Never enable billing. |
| `onAssigned` | Inject into `createMembershipService`: issue calculated first-period proration and sign-up-fee invoices in the assignment transaction. Never call the provider there. |

Generation locks one household and its due memberships in each short transaction.
It commits invoice lines, numbering, date advances and audits together. Independent
due dates get separate invoices; the cycle uniqueness constraint backs up the lock.
The calculator receives `annualAnchorOn` only for non-null persisted anniversaries;
legacy rows retain the calculator's fallback. Frozen periods advance without charges;
a due scheduled resume waits for the membership lifecycle job. A membership assigned
onto an already-issued period gets a separate one-off for that period with
`needsReview`; its due date advances and later household cycles continue. The
existing cycle, including paid and void invoices, stays unchanged. An audit links
the held invoice to the conflicting cycle and records the period.

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
`not_auto_collectable`, `not_due`, `checkout_changed`, `reservation_lost`, and
`action_required`, and `collection_changed`. A read-only eligibility check runs before resolving the
provider or touching Checkout; reservation repeats the same checks under the
invoice lock. A skip is observable and is not a collection error.

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
meanwhile abandoned, then propagate. Default queue
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
past-due invoices, pending refunds, and open disputes on any invoice by ID. It reads
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
skip leaves it as it is, and any other error resets it, so a few households whose
charges fail on their own never stop the run. A stopped run enqueues one
continuation, `billing.runner.daily` an hour later with the payload
`{ continues: <gym-local date> }` and that date in its key (`continue:<date>`), so a
replayed run reuses it, and returns `stopped` instead of failing its job. The
continuation runs the daily pass again and collects what is left, including the
stopped run's `create_abandoned` attempts; an attempt whose create had started
stays pending until the hourly reconciliation resolves it. A continuation that
stops again queues nothing (its log says `continuesAt: null`), even when delayed
past midnight, so each daily run gets at most one; the next daily run collects
the rest. The charge-run health tile records a stopped run as failed until a run
completes.

The daily run is a batch job (`runnerBatchJobs`). When the worker's queue lists
it in its batch lane (`infra/jobs/README.md`), the run holds only that lane, so
webhook dispatch (join completion included), transition effects and notices run
while it collects; without the lane they wait for the run.

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
   `billing.runner.retry` (`{ invoiceId }`), and `billing.runner.restore`
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
   Provider failures persist an unresolved report. Managers can rerun via go-live
   while billing is paused, using `rerunRestoreReconciliation`, which resolves the
   same configured runner as the worker. Rerunning never enables billing.

The PostgreSQL suite covers reservation visibility, replay, concurrent runs,
recorded synthetic Stripe adapter fixtures, customer adoption, catch-up, local
dates, leap-day anniversaries, assignment invoices, cross-gym isolation, lost
responses, both cancel/confirm race winners, delayed creation, retry windows and
Checkout exclusion, transition job composition, restore refunds/disputes, the
outage stop and its continuation, and a webhook dispatch running while the daily
run holds the batch lane.
The service composition test uses `composeBillingWebhooks` and `attachRetry` with
the real membership, transition, and runner services. `core/runtime.test.ts` covers
assignment through the API and the configured retry callback. To re-record the local synthetic adapter
tapes, set `RECORD_RUNNER_FIXTURES=1` when running `runner.test.ts`. Ordinary runs
strictly replay the tapes with no network fallback.
