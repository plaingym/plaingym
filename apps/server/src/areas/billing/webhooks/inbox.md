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
own host, after tenant resolution. No billing handlers are registered yet, so
stored events are marked processed without side effects. The install-level demo
route below is not mounted: sandboxes have no Stripe settings, so their deliveries
answer 503.

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
Pass the queue's recovery capability as `recovery` to `createWebhookInbox` as well
as `jobs`. A redelivery resets an exhausted original dispatch job with `retryFailed`
and audits `billing.webhook.dispatch_retried`, keeping its ID, payload and key.
Concurrent redeliveries reset it only once; pending and running jobs are unchanged.
The inbox has no timer of its own: only a later delivery of the same event resets
the job. Stripe retries a delivery automatically only while the endpoint doesn't
answer 2xx, and this endpoint answers 200 once the dispatch job is enqueued, so a
dispatch that fails later is reset by a manual redelivery from the provider, a
duplicate delivery, or a retry after a response that never reached the provider.
Otherwise it stays failed until staff replay it. Queue or recovery errors fail the
request so the provider retries.

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

A failed handler records only `handler_failed`, preserves any existing
`processed_at` (a failed replay cannot erase a prior successful dispatch), and
rethrows to the queue. Dispatch jobs allow ten attempts with the queue's backoff.
`createWebhookHealthQuery` exposes only per-gym timestamps and pending/failed
counts; it never returns payloads or provider errors.

In demo mode pass `demoGyms` to the route factory and supply a resolver constructing
gym-scoped providers from the shared Stripe **test** account and endpoint secret.
Mount this one route on the install host before tenant/session middleware, after
body limits and the restore gate. It requires no tenant context. Raw `gym_id`
metadata only chooses a candidate from the supplied active sandbox list; the
provider must verify the unchanged bytes and confirm ownership before insertion.
Untagged events try the sandbox providers in turn, letting the provider resolve
refunds and disputes through their parent objects. Unexpected lookup errors remain
retryable. With no available sandbox provider, the endpoint returns 503.

Replay a stored event with `pnpm cli replay --gym <gym-id> <event-id>`. Runtime
composition supplies `configureWebhookReplay(inbox)` in the CLI process too. Replay
uses a new queue key and bypasses the processed guard, allowing failed, exhausted,
or completed events to run again. The gym must own the event; there is no raw-body
or signature input, and replay never runs a handler in the CLI process.

The ordinary hourly `billing.runner.reconcile` sweep inspects stale `pending`
payment attempts, resolving charge outcomes by PaymentIntent ID or abandoning
creates that never saved an ID. It does not scan action-needed attempts, Checkout
sessions, refunds, disputes, SetupIntents or payment-method updates. The separate
lapsed-refund sweep covers tagged, pending reservations past the retry window that
still have no processor ID (see [transitions](../transitions/README.md)). Broader
charge, Checkout, refund and dispute reconciliation runs after a restore; card
collection and saved-card changes remain webhook-owned. Recovering dispatch is
therefore needed even with hourly charge reconciliation enabled.
