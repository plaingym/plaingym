// SPDX-License-Identifier: AGPL-3.0-only
import { forSystem, gyms } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { JobRegistration } from '../core/registry.js';
import type { PostgresJobs } from '../infra/jobs/postgres.js';
import type { DemoService } from './service.js';
import { sandboxSettings, type DemoConfig } from './config.js';

/** Explicit install job also retries suspended gyms whose upload cleanup failed. */
export function registerDemoCleanup(queue: Pick<PostgresJobs, 'handleSystem' | 'enqueueSystem'>, options: {
  config: DemoConfig; service: DemoService; clock: Clock; system?: typeof forSystem;
}) {
  const system = options.system ?? forSystem;
  if (options.config.enabled) queue.handleSystem('demo.expire', async () => {
    const rows = await system((tx) => tx.select({ id: gyms.id, settings: gyms.settings }).from(gyms));
    for (const gym of rows) {
      const marker = (gym.settings as { bootstrapOwnerEmail?: unknown }).bootstrapOwnerEmail;
      if (sandboxSettings(gym.settings) || (typeof marker === 'string' && /^demo-reservation\.[0-9a-f-]{36}@example[.]invalid$/.test(marker)))
        await options.service.expire(gym.id);
    }
  });
  return { async scheduleDue() {
    if (options.config.enabled) await queue.enqueueSystem('demo.expire', {}, { timezone: 'UTC',
      idempotencyKey: String(Math.floor(options.clock.now().getTime() / 300_000)), maxAttempts: 5 });
  } };
}
// Runtime opts into install cleanup explicitly; normal gyms get no demo cron jobs.
export const jobs: readonly JobRegistration[] = [];
