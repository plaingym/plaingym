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
claim transactions with an advisory lock and `FOR UPDATE SKIP LOCKED`.

Handlers execute outside transactions. They receive the persisted timezone,
gym, attempt number, job ID, and injected clock, and open their own short database
scopes. Jobs are at-least-once: after a crash or lost lease the handler can run
again, so external effects must use idempotency keys. The lock token fences every
heartbeat and acknowledgement so an old handler cannot overwrite its replacement.
Retries start at one second, double per failure, and are capped at one day.
Unregistered job names stay pending for a worker that has their handlers.

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
fall-back wall-clock minute has one occurrence key. Enqueueing an occurrence
persists the cursor and idempotency key atomically. On first registration the
current minute is eligible; subsequent ticks and restarts catch up from the last
persisted occurrence, with at most 100 occurrences per gym and schedule per tick.
Keep occurrence rows to retain catch-up and deduplication history. Schedule name,
expression, and timezone identify a schedule generation; changing expression or
timezone starts a new generation. Schedule handler effects need the same
idempotency guarantees as other jobs.
