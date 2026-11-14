// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { MiddlewareHandler } from 'hono';
import { AppError, createTranslator, errorResponse } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import type { RequestEnvironment } from '../../core/context.js';
import { atomicJson, exists, MetadataSizeLimitError, missing, readJson } from './backups.files.js';
import { RestoreFailure } from './restore.failure.js';

/** Every journal phase before `complete`: a restore is staged and `resume` can finish it. */
export const unfinishedRestorePhases = ['verified', 'database_restored', 'migrated', 'rekeyed', 'moving_old', 'moving_new', 'uploads_switched'] as const;
const leaseSchema = z.strictObject({ pid: z.number().int().positive(), started: z.string().nullable() });
const t = createTranslator(locales.en ?? {});
/**
 * A lease marks a running process, so once every process on the data volume has stopped,
 * no lease is live and the folder can go; the next start's `resume` then drains nothing and carries on.
 */
const invalidLease = 'The restore activity lease is invalid; stop the app, delete the restore-activity folder on its data volume, then start the app';
async function processStart(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  // Linux start ticks distinguish an abandoned lease from a reused PID after container restart.
  const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
}
/** Shared by every gate for this data volume in this process, including maintenance callers. */
const activities = new Map<string, ProcessActivity>();
class ProcessActivity {
  count = 0;
  drains = 0;
  #lease: Promise<void> | undefined;
  #retiring: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  readonly path: string;
  constructor(readonly directory: string, readonly statePath: string) {
    this.path = join(directory, randomUUID() + '.json');
  }
  async register(): Promise<void> {
    await this.#retiring;
    if (!this.#lease) {
      this.#lease = (async () => {
        await atomicJson(this.path, { pid: process.pid, started: await processStart(process.pid) });
        this.#monitor();
      })().catch(error => { this.#lease = undefined; throw error; });
    }
    await this.#lease;
  }
  async retire(): Promise<void> {
    if (this.#retiring) return this.#retiring;
    this.#retiring = (async () => {
      await this.#lease;
      await rm(this.path, { force: true });
      this.#lease = undefined;
    })();
    try { await this.#retiring; } finally { this.#retiring = undefined; }
  }
  #monitor(): void {
    if (this.#timer) return;
    // A separate CLI cannot read our count. Once its durable journal closes admission,
    // acknowledge the drain by removing our process lease, including when already idle.
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void (async () => {
        if (this.count || this.drains) return;
        let closed: boolean;
        try { closed = await journalClosed(this.statePath); }
        catch (error) {
          // A malformed journal also refuses every admission; let the CLI drain and report it.
          if (!(error instanceof RestoreFailure)) throw error;
          closed = true;
        }
        // Admission may have begun while the journal read was pending.
        const removed = !closed && !await exists(this.directory);
        if (!this.count && (closed || removed)) await this.retire();
      })().catch(() => { /* Keep the lease on a read/remove failure: the CLI must not skip us. */ })
        .finally(() => { if (this.#lease) this.#monitor(); });
    }, 100);
    this.#timer.unref();
  }
}
async function journalClosed(path: string): Promise<boolean> {
  if (!await exists(path)) return false;
  const state = await readRestoreJournal(path);
  return !state || typeof state !== 'object' || !('phase' in state) || state.phase !== 'complete';
}
/**
 * File-backed admission and activity leases live outside the overwritten database.
 * Processes on a single install share the app container's PID namespace and data volume.
 */
export class RestoreGate {
  #closing = false;
  readonly statePath: string;
  readonly activityDirectory: string;
  readonly #activity: ProcessActivity;
  constructor(readonly dataDirectory: string) {
    this.statePath = join(dataDirectory, 'restore-state.json');
    this.activityDirectory = join(dataDirectory, 'restore-activity');
    const key = resolve(this.activityDirectory);
    let activity = activities.get(key);
    if (!activity) { activity = new ProcessActivity(key, resolve(this.statePath)); activities.set(key, activity); }
    this.#activity = activity;
  }
  async isClosed(): Promise<boolean> {
    if (this.#closing || this.#activity.drains) return true;
    return journalClosed(this.statePath);
  }
  /** Only durable, unfinished restore phases warrant a resume hint. */
  async hasStagedRestore(): Promise<boolean> {
    try {
      const state = await readJson(this.statePath);
      return typeof state === 'object' && state !== null && 'phase' in state &&
        (unfinishedRestorePhases as readonly unknown[]).includes(state.phase);
    } catch { return false; } // Reporting must not replace the original failure.
  }
  /** Wrap both requests and job executions. A separate CLI can drain these same durable leases. */
  async activity<T>(action: () => Promise<T>): Promise<T> {
    if (await this.isClosed()) throw new AppError('unavailable', t('health/restore:inProgress'));
    const activity = this.#activity;
    // Count pending admissions too: close must wait even for the first durable lease write.
    if (this.#closing || activity.drains) throw new AppError('unavailable', t('health/restore:inProgress'));
    activity.count++;
    try {
      await activity.register();
      if (await this.isClosed() || this.#closing || activity.drains)
        throw new AppError('unavailable', t('health/restore:inProgress'));
      return await action();
    } finally { activity.count--; }
  }
  async close(): Promise<void> {
    this.#closing = true;
    this.#activity.drains++;
    try {
      while (this.#activity.count) await delay(25);
      await this.#activity.retire();
      await this.#drain();
    } finally { this.#activity.drains--; }
  }
  async #drain(): Promise<void> {
    for (;;) {
      let names: string[];
      try { names = await readdir(this.activityDirectory); }
      catch (error) { if (missing(error)) return; throw error; }
      let active = 0;
      for (const name of names) {
        if (!/^[a-f0-9-]+[.]json$/.test(name)) continue;
        const path = join(this.activityDirectory, name);
        try {
          const lease = await readLease(path);
          try {
            process.kill(lease.pid, 0);
            if (lease.started !== await processStart(lease.pid)) await rm(path, { force: true });
            else active++;
          } catch (error) {
            if (missing(error) || (error as NodeJS.ErrnoException).code === 'ESRCH') await rm(path, { force: true });
            else throw error;
          }
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      if (!active) return;
      await delay(25);
    }
  }
  reopen(): void { this.#closing = false; }
  middleware(): MiddlewareHandler<RequestEnvironment> {
    return async (context, next) => {
      try { await this.activity(next); }
      catch (error) {
        if (error instanceof AppError && error.code === 'unavailable') {
          return context.json(errorResponse(error, context.get('context')?.requestId ?? randomUUID()), 503);
        }
        throw error;
      }
    };
  }
}

/** A journal that doesn't parse is never reported as snapshot corruption; a coded OS read failure stays what it is. */
export async function readRestoreJournal(path: string): Promise<unknown> {
  try { return await readJson(path); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof MetadataSizeLimitError)
      throw new RestoreFailure('The restore journal is not in a format this version reads', { cause: error });
    throw error;
  }
}

async function readLease(path: string): Promise<z.infer<typeof leaseSchema>> {
  try {
    const parsed = leaseSchema.safeParse(await readActivity(path));
    if (parsed.success) return parsed.data;
    throw parsed.error;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof MetadataSizeLimitError || error instanceof z.ZodError)
      throw new RestoreFailure(invalidLease, { cause: error });
    throw error;
  }
}

/** Windows can temporarily deny a read while a worker removes its lease. Never skip a live lease. */
async function readActivity(path: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try { return await readJson(path); }
    catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay(10 * (attempt + 1));
    }
  }
}
