// SPDX-License-Identifier: AGPL-3.0-only
import { forSystem, gyms } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { JobRegistration } from '../core/registry.js';
import type { PostgresJobs } from '../infra/jobs/postgres.js';
import { logError } from '../core/log.js';
import type { DemoService } from './service.js';
import type { DemoPool } from './pool.js';
import { sandboxSettings, type DemoConfig, type SeedRecovery } from './config.js';

/** Explicit install job also retries suspended gyms whose upload cleanup failed. */
export function registerDemoCleanup(queue: Pick<PostgresJobs, 'handleSystem' | 'enqueueSystem' | 'pendingSystemPayloads'>, options: {
  config: DemoConfig; service: DemoService; pool?: DemoPool; clock: Clock; system?: typeof forSystem;
}) {
  const system = options.system ?? forSystem;
  const wake = async () => { await queue.enqueueSystem('demo.pool', {}, { timezone: 'UTC',
    idempotencyKey: String(Math.floor(options.clock.now().getTime() / 2_000)), maxAttempts: 20 }); };
  if (options.config.enabled && options.pool) {
    queue.handleSystem('demo.pool', async () => { await options.pool!.refill(); });
    queue.handleSystem('demo.replace-seed', async payload => { await options.pool!.recoverSeed(payload); });
    options.pool.setWake(wake);
    options.pool.setRecoveryCheckpoint(async recovery => {
      await queue.enqueueSystem('demo.replace-seed', recovery, { timezone: 'UTC', idempotencyKey: recovery.gymId, maxAttempts: 20 });
    });
    options.pool.setRecoveryLookup(async ticketHash => {
      const pending = await queue.pendingSystemPayloads('demo.replace-seed');
      return pending.find(payload => sandboxSettings({ demo: (payload as SeedRecovery | null)?.demo })?.ticketHash === ticketHash) as SeedRecovery | undefined;
    });
  }
  if (options.config.enabled) queue.handleSystem('demo.expire', async () => {
    const rows = await system((tx) => tx.select({ id: gyms.id, settings: gyms.settings }).from(gyms));
    for (const gym of rows) {
      const marker = (gym.settings as { bootstrapOwnerEmail?: unknown }).bootstrapOwnerEmail;
      if (sandboxSettings(gym.settings) || (typeof marker === 'string' && /^demo-(?:reservation|replacement)\.[0-9a-f-]{36}@example[.]invalid$/.test(marker))) {
        try { await options.service.expire(gym.id); }
        catch (error) { logError('demo.cleanup_failed', { gymId: gym.id }, error); }
      }
    }
  });
  return { async scheduleDue() {
    if (options.config.enabled && options.pool) await wake();
    if (options.config.enabled) await queue.enqueueSystem('demo.expire', {}, { timezone: 'UTC',
      idempotencyKey: String(Math.floor(options.clock.now().getTime() / 300_000)), maxAttempts: 5 });
  } };
}
// Runtime opts into install cleanup explicitly; normal gyms get no demo cron jobs.
export const jobs: readonly JobRegistration[] = [];
