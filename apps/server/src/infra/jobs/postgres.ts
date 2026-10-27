// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, asc, eq, sql } from 'drizzle-orm';
import { advisoryLockNamespace, advisoryLocks, forGym, forSystem, jobs, uuidv7 } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { JobStatsQuery, JobStats } from '../../core/interfaces/job-stats.js';
import type { Id } from '@plaingym/shared/contracts';
import { instantSchema, idSchema } from '@plaingym/shared/contracts';
import { clock as systemClock } from '../../core/clock.js';
import { describeError } from '../../core/log.js';
import type { Jobs, JobOptions, JobHandler, JobContext } from './index.js';
import { cronOccurrences, occurrenceKey, validateCron } from './cron.js';

type Scope = { forGym: typeof forGym; forSystem: typeof forSystem };
type Row = typeof jobs.$inferSelect;
type Envelope = { version: 1; timezone: string; value: unknown; schedule?: { expression: string; at: string } };
export type SystemJobContext = Omit<JobContext, 'gymId'> & { readonly gymId: null };
export type SystemJobHandler = (payload: unknown, context: SystemJobContext) => Promise<void>;
export type SystemJobOptions = Omit<JobOptions, 'gymId'>;
export interface PostgresJobsOptions {
  readonly database?: Scope;
  readonly clock?: Clock;
  readonly perGymConcurrency?: number;
  readonly leaseMs?: number;
  readonly retryBaseMs?: number;
  /** Provided by tenancy; this module never reads gym configuration tables. */
  readonly listGyms?: () => Promise<readonly Pick<JobOptions, 'gymId' | 'timezone'>[]>;
  readonly maxScheduledPerTick?: number;
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

export class PostgresJobs implements Jobs {
  readonly #database: Scope;
  readonly clock: Clock;
  readonly #cap: number;
  readonly #leaseMs: number;
  readonly #retryBaseMs: number;
  readonly #listGyms: PostgresJobsOptions['listGyms'];
  readonly #maxScheduled: number;
  readonly #handlers = new Map<string, JobHandler>();
  readonly #systemHandlers = new Map<string, SystemJobHandler>();
  readonly #schedules = new Map<string, string>();
  #started = false;
  constructor(options: PostgresJobsOptions = {}) {
    this.#database = options.database ?? { forGym, forSystem };
    this.clock = options.clock ?? systemClock;
    this.#cap = positive(options.perGymConcurrency ?? 1, 'perGymConcurrency');
    this.#leaseMs = positive(options.leaseMs ?? 30_000, 'leaseMs');
    this.#retryBaseMs = positive(options.retryBaseMs ?? 1000, 'retryBaseMs');
    this.#maxScheduled = positive(options.maxScheduledPerTick ?? 100, 'maxScheduledPerTick');
    this.#listGyms = options.listGyms;
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
    schedule?: Envelope['schedule']): Promise<{ jobId: string }> {
    if (!name) throw new Error('Job name is required');
    new Intl.DateTimeFormat('en', { timeZone: options.timezone });
    const maxAttempts = positive(options.maxAttempts ?? 3, 'maxAttempts');
    const now = this.clock.now(), runAt = options.runAt ?? now;
    if (!Number.isFinite(runAt.getTime())) throw new Error('Invalid job time');
    const id = uuidv7();
    // Schema keys are (gym_id, idempotency_key); namespace caller keys by job name.
    const idempotencyKey = options.idempotencyKey === undefined ? `unique:${id}`
      : createHash('sha256').update(JSON.stringify([name, options.idempotencyKey])).digest('hex');
    const body: Envelope = { version: 1, timezone: options.timezone, value: payload, ...(schedule ? { schedule } : {}) };
    // Validate JSON before opening a transaction, including cycles and BigInts.
    const encoded = JSON.stringify(body);
    if (!Object.hasOwn(JSON.parse(encoded) as object, 'value')) throw new Error('Job payload must be JSON');
    const insert = async (tx: Parameters<Parameters<typeof forSystem>[0]>[0]) => {
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
      await tx.update(jobs).set({ status: 'failed', lockedUntil: null, lockToken: null,
        lastError: 'Lease expired after final attempt' }).where(sql`${jobs.status} = 'running'
          and ${jobs.lockedUntil} <= ${now.toISOString()} and ${jobs.attempts} >= ${jobs.maxAttempts}`);
      const names = [...this.#handlers.keys()], systemNames = [...this.#systemHandlers.keys()];
      const gymNames = names.length ? sql`${jobs.name} in (${sql.join(names.map((name) => sql`${name}`), sql`, `)})` : sql`false`;
      const installNames = systemNames.length ? sql`${jobs.name} in (${sql.join(systemNames.map((name) => sql`${name}`), sql`, `)})` : sql`false`;
      const accepted = sql`((${jobs.gymId} is not null and ${gymNames})
        or (${jobs.gymId} is null and ${installNames}))`;
      const [candidate] = await tx.select().from(jobs).where(sql`${accepted}
        and ${jobs.attempts} < ${jobs.maxAttempts}
        and ((${jobs.status} = 'pending' and ${jobs.runAt} <= ${now.toISOString()})
          or (${jobs.status} = 'running' and ${jobs.lockedUntil} <= ${now.toISOString()}))
        and (select count(*) from jobs active where active.gym_id is not distinct from ${jobs.gymId}
          and active.status = 'running' and active.locked_until > ${now.toISOString()}) < ${this.#cap}`)
        .orderBy(asc(jobs.runAt), asc(jobs.id)).limit(1).for('update', { skipLocked: true });
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
    const backoff = Math.min(86_400_000, this.#retryBaseMs * 2 ** Math.min(row.attempts - 1, 30));
    await this.#database.forSystem(async (tx) => {
      await tx.update(jobs).set({
        status: failed ? (row.attempts >= row.maxAttempts ? 'failed' : 'pending') : 'succeeded',
        ...(failed ? { runAt: new Date(now.getTime() + backoff) } : {}),
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
  /** Durable occurrence records provide catch-up and deduplication across restarts. */
  async scheduleDue(): Promise<void> {
    assertNoTransaction('jobs.schedule');
    if (this.#schedules.size === 0) return;
    if (!this.#listGyms) throw new Error('Scheduled jobs require a tenancy listGyms provider');
    const now = this.clock.now();
    for (const gym of await this.#listGyms()) for (const [name, expression] of this.#schedules) {
      const latest = await this.#database.forGym(gym.gymId, async (tx) => {
        const [row] = await tx.select({ at: sql<string>`${jobs.payload}->'schedule'->>'at'` }).from(jobs)
          .where(and(eq(jobs.name, name), sql`${jobs.payload}->'schedule'->>'expression' = ${expression}`,
            sql`${jobs.payload}->>'timezone' = ${gym.timezone}`))
          .orderBy(sql`${jobs.payload}->'schedule'->>'at' desc`).limit(1);
        return row?.at;
      });
      const after = latest ? new Date(latest) : new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 1);
      let count = 0;
      for (const at of cronOccurrences(expression, gym.timezone, after, now)) {
        if (count++ >= this.#maxScheduled) break;
        await this.#enqueue(name, {}, { timezone: gym.timezone, runAt: at,
          idempotencyKey: JSON.stringify(['cron', expression, gym.timezone, occurrenceKey(at, gym.timezone)]) },
        gym.gymId, { expression, at: at.toISOString() });
      }
    }
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
    const loop = (async () => {
      while (!abort.signal.aborted) {
        try {
          // A paused worker claims and schedules nothing; running jobs finish normally.
          const paused = options.paused ? await options.paused() : false;
          if (!paused) await this.scheduleDue();
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
