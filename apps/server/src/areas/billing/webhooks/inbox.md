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
object kind and object ID), never a customer snapshot or signature. Its event ID is
globally unique. Receipt commits before enqueue; 200 follows durable enqueue. A
redelivery repairs an interrupted enqueue with the same persistent job key, without
replacing the saved event or re-running a completed one.

`inbox.register(type, handler)` registers one handler per event type. The dispatcher
loads the saved event in the job's gym scope and passes the verified reference,
job context, and resolved `Payments` to the handler. Handlers must re-read current
objects through `readPaymentObject` and apply idempotent transitions: job delivery
is at least once, including a process dying after side effects but before recording
completion. No network I/O runs inside an inbox transaction. Unregistered types
are marked processed without side effects. Register the required billing handlers
before starting the worker.

A failed handler records only `handler_failed`, leaves the event unprocessed, and
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
