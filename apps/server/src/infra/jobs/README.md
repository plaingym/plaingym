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
Workers must use the same caps and register the same batch and notice jobs. All workers coordinate their short cap-check and
claim transactions with an advisory lock and `FOR UPDATE SKIP LOCKED`. Each claim
counts live leases per gym and lane once (a CTE), leaves out each gym's lanes at
their cap, then takes the earliest due job, so a gym's backlog never runs a cap
check per row. Long batch work and member notices each run in a lane of their own
(Batch lane and Notices lane, below).

Handlers execute outside transactions. They receive the persisted timezone,
gym, attempt number, job ID, and injected clock, and open their own short database
scopes. Jobs are at-least-once: after a crash or lost lease the handler can run
again, so external effects must use idempotency keys. The lock token fences every
heartbeat and acknowledgement so an old handler cannot overwrite its replacement.
Retries start at one second, double per failure, and are capped at one day.
Unregistered job names stay pending for a worker that has their handlers. A
finished job's run time records when it succeeded or finally failed. When a
final attempt crashes, its failure time is the lease expiry, even if the next
worker starts much later.

`JobRecovery` (implemented by `PostgresJobs` and `FakeJobs`) lets a producer
recover its own exhausted jobs without reading queue rows: `failedJobs(name,
keys, { gymId })` returns the gym's failed jobs of that name among the caller's
idempotency keys, including acknowledged jobs, with their failure time.
`retryFailed(jobId, { gymId, runAt })` resets one failed job to pending with
fresh attempts and clears its acknowledgment, keeping its ID and key.
`acknowledgeFailed(jobId, { gymId, at })` sets the acknowledgment timestamp only
on a failed job that has none. `JobStatsQuery` excludes acknowledged failures
from the failed count and oldest failure time. Retention uses the same schedule
for failed jobs with or without an acknowledgment. An expired final attempt
counts once the next claim marks it failed. Its handler may still be running,
so a retried job's handler needs the same idempotency as any other.
`retryFailed` returns false for a job that is missing or has another status.

`resetFailedJobs(jobs, name, keys, gymId, plan, record)` runs the plain recovery
loop outside a transaction: for each failed job among `keys`, `plan(job)` returns
its run time or `null` to leave it failed, `retryFailed` resets it, and only a
reset that succeeded calls `record(job, runAt)` (the producer's audit). It returns
the number reset. Announcement and link campaign recovery use it; recovery that
resets under its own lock or cap keeps its own loop.

The three recovery methods above accept an optional `JobTransaction` as their last
argument, validated like `enqueue`'s. Invoice effect recovery takes its invoice lock
in that transaction and uses the same handle for queue reads, resets or acknowledgments,
and the staff audit. The fake stages writes until commit and reflects a staged
reset in subsequent failed-job reads in that transaction.

`PostgresJobs` has two more methods outside `JobRecovery`.
`acknowledgeFailedVersion({ gymId, failedVersion, at }, transaction?)` acknowledges
exactly the gym's unacknowledged failed jobs that `failedVersion` names.
`JobStatsQuery.get(gymId)` returns that version in `JobStats.failedVersion`.
A shared SQL fragment computes the MD5 digest of the gym's unacknowledged failures
in job ID order, or returns `none` when the set is empty. Each entry is
`id:run_at:failure_count`, with the time in microseconds since the epoch, independent
of the session's time zone. Every failure sets `run_at` to the time it
failed and adds one to `failure_count`: a final failure after the handler ran records
the finish time, an expired final lease its expiry, and `failInterrupted` its `at`.
`retryFailed` never resets the count, so two failures of one job differ even when they
record the same time. A job that failed before the column existed starts at 0 and
counts from its next failure. The method locks those jobs
(`FOR UPDATE`, in ID order), computes the digest over the locked rows in the same
statement, and returns `'changed'` without writing when it differs; otherwise it
acknowledges exactly the locked IDs and returns `{ acknowledged }`. A job that failed
after the version was read changes the digest, even when its failure time is earlier
(an expired final lease is recorded at its expiry), and so does a job that
`retryFailed` reset in place and that failed again under the same ID, at any time, so a failure
after the read is never acknowledged by that read. The System health page's **Acknowledge failed
jobs** action uses it. `failInterrupted(names, { at, reason })` runs in system context across every
gym and install jobs: it marks every `running` job with one of those names failed and
acknowledged, records `reason` as its error and clears its lease, and returns the
count. A restore uses it for the backup jobs its snapshot caught running, which no
worker holds in the restored database. Neither method changes jobs with any other
status, and an acknowledged job stays visible to `failedJobs`. A newer release can
resume a restore that an older one stopped after rekeying, before its normal migration
adds `failure_count`, so the restore checks for the column first: it passes
`failInterrupted` `countFailure: false` and builds its reconciliation queue with
`failureCountColumn: false`, whose enqueue then names only the columns it sets. The
migration that follows gives those rows `failure_count` 0.

Install-level work uses `enqueueSystem` and `handleSystem`, with `gymId: null` in
the handler context. These separate methods keep the gym-required `Jobs` contract
intact. Install jobs share their own concurrency bucket and never appear in gym
statistics. Database statuses are `pending`, `running`, `succeeded`, and `failed`.
`pendingSystemPayloads(name)` reads only pending/running install payloads for an
exact job name. Internal orchestration uses it to retain polling progress while
a failed demo seed's tenant reservation is being replaced; gym jobs are excluded.
The optional `eligibleGym` policy is checked immediately before a gym handler.
A false or `skip` result acknowledges the queued job without calling its handler.
`defer` returns the job to pending with its attempt count unchanged; `true` runs
it. Deferral delays start at the larger of one minute and `retryBaseMs`, double
on each consecutive deferral, and stop growing at one hour. Their count lives in
the internal envelope, survives worker restarts, and resets after eligibility
allows execution. A policy lookup error also defers without consuming an attempt,
recording only the sanitized error name and code and logging it as
`jobs.policy_error`, since a deferred job never counts as failed. This preserves work for gyms that will become eligible
later. Demo composition can supply `pool.jobPolicy` to defer pooled and unfinished
gyms and skip shared or retired ones. `createGymJobPolicy` in
`core/tenancy-jobs.ts` wraps this hook with a fresh gym-status lookup: inactive
or missing gyms return `defer`, overriding any install-specific policy, and active
gyms run by default. The runtime passes this policy to its worker queue in every
mode, wrapping `pool.jobPolicy` in demo mode. Suspended gyms keep their
queued work without spending attempts until their deletion cascades the rows;
reactivation lets the work run on its next due attempt. Install jobs bypass gym
eligibility. Its optional install policy receives a lazy `readGym()` callback;
forward it to `pool.jobPolicy(gymId, readGym)` to share one gym snapshot per job.
A job whose handler already started before suspension can finish. After
suspension, `waitForGymJobs` waits for the gym's running jobs to finish or their
leases to expire before deletion removes uploads. It reads the earliest live
lease and sleeps until it, checking at least once a second, instead of polling
every 100 ms. Each check uses a separate, short gym scope; other gyms and pending
jobs do not delay it. The wait times out after one minute, leaving the suspended
gym and its uploads available for retry. Demo expiry skips a gym with a live job
lease at the start and retries it on the next run; if a lease starts during
cleanup, the demo service suspends the gym and defers deletion instead of waiting
in the install lane. Demo refill likewise keeps busy gyms out of allocation while
still counting them in its showcase and pool inventory, so it neither swaps a
busy showcase's hostname nor seeds an extra copy.
Payloads use a versioned internal envelope to persist timezone and scheduler
and deferral metadata; handlers receive only the caller's original JSON value. Caller
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
per-gym batch lane with its own cap (default one), a job registered with
`{ lane: 'notices' }` in the notices lane (below), and every other job runs in the
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
`runNext()` claims from any lane. A job registered without a lane runs in the
default lane. `batch: { perGymConcurrency? }` tunes the batch cap;
the runtime uses the default, and each batch job names
its own lane in its registration (the daily charge run, imports, exports and
campaign jobs). Queues that only enqueue (the CLI's, restore's) need no lane.

## Notices lane

A job registered with `{ lane: 'notices' }` runs in a per-gym notices lane with
its own cap (`notices: { perGymConcurrency? }`, default one). It holds member
notices that must reach members before a class: the staff booking cancellation
notice (`bookings.cancel_notice`) and the class cancellation and restore notices
(`announcements.cancellation`, `announcements.restore_notice`). A notice held by a
slow mail server then holds only its own lane: the gym's waitlist promotions and
other default-lane jobs, and its batch work, are claimed alongside it, and the
gym's long batch job never holds its notices' lane. A gym runs one notice at a
time, so a second notice of the same gym waits for the first. Across gyms, a
worker runs at most `noticeConcurrency` notice jobs at once (at most its
concurrency; default one less, at least one). With two or more slots, batch and
notice jobs together also take at most one less than the worker's concurrency, so
the default lane always keeps a slot; a single-slot worker shares its slot between
every lane. Those shared slots are the one way batch work can delay a notice: when
running batch and notice jobs (from any gyms) already fill them, a due notice waits
for one to finish, and a due batch job likewise waits behind running notices. With
the default four slots and caps that takes three at once, so a single-gym install,
whose batch and notices lanes run one job each, never fills them. The
runtime uses the defaults, and each notice job names its lane in its registration.

## Retention

With `retention: { keep }`, the queue registers the install job `jobs.retention`
and `scheduleDue()` enqueues it once per UTC day at 03:30 (or at once in a process
that starts later that day). It deletes, in batches of 1,000 short transactions,
succeeded jobs that finished more than 14 days ago and failed jobs that failed
more than 90 days ago, for every gym and the install. It never deletes pending or running
jobs, jobs named in `keep` (their idempotency keys must stay unique for good), or
a schedule's cron occurrence rows before that gym has a cursor for it, since those
rows are then still its watermark. Job statistics count only retained rows.
`PostgresJobStatsQuery` reports the oldest pending scheduled time and the oldest
final failure time separately, scoped to the requested gym and excluding install
jobs. Each time is null when no matching rows remain. Final failures use `runAt`,
which the worker sets when the final attempt finishes or its expired lease is
marked failed; pending schedules never stand in for failure times.
Producers must not rely on a pruned job's key: a later enqueue with that key
creates a new job. Today's producers dedupe through durable state of their own
(signed-link and campaign audits, `email_deliveries`, stored webhook events) or
use keys that are never enqueued again; `billing.alerts.send` and
`billing.alerts.sms.send` keys are kept for good. Retention never touches `email_deliveries`.

Retention filters protected rows before acquiring row locks. If retention removes
an idempotency conflict between enqueue's insert and lookup, enqueue retries the
insert once. The booking recovery sweep skips promotions with a durable
`booking.notice_sent` audit, so pruning their job keys does not recreate sent notices.
It also looks only at promotions from the last 14 days, the succeeded-job window, and
the notice job sends nothing for an older one: a notice that finished without a sent
audit (member emails off, no SMTP, a suppressed address) is never enqueued again after
its key is pruned, and never goes out weeks late.
The queue exports `defaultSucceededRetentionDays`; booking notice expiry uses that
same default instead of maintaining a separate window.

`JobRecovery.existingJobs(name, keys, { gymId })` returns only the caller's retained
keys for that gym and job name, regardless of status. Both queues implement it;
recovery sweeps use it to resolve durable markers after retention removes their jobs.
Queue access stays inside infrastructure, and the method refuses transaction I/O.
