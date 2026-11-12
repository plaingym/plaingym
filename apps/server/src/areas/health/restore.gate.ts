// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { MiddlewareHandler } from 'hono';
import { AppError, createTranslator, errorResponse } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import type { RequestEnvironment } from '../../core/context.js';
import { atomicJson, exists, missing, privateDirectory, readJson } from './backups.files.js';
import { RestoreFailure } from './restore.failure.js';

/** Every journal phase before `complete`: a restore is staged and `resume` can finish it. */
export const unfinishedRestorePhases = ['verified', 'database_restored', 'migrated', 'rekeyed', 'moving_old', 'moving_new', 'uploads_switched'] as const;
const leaseSchema = z.strictObject({ pid: z.number().int().positive(), started: z.string().nullable() });
const t = createTranslator(locales.en ?? {});
/**
 * A lease only marks a request or job of a running process, so once every process on the data volume has stopped,
 * no lease is live and the folder can go; the next start's `resume` then drains nothing and carries on.
 */
const invalidLease = 'The restore activity lease is invalid; stop the app, delete the restore-activity folder on its data volume, then start the app';
async function processStart(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  // Linux start ticks distinguish an abandoned lease from a reused PID after container restart.
  const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
}
/**
 * File-backed admission and activity leases live outside the overwritten database.
 * Processes on a single install share the app container's PID namespace and data volume.
 */
export class RestoreGate {
  #closing = false;
  readonly statePath: string;
  readonly activityDirectory: string;
  constructor(readonly dataDirectory: string) {
    this.statePath = join(dataDirectory, 'restore-state.json');
    this.activityDirectory = join(dataDirectory, 'restore-activity');
  }
  async isClosed(): Promise<boolean> {
    if (this.#closing) return true;
    if (!await exists(this.statePath)) return false;
    const state = await readRestoreJournal(this.statePath);
    if (!state || typeof state !== 'object' || !('phase' in state)) return true;
    return state.phase !== 'complete';
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
    await privateDirectory(this.activityDirectory);
    const lease = join(this.activityDirectory, randomUUID() + '.json');
    await atomicJson(lease, { pid: process.pid, started: await processStart(process.pid) });
    try {
      if (await this.isClosed()) throw new AppError('unavailable', t('health/restore:inProgress'));
      return await action();
    } finally { await rm(lease, { force: true }); }
  }
  async close(): Promise<void> {
    this.#closing = true;
    for (;;) {
      let names: string[];
      try { names = await readdir(this.activityDirectory); }
      catch (error) { if (missing(error)) return; throw error; }
      let active = 0;
      for (const name of names) {
        if (!/^[a-f0-9-]+[.]json$/.test(name)) continue;
        const path = join(this.activityDirectory, name);
        try {
          const parsed = leaseSchema.safeParse(await readActivity(path));
          if (!parsed.success) throw new RestoreFailure(invalidLease);
          const lease = parsed.data;
          try {
            process.kill(lease.pid, 0);
            if (lease.started !== await processStart(lease.pid)) await rm(path, { force: true });
            else active++;
          } catch (error) {
            if (missing(error) || (error as NodeJS.ErrnoException).code === 'ESRCH') await rm(path, { force: true });
            else throw error;
          }
        } catch (error) {
          if (error instanceof SyntaxError || (error instanceof Error && error.message === 'Metadata exceeds size limit'))
            throw new RestoreFailure(invalidLease);
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
    if (error instanceof Error && 'code' in error) throw error;
    throw new RestoreFailure('The restore journal is not in a format this version reads');
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
