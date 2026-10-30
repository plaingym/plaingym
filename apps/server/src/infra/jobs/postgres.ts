// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, asc, eq, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import { advisoryLockNamespace, advisoryLocks, forGym, forSystem, jobs, jobScheduleCursors, uuidv7 } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { JobStatsQuery, JobStats } from '../../core/interfaces/job-stats.js';
import type { Id } from '@plaingym/shared/contracts';
import { instantSchema, idSchema } from '@plaingym/shared/contracts';
import { clock as systemClock } from '../../core/clock.js';
import { describeError } from '../../core/log.js';
import type { Jobs, JobOptions, JobHandler, JobContext, JobRecovery, FailedJob } from './index.js';
import { cronOccurrences, occurrenceKey, validateCron } from './cron.js';

type Scope = { forGym: typeof forGym; forSystem: typeof forSystem };
type Row = typeof jobs.$inferSelect;
type Tx = Parameters<Parameters<typeof forSystem>[0]>[0];
type Gym = Pick<JobOptions, 'gymId' | 'timezone'>;
type Envelope = { version: 1; timezone: string; value: unknown; schedule?: { expression: string; at: string } };
export type SystemJobContext = Omit<JobContext, 'gymId'> & { readonly gymId: null };
export type SystemJobHandler = (payload: unknown, context: SystemJobContext) => Promise<void>;
export type SystemJobOptions = Omit<JobOptions, 'gymId'>;
/** Install-level pruning of finished job rows, once per UTC day. */
export interface JobRetentionOptions {
  /** Job names whose rows are kept for good, because their idempotency keys must stay unique forever. */
  readonly keep: readonly string[];
  readonly succeededDays?: number;
  readonly failedDays?: number;
  readonly batchSize?: number;
}
export interface PostgresJobsOptions {
  readonly database?: Scope;
  readonly clock?: Clock;
  readonly perGymConcurrency?: number;
  readonly leaseMs?: number;
  readonly retryBaseMs?: number;
  /** Provided by tenancy; this module never reads gym configuration tables. */
  readonly listGyms?: () => Promise<readonly Gym[]>;
  readonly maxScheduledPerTick?: number;
  /** Registers the daily `jobs.retention` install job; without it every row is kept. */
  readonly retention?: JobRetentionOptions;
}
export interface WorkerOptions {
  readonly concurrency?: number;
  readonly pollMs?: number;
  readonly onError?: (error: unknown) => void;
  /** Checked before each poll, e.g. while a restore holds the install. */
  readonly paused?: () => Promise<boolean>;
  /** Wraps each job execution, e.g. in a restore-gate activity lease. */
  readonly around?: (execute: () => Promise<void>) => Promise<void>;
}
export interface JobWorker { stop(): Promise<void> }
export const retentionJob = 'jobs.retention';
const day = 86_400_000;
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
function envelope(value: unknown): Envelope {
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
    || !('timezone' in value) || typeof value.timezone !== 'string' || !('value' in value))
    throw new Error('Invalid job envelope');
  return value as Envelope;
}
// Schema keys are (gym_id, idempotency_key); namespace caller keys by job name.
const hashKey = (name: string, key: string) => createHash('sha256').update(JSON.stringify([name, key])).digest('hex');

export class PostgresJobs implements Jobs, JobRecovery {
  readonly #database: Scope;
  readonly clock: Clock;
  readonly #cap: number;
  readonly #leaseMs: number;
  readonly #retryBaseMs: number;
  readonly #listGyms: PostgresJobsOptions['listGyms'];
  readonly #maxScheduled: number;
  readonly #retention: Required<JobRetentionOptions> | undefined;
  readonly #handlers = new Map<string, JobHandler>();
  readonly #systemHandlers = new Map<string, SystemJobHandler>();
  readonly #schedules = new Map<string, string>();
  #retentionDay: string | undefined;
  #started = false;
  constructor(options: PostgresJobsOptions = {}) {
    this.#database = options.database ?? { forGym, forSystem };
    this.clock = options.clock ?? systemClock;
    this.#cap = positive(options.perGymConcurrency ?? 1, 'perGymConcurrency');
    this.#leaseMs = positive(options.leaseMs ?? 30_000, 'leaseMs');
    this.#retryBaseMs = positive(options.retryBaseMs ?? 1000, 'retryBaseMs');
    this.#maxScheduled = positive(options.maxScheduledPerTick ?? 100, 'maxScheduledPerTick');
    this.#listGyms = options.listGyms;
    if (options.retention) {
      const { keep, succeededDays = 14, failedDays = 90, batchSize = 1000 } = options.retention;
      this.#retention = { keep: [...keep], succeededDays: positive(succeededDays, 'succeededDays'),
        failedDays: positive(failedDays, 'failedDays'), batchSize: positive(batchSize, 'batchSize') };
      this.handleSystem(retentionJob, async () => { await this.prune(); });
    }
  }
  handle(name: string, handler: JobHandler): void {
    if (!name || this.#handlers.has(name)) throw new Error(`Duplicate or empty job handler: ${name}`);
    this.#handlers.set(name, handler);
  }
  handleSystem(name: string, handler: SystemJobHandler): void {
    if (!name || this.#systemHandlers.has(name)) throw new Error(`Duplicate or empty system handler: ${name}`);
    this.#systemHandlers.set(name, handler);
  }
  schedule(name: string, cron: string, handler: JobHandler): void {
    validateCron(cron);
    this.handle(name, handler);
    this.#schedules.set(name, cron);
  }
  async enqueue(name: string, payload: unknown, options: JobOptions): Promise<{ jobId: string }> {
    assertNoTransaction('jobs.enqueue');
    idSchema.parse(options.gymId);
    return this.#enqueue(name, payload, options, options.gymId);
  }
  /** Install jobs have an explicit null gym context and a separate handler registry. */
  async enqueueSystem(name: string, payload: unknown, options: SystemJobOptions): Promise<{ jobId: string }> {
    assertNoTransaction('jobs.enqueue');
    return this.#enqueue(name, payload, options, null);
  }
  async #enqueue(name: string, payload: unknown, options: SystemJobOptions, gymId: string | null,
    schedule?: Envelope['schedule'] & { name: string }): Promise<{ jobId: string }> {
    if (!name) throw new Error('Job name is required');
    new Intl.DateTimeFormat('en', { timeZone: options.timezone });
    const maxAttempts = positive(options.maxAttempts ?? 3, 'maxAttempts');
    const now = this.clock.now(), runAt = options.runAt ?? now;
    if (!Number.isFinite(runAt.getTime())) throw new Error('Invalid job time');
    const id = uuidv7();
    const idempotencyKey = options.idempotencyKey === undefined ? `unique:${id}` : hashKey(name, options.idempotencyKey);
    const body: Envelope = { version: 1, timezone: options.timezone, value: payload,
      ...(schedule ? { schedule: { expression: schedule.expression, at: schedule.at } } : {}) };
    // Validate JSON before opening a transaction, including cycles and BigInts.
    const encoded = JSON.stringify(body);
    if (!Object.hasOwn(JSON.parse(encoded) as object, 'value')) throw new Error('Job payload must be JSON');
    const insert = async (tx: Tx) => {
      // An occurrence and its schedule's cursor commit together, so a crash neither skips nor repeats it.
      if (schedule && gymId) await tx.update(jobScheduleCursors).set({ lastOccurrence: new Date(schedule.at) }).where(and(
        eq(jobScheduleCursors.gymId, gymId), eq(jobScheduleCursors.name, schedule.name), eq(jobScheduleCursors.expression, schedule.expression),
        eq(jobScheduleCursors.timezone, options.timezone), lt(jobScheduleCursors.lastOccurrence, new Date(schedule.at))));
      const [row] = await tx.insert(jobs).values({ id, gymId, name, payload: JSON.parse(encoded) as unknown,
        runAt, maxAttempts, idempotencyKey, createdAt: now }).onConflictDoNothing().returning({ id: jobs.id });
      if (row) return { jobId: row.id };
      const [existing] = await tx.select({ id: jobs.id }).from(jobs).where(and(
        sql`${jobs.gymId} is not distinct from ${gymId}::uuid`, eq(jobs.idempotencyKey, idempotencyKey)));
      if (!existing) throw new Error('Idempotent job disappeared');
      return { jobId: existing.id };
    };
    return gymId === null ? this.#database.forSystem(insert) : this.#database.forGym(gymId, insert);
  }
  async #claim(): Promise<Row | undefined> {
    assertNoTransaction('jobs.claim');
    const now = this.clock.now();
    return this.#database.forSystem(async (tx) => {
      // Serialize only the short cap check + claim across processes. A second worker
      // skips this tick rather than waiting with a pooled connection held.
      const lock = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(${advisoryLockNamespace}::int, ${advisoryLocks.jobClaims}::int) as acquired`);
      if (!lock[0]?.acquired) return undefined;
      await tx.update(jobs).set({ status: 'failed', lockedUntil: null, lockToken: null, runAt: now,
        lastError: 'Lease expired after final attempt' }).where(sql`${jobs.status} = 'running'
          and ${jobs.lockedUntil} <= ${now.toISOString()} and ${jobs.attempts} >= ${jobs.maxAttempts}`);
      const names = [...this.#handlers.keys()], systemNames = [...this.#systemHandlers.keys()];
      const gymNames = names.length ? sql`${jobs.name} in (${sql.join(names.map((name) => sql`${name}`), sql`, `)})` : sql`false`;
      const installNames = systemNames.length ? sql`${jobs.name} in (${sql.join(systemNames.map((name) => sql`${name}`), sql`, `)})` : sql`false`;
      const accepted = sql`((${jobs.gymId} is not null and ${gymNames})
        or (${jobs.gymId} is null and ${installNames}))`;
      // Count live leases per gym once, then skip gyms at their cap. Install jobs share the null-gym bucket.
      const busy = tx.$with('busy').as(tx.select({ gymId: jobs.gymId }).from(jobs)
        .where(sql`${jobs.status} = 'running' and ${jobs.lockedUntil} > ${now.toISOString()}`)
        .groupBy(jobs.gymId).having(sql`count(*) >= ${this.#cap}`));
      const [candidate] = await tx.with(busy).select().from(jobs).where(sql`${accepted}
        and ${jobs.attempts} < ${jobs.maxAttempts}
        and ((${jobs.status} = 'pending' and ${jobs.runAt} <= ${now.toISOString()})
          or (${jobs.status} = 'running' and ${jobs.lockedUntil} <= ${now.toISOString()}))
        and not exists (select 1 from ${busy} where ${busy.gymId} is not distinct from ${jobs.gymId})`)
        .orderBy(asc(jobs.runAt), asc(jobs.id)).limit(1).for('update', { of: jobs, skipLocked: true });
      if (!candidate) return undefined;
      const [claimed] = await tx.update(jobs).set({ status: 'running', attempts: candidate.attempts + 1,
        lockedUntil: new Date(now.getTime() + this.#leaseMs), lockToken: uuidv7(), lastError: null })
        .where(eq(jobs.id, candidate.id)).returning();
      return claimed;
    });
  }
  async #renew(row: Row): Promise<void> {
    const now = this.clock.now();
    await this.#database.forSystem(async (tx) => {
      await tx.update(jobs).set({ lockedUntil: new Date(now.getTime() + this.#leaseMs) }).where(and(
        eq(jobs.id, row.id), eq(jobs.lockToken, row.lockToken!), eq(jobs.status, 'running'), sql`${jobs.lockedUntil} > ${now.toISOString()}`));
    });
  }
  async #execute(row: Row): Promise<void> {
    const heartbeatAbort = new AbortController();
    const heartbeat = (async () => {
      while (!heartbeatAbort.signal.aborted) {
        try { await delay(Math.max(1, Math.floor(this.#leaseMs / 3)), undefined, { signal: heartbeatAbort.signal }); }
        catch { return; }
        if (!heartbeatAbort.signal.aborted) await this.#renew(row);
      }
    })();
    // Keep a rejection observed immediately; acknowledgement remains lease-fenced.
    const heartbeatResult = heartbeat.catch(() => undefined);
    let failure: unknown, failed = false;
    try {
      const body = envelope(row.payload);
      const context = { jobId: row.id, timezone: body.timezone, attempt: row.attempts, clock: this.clock };
      if (row.gymId === null) await this.#systemHandlers.get(row.name)!(body.value, { ...context, gymId: null });
      else await this.#handlers.get(row.name)!(body.value, { ...context, gymId: row.gymId });
    } catch (error) { failed = true; failure = error; }
    finally { heartbeatAbort.abort(); await heartbeatResult; }
    const now = this.clock.now();
    const final = row.attempts >= row.maxAttempts;
    const backoff = Math.min(day, this.#retryBaseMs * 2 ** Math.min(row.attempts - 1, 30));
    await this.#database.forSystem(async (tx) => {
      await tx.update(jobs).set({
        status: failed ? (final ? 'failed' : 'pending') : 'succeeded',
        // A finished row's run time records when it finished: retention and failed-job lookups read it.
        runAt: failed && !final ? new Date(now.getTime() + backoff) : now,
        lastError: failed ? (({ name, code }) => JSON.stringify({ name, code }))(describeError(failure)) : null,
        lockedUntil: null, lockToken: null,
      }).where(and(eq(jobs.id, row.id), eq(jobs.status, 'running'), eq(jobs.lockToken, row.lockToken!),
        sql`${jobs.lockedUntil} > ${now.toISOString()}`));
    });
  }
  /** Runs one due job; useful for deterministic command-line drains and tests. */
  async runNext(): Promise<boolean> {
    const row = await this.#claim();
    if (!row) return false;
    await this.#execute(row);
    return true;
  }
  /** Only rows marked failed: an expired final lease counts once a claim marks it failed. */
  async failedJobs(name: string, idempotencyKeys: readonly string[], options: { gymId: string }): Promise<FailedJob[]> {
    assertNoTransaction('jobs.failedJobs');
    idSchema.parse(options.gymId);
    if (!idempotencyKeys.length) return [];
    const keys = new Map(idempotencyKeys.map((key) => [hashKey(name, key), key]));
    const rows = await this.#database.forGym(options.gymId, (tx) => tx.select({ id: jobs.id, key: jobs.idempotencyKey,
      runAt: jobs.runAt }).from(jobs).where(and(eq(jobs.name, name), inArray(jobs.idempotencyKey, [...keys.keys()]),
      eq(jobs.status, 'failed'))));
    return rows.map((row) => ({ jobId: row.id, idempotencyKey: keys.get(row.key)!, failedAt: row.runAt }));
  }
  /** Resets one failed job of the gym to pending with fresh attempts, keeping its ID and key; other jobs are left alone. */
  async retryFailed(jobId: string, options: { gymId: string; runAt: Date }): Promise<boolean> {
    assertNoTransaction('jobs.retryFailed');
    idSchema.parse(options.gymId);
    if (!Number.isFinite(options.runAt.getTime())) throw new Error('Invalid job time');
    const reset = await this.#database.forGym(options.gymId, (tx) => tx.update(jobs).set({ status: 'pending', attempts: 0,
      runAt: options.runAt, lockedUntil: null, lockToken: null, lastError: null })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'failed'))).returning({ id: jobs.id }));
    return reset.length > 0;
  }
  /** Seeds missing or replaced cursors from the newest matching occurrence row, where earlier releases kept them. */
  async #seed(gym: Gym, missing: readonly (readonly [string, string])[], now: Date): Promise<Map<string, Date>> {
    // On first registration the current minute is eligible.
    const initial = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 1);
    return this.#database.forGym(gym.gymId, async (tx) => {
      const history = await tx.select({ name: jobs.name, at: sql<string | null>`max(${jobs.payload}->'schedule'->>'at')` })
        .from(jobs).where(and(sql`${jobs.payload}->>'timezone' = ${gym.timezone}`, or(...missing.map(([name, expression]) =>
          and(eq(jobs.name, name), sql`${jobs.payload}->'schedule'->>'expression' = ${expression}`)))))
        .groupBy(jobs.name);
      const latest = new Map(history.map((row) => [row.name, row.at]));
      const saved = await tx.insert(jobScheduleCursors).values(missing.map(([name, expression]) => {
        const at = latest.get(name);
        return { gymId: gym.gymId, name, expression, timezone: gym.timezone, lastOccurrence: at ? new Date(at) : initial };
      })).onConflictDoUpdate({ target: [jobScheduleCursors.gymId, jobScheduleCursors.name], set: {
        expression: sql`excluded.expression`, timezone: sql`excluded.timezone`,
        // A concurrent scheduler may have advanced the same generation already; never move it back.
        lastOccurrence: sql`case when ${jobScheduleCursors.expression} = excluded.expression
          and ${jobScheduleCursors.timezone} = excluded.timezone
          then greatest(${jobScheduleCursors.lastOccurrence}, excluded.last_occurrence) else excluded.last_occurrence end`,
      } }).returning();
      return new Map(saved.map((row) => [row.name, row.lastOccurrence]));
    });
  }
  /** Durable cursors provide catch-up across restarts; occurrence keys collapse competing schedulers. */
  async scheduleDue(): Promise<void> {
    assertNoTransaction('jobs.schedule');
    const now = this.clock.now();
    if (this.#retention) await this.#scheduleRetention(now);
    if (this.#schedules.size === 0) return;
    if (!this.#listGyms) throw new Error('Scheduled jobs require a tenancy listGyms provider');
    const gyms = await this.#listGyms();
    for (let offset = 0; offset < gyms.length; offset += 500) await this.#scheduleGyms(gyms.slice(offset, offset + 500), now);
  }
  async #scheduleGyms(gyms: readonly Gym[], now: Date): Promise<void> {
    // One query reads a batch of gyms' cursors, instead of a scan of job payloads per gym and schedule.
    const cursors = Map.groupBy(await this.#database.forSystem((tx) => tx.select().from(jobScheduleCursors)
      .where(inArray(jobScheduleCursors.gymId, gyms.map((gym) => gym.gymId)))), (row) => row.gymId);
    for (const gym of gyms) {
      const current = new Map((cursors.get(gym.gymId) ?? []).filter((row) => row.timezone === gym.timezone
        && row.expression === this.#schedules.get(row.name)).map((row) => [row.name, row.lastOccurrence]));
      // All of a gym's missing cursors are seeded in one transaction, before any of its occurrences is enqueued.
      const missing = [...this.#schedules].filter(([name]) => !current.has(name));
      if (missing.length) for (const [name, at] of await this.#seed(gym, missing, now)) current.set(name, at);
      for (const [name, expression] of this.#schedules) {
        let count = 0;
        for (const at of cronOccurrences(expression, gym.timezone, current.get(name)!, now)) {
          if (count++ >= this.#maxScheduled) break;
          await this.#enqueue(name, {}, { timezone: gym.timezone, runAt: at,
            idempotencyKey: JSON.stringify(['cron', expression, gym.timezone, occurrenceKey(at, gym.timezone)]) },
          gym.gymId, { name, expression, at: at.toISOString() });
        }
      }
    }
  }
  async #scheduleRetention(now: Date): Promise<void> {
    const date = now.toISOString().slice(0, 10);
    if (this.#retentionDay === date) return;
    // Once per UTC day at 03:30, or at once when a process starts later that day.
    await this.#enqueue(retentionJob, {}, { timezone: 'UTC', runAt: new Date(`${date}T03:30:00Z`),
      idempotencyKey: date, maxAttempts: 3 }, null);
    this.#retentionDay = date;
  }
  /**
   * Deletes succeeded jobs that finished more than `succeededDays` ago and failed jobs more than `failedDays` ago, in
   * batches. Pending and running jobs and the `keep` names are never deleted.
   */
  async prune(): Promise<number> {
    assertNoTransaction('jobs.prune');
    if (!this.#retention) throw new Error('Job retention is not configured');
    const { keep, succeededDays, failedDays, batchSize } = this.#retention;
    const now = this.clock.now().getTime();
    const deletable = and(keep.length ? notInArray(jobs.name, [...keep]) : undefined,
      // Until a gym's cursors are seeded, its newest occurrence rows are the scheduler's only watermark.
      sql`(${jobs.payload}->'schedule' is null or exists (select 1 from ${jobScheduleCursors}
        where ${jobScheduleCursors.gymId} = ${jobs.gymId}))`)!;
    let deleted = 0;
    for (const [status, days] of [['succeeded', succeededDays], ['failed', failedDays]] as const) {
      const before = new Date(now - days * day);
      // Each batch continues after the last row the previous one read, so kept rows are read once per run.
      let after: { runAt: Date; id: string } | undefined;
      for (;;) {
        const batch = await this.#database.forSystem(async (tx) => {
          const rows = await tx.select({ id: jobs.id, runAt: jobs.runAt, deletable: sql<boolean>`${deletable}` }).from(jobs)
            .where(and(eq(jobs.status, status), lt(jobs.runAt, before), after
              ? sql`(${jobs.runAt}, ${jobs.id}) > (${after.runAt.toISOString()}::timestamptz, ${after.id}::uuid)` : undefined))
            .orderBy(asc(jobs.runAt), asc(jobs.id)).limit(batchSize).for('update', { skipLocked: true });
          const ids = rows.filter((row) => row.deletable).map((row) => row.id);
          if (ids.length) await tx.delete(jobs).where(inArray(jobs.id, ids));
          return { read: rows.length, deleted: ids.length, last: rows.at(-1) };
        });
        deleted += batch.deleted;
        if (batch.read < batchSize) break;
        after = batch.last;
      }
    }
    return deleted;
  }
  start(options: WorkerOptions = {}): JobWorker {
    assertNoTransaction('jobs.start');
    if (this.#started) throw new Error('Worker already started');
    const concurrency = positive(options.concurrency ?? 4, 'concurrency');
    const pollMs = positive(options.pollMs ?? 1000, 'pollMs');
    if (this.#schedules.size && !this.#listGyms) throw new Error('Scheduled jobs require a tenancy listGyms provider');
    this.#started = true;
    const abort = new AbortController();
    const running = new Set<Promise<void>>();
    const report = (error: unknown) => { if (options.onError) options.onError(error); else console.error('Jobs worker infrastructure error', error); };
    let scheduledMinute: number | undefined;
    const loop = (async () => {
      while (!abort.signal.aborted) {
        try {
          // A paused worker claims and schedules nothing; running jobs finish normally.
          const paused = options.paused ? await options.paused() : false;
          // Cron has minute resolution: schedule once per clock minute, not on every poll. A failed
          // tick waits for the next minute; cursors catch up whatever it missed.
          const minute = Math.floor(this.clock.now().getTime() / 60_000);
          if (!paused && minute !== scheduledMinute) { scheduledMinute = minute; await this.scheduleDue(); }
          while (!paused && !abort.signal.aborted && running.size < concurrency) {
            const row = await this.#claim();
            if (!row) break;
            const execute = () => this.#execute(row);
            const task = (options.around ? options.around(execute) : execute()).catch(report).finally(() => { running.delete(task); });
            running.add(task);
          }
        } catch (error) { report(error); }
        try { await delay(pollMs, undefined, { signal: abort.signal }); } catch { break; }
      }
    })();
    return { stop: async () => {
      abort.abort();
      try { await loop; await Promise.all(running); } finally { this.#started = false; }
    } };
  }
}
export function startJobsWorker(queue: PostgresJobs, options?: WorkerOptions): JobWorker { return queue.start(options); }

export class PostgresJobStatsQuery implements JobStatsQuery {
  constructor(readonly database: Pick<Scope, 'forSystem'> = { forSystem }) {}
  async get(gymId: Id): Promise<JobStats> {
    idSchema.parse(gymId);
    return this.database.forSystem(async (tx) => {
      const [row] = await tx.select({
        pending: sql<number>`count(*) filter (where ${jobs.status} = 'pending')::int`,
        running: sql<number>`count(*) filter (where ${jobs.status} = 'running')::int`,
        succeeded: sql<number>`count(*) filter (where ${jobs.status} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${jobs.status} = 'failed')::int`,
        oldest: sql<string | null>`min(${jobs.runAt}) filter (where ${jobs.status} = 'pending')`,
      }).from(jobs).where(eq(jobs.gymId, gymId));
      if (!row) throw new Error('Missing job statistics');
      return { pending: row.pending, running: row.running, succeeded: row.succeeded, failed: row.failed,
        oldestPendingAt: row.oldest === null ? null : instantSchema.parse(new Date(row.oldest).toISOString()) };
    });
  }
}
