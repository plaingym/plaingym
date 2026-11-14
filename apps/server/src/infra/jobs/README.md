<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# PostgreSQL jobs

`PostgresJobs` implements `Jobs`; `PostgresJobStatsQuery` implements the health
query. The frozen interfaces and in-memory fake remain exported from `index.ts`.

Gym-scoped `enqueue(name, payload, options, transaction?)` can insert on the
caller's transaction. Use `withJobTransaction(forGym, gymId, async transaction =>
{ ... })`, access application rows through `transaction.tx`, and pass that same
transaction as enqueue's fourth argument. Both the insert and idempotency lookup
use that handle, without opening another scope. The handle must be active and
belong to the job's gym; PostgreSQL also checks the database gym context. Ordinary
enqueue inside a transaction remains rejected, and install-level enqueue has no
transaction argument. The helper notifies the in-memory fake after the caller's
scope commits, so fake jobs and their keys are discarded on rollback and cannot
run before commit. Existing callers outside transactions are unchanged.

Register handlers, then call `startJobsWorker(queue, options)`. Await
`worker.stop()` before closing the database: it stops new claims and waits for
handlers and lease heartbeats. `runNext()` drains one due job without starting a
polling loop. The default process concurrency is four, the shared per-gym cap is
one, and leases last 30 seconds with a heartbeat every third of the lease.
Workers must use the same caps and register the same batch jobs. All workers coordinate their short cap-check and
claim transactions with an advisory lock and `FOR UPDATE SKIP LOCKED`. Each claim
counts live leases per gym and lane once (a CTE), leaves out each gym's lanes at
their cap, then takes the earliest due job, so a gym's backlog never runs a cap
check per row. Long batch work runs in its own lane (Batch lane, below).

Handlers execute outside transactions. They receive the persisted timezone,
gym, attempt number, job ID, and injected clock, and open their own short database
scopes. Jobs are at-least-once: after a crash or lost lease the handler can run
again, so external effects must use idempotency keys. The lock token fences every
heartbeat and acknowledgement so an old handler cannot overwrite its replacement.
Retries start at one second, double per failure, and are capped at one day.
Unregistered job names stay pending for a worker that has their handlers. A
finished job's run time records when it succeeded or finally failed.

`JobRecovery` (implemented by `PostgresJobs` and `FakeJobs`) lets a producer
recover its own exhausted jobs without reading queue rows: `failedJobs(name,
keys, { gymId })` returns the gym's failed jobs of that name among the caller's
idempotency keys, with their failure time, and `retryFailed(jobId, { gymId,
runAt })` atomically resets one such job to pending with fresh attempts, keeping
its ID and key. Both see only rows marked failed, never a running job. A final
attempt whose lease expired counts once the next claim marks it failed; as with
any expired lease, its handler may still be running, so a retried job's handler
needs the same idempotency as any other. `retryFailed` returns false for any
other job.

Install-level work uses `enqueueSystem` and `handleSystem`, with `gymId: null` in
the handler context. These separate methods keep the gym-required `Jobs` contract
intact. Install jobs share their own concurrency bucket and never appear in gym
statistics. Database statuses are `pending`, `running`, `succeeded`, and `failed`.
`pendingSystemPayloads(name)` reads only pending/running install payloads for an
exact job name. Internal orchestration uses it to retain polling progress while
a failed demo seed's tenant reservation is being replaced; gym jobs are excluded.
The optional `eligibleGym` policy is checked immediately before a gym handler.
A false result acknowledges the queued job without calling its handler; demo
composition uses it to exclude the shared showcase and pooled gyms, including
jobs queued before they became shared. Ordinary installs leave it unset.
Payloads use a versioned internal envelope to persist timezone and scheduler
metadata; handlers receive only the caller's original JSON value. Caller
idempotency keys are hashed together with the job name to fit the schema's
`(gym_id, idempotency_key)` unique constraint.

Schedules require an injected `listGyms()` provider from tenancy; it returns
`{ gymId, timezone }` records outside transactions. The jobs module has no access
to gym configuration tables. Five-field cron expressions use `cron-parser` and
IANA timezones. Spring-forward daily times shift into the valid hour; a repeated
fall-back wall-clock minute has one occurrence key. The worker schedules once per
clock minute (cron's resolution), not on every poll; a failed tick waits for the
next minute.

Each gym and schedule has a cursor in `job_schedule_cursors` (a system table
with gym access): its expression, timezone and latest enqueued occurrence. A tick
reads the listed gyms' cursors in one query per 500 gyms. Enqueueing an occurrence advances
its cursor in the same transaction, and the occurrence's idempotency key collapses
competing schedulers. On first registration the current minute is eligible;
subsequent ticks and restarts catch up from the cursor, with at most 100
occurrences per gym and schedule per tick. Schedule name, expression, and timezone
identify a schedule generation: a different expression or timezone replaces the
cursor and starts a new generation at the current minute, even when returning to
an earlier expression or timezone. Only a schedule with no cursor is seeded from
the newest occurrence row of that generation, as earlier releases kept it, so an
upgrade neither skips nor repeats occurrences; when two or more of a gym's cursors
are missing, they are seeded in one transaction before any of its occurrences is
enqueued. If that seed fails, it is logged once and the missing schedules are
retried individually to isolate the failure; a single missing schedule is seeded
only individually. Invalid timezones are rejected before seeding. Schedule handler effects need the same
idempotency guarantees as other jobs. A scheduling failure is logged as
`jobs.schedule_error` with its gym ID and, for a schedule-specific failure, its
schedule name (`stage: 'seed_all'` for the shared seed); other schedules and gyms
continue. Failures that mean the database itself is unusable end the tick instead
of logging once per gym: a lost or refused connection, a server shutting down or
out of connection slots, a refused login (for example a rotated password), or a
read-only server (`isConnectionError` in `@plaingym/db`).

## Batch lane

A job registered with `{ lane: 'batch' }` (`handle` and `schedule` take it as their
last argument; `JobRegistration.lane` carries it through `registerJobs`) runs in a
per-gym batch lane with its own cap (default one), and every other job runs in the
default lane under `perGymConcurrency`. Long batch work (the daily charge run, imports, exports,
campaign scans and sends) then holds only its own lane: the gym's webhook
dispatch, transition effects and notices are claimed alongside it instead of
waiting behind it, and a gym runs one batch job at a time. Splitting a batch into
many small jobs would not help on its own, because claims take the earliest due
job first. The lane is decided by job name when a job is claimed, so producers
enqueue as before and every worker must register the same jobs. Across gyms, a
worker runs at most `batchConcurrency` batch jobs at once (at most its concurrency;
default one less, at least one), so with two or more slots other gyms' batch work
can't take every one. A single-slot worker shares its slot.
`runNext()` claims from either lane. A job registered without a lane runs in the
default lane. `batch: { perGymConcurrency? }` tunes the batch cap;
the runtime uses the default, and each batch job names
its own lane in its registration (the daily charge run, imports, exports and
campaign jobs). Queues that only enqueue (the CLI's, restore's) need no lane.

## Retention

With `retention: { keep }`, the queue registers the install job `jobs.retention`
and `scheduleDue()` enqueues it once per UTC day at 03:30 (or at once in a process
that starts later that day). It deletes, in batches of 1,000 short transactions,
succeeded jobs that finished more than 14 days ago and failed jobs that failed
more than 90 days ago, for every gym and the install. It never deletes pending or running
jobs, jobs named in `keep` (their idempotency keys must stay unique for good), or
a schedule's cron occurrence rows before that gym has a cursor for it, since those
rows are then still its watermark. Job statistics count only retained rows.
Producers must not rely on a pruned job's key: a later enqueue with that key
creates a new job. Today's producers dedupe through durable state of their own
(signed-link and campaign audits, `email_deliveries`, stored webhook events) or
use keys that are never enqueued again; `billing.alerts.send` keys are kept for
good. Retention never touches `email_deliveries`.

Retention filters protected rows before acquiring row locks. If retention removes
an idempotency conflict between enqueue's insert and lookup, enqueue retries the
insert once. The booking recovery sweep skips promotions with a durable
`booking.notice_sent` audit, so pruning their job keys does not recreate sent notices.
It also looks only at promotions from the last 14 days, the succeeded-job window, and
the notice job sends nothing for an older one: a notice that finished without a sent
audit (member emails off, no SMTP, a suppressed address) is never enqueued again after
its key is pruned, and never goes out weeks late.
