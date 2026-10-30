<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# PostgreSQL jobs

`PostgresJobs` implements `Jobs`; `PostgresJobStatsQuery` implements the health
query. The frozen interfaces and in-memory fake remain exported from `index.ts`.

Register handlers, then call `startJobsWorker(queue, options)`. Await
`worker.stop()` before closing the database: it stops new claims and waits for
handlers and lease heartbeats. `runNext()` drains one due job without starting a
polling loop. The default process concurrency is four, the shared per-gym cap is
one, and leases last 30 seconds with a heartbeat every third of the lease.
Workers must use the same cap. All workers coordinate their short cap-check and
claim transactions with an advisory lock and `FOR UPDATE SKIP LOCKED`. Each claim
counts live leases per gym once (a CTE), leaves out gyms at their cap, then takes
the earliest due job, so a gym's backlog never runs a cap check per row.

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
cursor and starts a new generation. A missing or replaced cursor is seeded from
the newest occurrence row of that generation, as earlier releases kept it, so an
upgrade neither skips nor repeats occurrences; all of a gym's missing cursors are
seeded in one transaction before any of its occurrences is enqueued. Schedule
handler effects need the same idempotency guarantees as other jobs.

## Retention

With `retention: { keep }`, the queue registers the install job `jobs.retention`
and `scheduleDue()` enqueues it once per UTC day at 03:30 (or at once in a process
that starts later that day). It deletes, in batches of 1,000 short transactions,
succeeded jobs that finished more than 14 days ago and failed jobs that failed
more than 90 days ago, for every gym and the install. It never deletes pending or running
jobs, jobs named in `keep` (their idempotency keys must stay unique for good), or
a gym's cron occurrence rows before that gym has cursors, since those rows are
then still its scheduler's watermark. Job statistics count only retained rows.
Producers must not rely on a pruned job's key: a later enqueue with that key
creates a new job. Today's producers dedupe through durable state of their own
(signed-link and campaign audits, `email_deliveries`, stored webhook events) or
use keys that are never enqueued again; `billing.alerts.send` keys are kept for
good. Retention never touches `email_deliveries`.
