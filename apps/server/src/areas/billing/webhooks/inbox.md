<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Stripe webhook inbox

`createWebhookInbox` takes the `Payments` resolver, job queue, gym settings accessor,
clock, and scoped database helpers. A resolver returning `null` produces a 503 with
"Payments are not set up for this gym". Configure the routes and dispatcher with
`configureWebhookInboxRoutes` and `configureWebhookInboxJobs` before mounting the
area registries. The `createWebhookInboxRoutes` / `createWebhookInboxJobs` factories
are available for isolated composition.

The runtime (`core/runtime.ts`) builds one inbox from `createPaymentsResolver`, the
Postgres queue and the gym settings accessor, configures the route and dispatcher
job, and configures replay for the command line. The route is served on each gym's
own host, after tenant resolution. Before the worker starts,
`composeBillingWebhooks` registers the [billing handlers](handlers/README.md).
Stored events with unregistered types are marked processed without side effects.
Demo installs with shared Stripe test credentials use the install-level route
described below.

The public POST `/webhooks/stripe` reads the body once as bytes and delegates all
signature and ownership verification to `payments.parseWebhook`. Only
`PaymentWebhookError('webhook_invalid')` becomes 400. An event not belonging to the
gym is acknowledged with 200 and dropped. Every other error fails the request,
including provider lookups, database writes, and queue insertion, so Stripe retries.

The inbox stores the normalized verified `PaymentEvent` (event ID, type, gym ID,
object kind and object ID), never a customer snapshot or signature, with `livemode`:
the mode of the key that verified it (`Payments.keyMode`; the Stripe adapter refuses
an event whose own mode differs), absent where the provider doesn't know its mode
and on events stored before it was recorded. Its event ID is
globally unique. Receipt commits before enqueue; 200 follows durable enqueue. A
redelivery repairs an interrupted enqueue with the same persistent job key, without
replacing the saved event or re-running a completed one.
The runtime passes the queue's recovery capability as `recovery` to
`createWebhookInbox` as well as `jobs`. A redelivery locks the stored event's row and,
while it is still unprocessed, resets an exhausted original dispatch job with `retryFailed`, and audits
`billing.webhook.dispatch_retried` in the same transaction, keeping its ID, payload and key.
Concurrent redeliveries reset it only once; pending and running jobs are unchanged.
Queue or recovery errors fail the request so the provider retries.

The hourly `billing.webhooks.recover` job (minute 17) also resets failed original
dispatch jobs without another delivery. It pages the gym's unprocessed events in
groups of 100 using partial indexes for rows with and without an error marker.
The queue looks up failed original jobs by the stored event row ID. If a failed
dispatch left no marker, the sweep records `dispatch_failed`, with the failed
job's time as `failed_at`, so Health counts it as failed even during the cooldown.
When a reset dispatch fails again, the next sweep moves `failed_at` to the
job's latest failure on `dispatch_failed` rows. On `handler_failed` rows it
moves it only when `failed_at` is missing, or older than both the job's failure
and the latest reset's time since the last exhaustion (the reset dispatch
failed before its handler recorded a time); either way the marker stays. The
latest reset is the last reset audit by `occurred_at`: reset audits are stamped
under the event's row lock at least 1 ms after its latest dispatch audit, so
that order is the order they committed in. Reset audits written before that
rule can share a stamp; the audit ID breaks the tie, but it comes from each
process's own clock, so among those older rows an earlier reset from a clock
ahead can still count as the latest. A reset's time is the resetting process's
own clock read, the run time it set, which its audit records as `after.at`; a reset
audited without it counts by its `occurred_at`. A reset's `occurred_at` can be
raised past that clock to follow an earlier dispatch audit, so comparing against
it could move a later failure's time, and an earlier reset from a clock ahead
doesn't count against a later one. A fresh handler failure keeps the time
`dispatch` wrote. When the latest reset came from a process whose clock lags
the one that recorded the handler failure, its time can predate that failure,
so a reset dispatch that then fails before its handler leaves the older
`failed_at` in place.
It waits 15 minutes after an exhausted batch, then 30, 60, 120 and 240 minutes
after subsequent batches. The same `billing.webhook.dispatch_retried` audits
count resets across restarts, including those triggered by redelivery. The
next terminal failure after five audited resets records one
`billing.webhook.dispatch_recovery_exhausted` audit. Later sweeps exclude the
event before the queue lookup until a redelivery resets it (below), and it remains visible in Health for staff replay or redelivery. The sweep decides the cooldown from an unlocked read
and takes the event's row lock only when it may reset, mark or exhaust it; under that lock
(shared with redeliveries) it rechecks everything and commits each reset or exhaustion with its audit. It safely logs a failed pre-check
read and continues with the next page, and logs a per-event error
and continues with the page. Each sweep still reads every unprocessed event of the
gym once, including exhausted events and events whose dispatch job is gone: failed
dispatches are rare, and staff replay or a redelivery still recovers them.
The sweep uses the inbox supplied by `configureWebhookInboxJobs`.

A redelivery after exhaustion reopens automatic recovery. The sweep counts
only resets at or after the latest exhaustion audit, and the redelivery's own
reset is the first of them, so the sweep resets the event up to four more times,
after 30, 60, 120 and 240 minutes, before the next terminal failure records a new
exhaustion audit. Every dispatch audit (a reset from a redelivery or the sweep, or
an exhaustion) is written under the event's `stripe_events` row lock and stamped
strictly after the event's latest dispatch audit (by its own clock, or at least 1 ms
after that audit), so their timestamp order is the order they committed even when
app processes' clocks disagree. Stripe's automatic redelivery covers failures
reported by the endpoint in a non-2xx response.

`inbox.register(type, handler)` registers one handler per event type. The dispatcher
loads the saved event in the job's gym scope and passes the verified reference,
job context, and resolved `Payments` to the handler. Handlers must re-read current
objects through `readPaymentObject` and apply idempotent transitions: job delivery
is at least once, including a process dying after side effects but before recording
completion. No network I/O runs inside an inbox transaction. Unregistered types
are marked processed without side effects. Register the required billing handlers
before starting the worker.

A Stripe test-mode event dispatched once the gym's key is live (stored before a
switch from test to live, or while one was saving) is finished without its handler
or any Stripe call, since the live key can't read a test object: it is marked
processed with a `billing.webhook.test_event_skipped` audit (target: the stored
event). An event stored without `livemode` counts as test mode when it arrived
before the gym's latest `integrations.stripe_test_cleared` audit.

Dispatch reads the switch snapshot (`stripeSwitchSnapshot`: the latest test-data
clear, the latest Payments save that changed the Stripe mode, or the latest setup
Stripe step save that changed or removed a stored mode) before resolving
its provider. For a test provider, `stripe-writes.ts` carries that snapshot through
the handler's separate transactions. Each takes the gym settings lock before invoice
or household locks and checks the snapshot again. A switch committed meanwhile rolls back the stale transaction
and finishes the event with the same skipped-event audit. Live events keep their
normal write path.

A failed handler records only `handler_failed` and the failure time as
`failed_at`, preserves any existing `processed_at` (a failed replay cannot erase
a prior successful dispatch), and rethrows to the queue. When reading the stored
event throws, dispatch still logs the failure as `billing.webhooks.handler_failed`
(without `type`) and rethrows; a replay also records `handler_failed` and
`failed_at` on a best-effort basis, logging `billing.webhooks.marker_write_failed`
and keeping the original error if the marker write fails (originals are covered by
the recovery sweep). A successful dispatch
clears both `error` and `failed_at`. Health and the go-live webhook check count
only failures still unprocessed, so a failed replay of a processed event shows
only as a failed job. Health counts a failure as recent when its
`failed_at` is within the last 7 days; a row that failed before failure times were
recorded counts by its received time instead. If a handler failure's marker write
fails, dispatch logs `billing.webhooks.marker_write_failed`, keeps the handler's
error as the job's error, and still logs the original
failure as `billing.webhooks.handler_failed` with fields `handlerFailureFields` builds itself, none taken from message text:
`gymId`, `eventId` and `type`; `errorName` (the error's name when it is an
identifier, otherwise its JavaScript type) and `errorCode` (a short code of
letters, digits and underscores); `errorFrames`, the first 15 stack frames, read
by the shared logger's `stackFrames` only after the stack's exact
`name: message` header, so a multiline message never passes for a frame
(omitted when there are none); and `causeName` and `causeCode` for the error's direct
cause, without frames. The exception itself isn't passed to the shared logger,
so no query text or schema identifier is logged. A `reason` carries the message
only when both rules hold: the error is a plain `Error` whose message is one of
the billing handlers' own fixed texts, listed in `handlerFailureReasons` (a test
keeps that list in step with the handlers), and the message is letters and
spaces only, at most 100 characters. Any other message, a provider's, one
holding an ID or a name, or a fixed text with punctuation, is never logged.
Dispatch jobs allow ten attempts with the queue's backoff.
`createWebhookHealthQuery` exposes only per-gym webhook timestamps, the time of
the first Stripe charge attempt since the gym's latest Stripe save or webhook
endpoint registration (its first ever when there is neither), and unprocessed
pending/failed counts; it never returns payloads, audit contents or provider
errors.

In demo mode pass `demoGyms` to the route factory and supply a resolver constructing
gym-scoped providers from the shared Stripe **test** account and endpoint secret.
Mount this one route on the install host before tenant/session middleware, after
body limits and the restore gate. It requires no tenant context. Raw `gym_id`
metadata only chooses a candidate from the supplied active sandbox list; the
provider must verify the unchanged bytes and confirm ownership before insertion.
Untagged events try the sandbox providers in turn, letting the provider resolve
refunds and disputes through their parent objects. Unexpected lookup errors remain
retryable. The install-level middleware acknowledges deliveries when no sandboxes
are active. With active sandboxes and no available provider, the endpoint returns
503.

Replay a stored event with `pnpm cli replay --gym <gym-id> <event-id>`. Runtime
composition supplies `configureWebhookReplay(inbox)` in the CLI process too. Replay
uses a new queue key and bypasses the processed guard, allowing failed, exhausted,
or completed events to run again. The gym must own the event; there is no raw-body
or signature input, and replay never runs a handler in the CLI process.

The ordinary hourly `billing.runner.reconcile` sweep inspects stale `pending`
payment attempts and bank debits in `processing` for more than ten days,
including those started in Checkout. It also reads, after ten days, a Checkout
debit that started processing on an already paid or void invoice
(`billing.invoice.late_processing`), and records a settled one as a duplicate
payment with its refund reserved. A resolving audit removes a late debit Stripe
reports as failed from later sweeps. The sweep resolves charge outcomes by
PaymentIntent ID and abandons stale creates that never saved an ID. It does not scan
action-needed attempts, Checkout sessions, refunds, disputes, SetupIntents or
payment-method updates. The separate
lapsed-refund sweep covers tagged, pending reservations past the retry window that
still have no processor ID (see [transitions](../transitions/README.md)). Broader
charge, Checkout, refund and dispute reconciliation runs after a restore; card
collection and saved-card changes remain webhook-owned. Recovering dispatch is
therefore needed even with hourly charge reconciliation enabled.
