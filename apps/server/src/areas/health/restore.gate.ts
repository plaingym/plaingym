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

const leaseSchema = z.strictObject({ pid: z.number().int().positive(), started: z.string().nullable() });
const t = createTranslator(locales.en ?? {});
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
    const state = await readJson(this.statePath);
    if (!state || typeof state !== 'object' || !('phase' in state)) return true;
    return state.phase !== 'complete';
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
          const lease = leaseSchema.parse(await readJson(path));
          try {
            process.kill(lease.pid, 0);
            if (lease.started !== await processStart(lease.pid)) await rm(path, { force: true });
            else active++;
          } catch (error) {
            if (missing(error) || (error as NodeJS.ErrnoException).code === 'ESRCH') await rm(path, { force: true });
            else throw error;
          }
        } catch (error) { if (!missing(error)) throw error; }
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
