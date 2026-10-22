// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { Clock } from '@plaingym/shared';
import type { JobRegistration } from '../../core/registry.js';
import type { PostgresJobs } from '../../infra/jobs/postgres.js';
import { backupKindSchema } from './backups.format.js';
import type { BackupService } from './backups.js';

/** Install-wide schedules use explicit system jobs, never a gym registry entry. */
export const jobs: readonly JobRegistration[] = [];
export function registerBackupJobs(queue: PostgresJobs, backup: BackupService,
  clock: Clock, isRestoring: () => Promise<boolean> = async () => false) {
  const name = 'health.backup';
  queue.handleSystem(name, async (payload) => {
    if (await isRestoring()) throw new Error('Restore in progress');
    const { kind } = z.strictObject({ kind: backupKindSchema }).parse(payload);
    await backup.snapshot(kind);
  });
  return {
    /** Call once per worker poll. Durable idempotency keys collapse competing schedulers. */
    async scheduleDue(): Promise<void> {
      if (await isRestoring()) return;
      const now = clock.now(), hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
      // One snapshot satisfies coincident tiers. The retention planner also deduplicates their references.
      const kind = hour.getUTCHours() === 0 ? (hour.getUTCDay() === 0 ? 'weekly' : 'nightly') : 'hourly';
      await queue.enqueueSystem(name, { kind }, { timezone: 'UTC', runAt: hour,
        idempotencyKey: 'snapshot:' + hour.toISOString(), maxAttempts: 3 });
    },
  };
}
