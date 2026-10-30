// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../../core/registry.js';
import { z } from 'zod';
import { dateSchema, instantSchema, idSchema } from '@plaingym/shared/contracts';
import { dailyRunJob, type ChargeRunner } from './index.js';
import { gymSettingsAccessor } from '../../settings/settings.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';

/** Runs in the jobs batch lane, so webhook dispatch and transition effects never wait behind a collection. */
export const runnerBatchJobs = [dailyRunJob] as const;
let configured: ChargeRunner | undefined;
export function configureChargeRunner(runner: ChargeRunner) { configured = runner; }
/** Used by go-live's explicit rerun; resolves the same runner configured for the worker. */
export async function rerunRestoreReconciliation(gymId: string, snapshotAt: Date, restoreId: string) {
  if (!configured) throw new Error('Charge runner is not configured');
  return configured.postRestore(gymId, snapshotAt, restoreId);
}
export function createRunnerJobs(read: () => ChargeRunner | undefined = () => configured,
  settings: GymSettingsAccessor = gymSettingsAccessor): readonly JobRegistration[] {
  const required = () => { const runner = read(); if (!runner) throw new Error('Charge runner is not configured'); return runner; };
  async function scheduled(gymId: string) {
    const runner = read();
    if (!runner && (await settings.get(gymId)).billingEnabled) throw new Error('Charge runner is not configured');
    return runner;
  }
  return [
    // Also runs a stopped collection's continuation, whose payload names the day it continues.
    { id: dailyRunJob, cron: '0 9 * * *', async handler(payload, context) {
      const { continues } = z.object({ continues: dateSchema.optional() }).parse(payload);
      const result = await (await scheduled(context.gymId))?.daily(context.gymId, continues ? { continues } : {});
      // A stopped collection queued its continuation; failing would rerun it into the same outage at once.
      if (result?.errors.length && !result.stopped) throw new Error('Some invoice charges need reconciliation');
    } },
    { id: 'billing.runner.reconcile', cron: '17 * * * *', async handler(_payload, context) {
      const result = await (await scheduled(context.gymId))?.reconcile(context.gymId);
      if (result?.issues.length) throw new Error('Payment attempts remain unresolved');
    } },
    { id: 'billing.runner.retry', async handler(payload, context) {
      await required().retry(idSchema.parse((payload as { invoiceId?: unknown } | null)?.invoiceId), context);
    } },
    { id: 'billing.runner.restore', async handler(payload, context) {
      const result = await required().postRestore(context.gymId,
        new Date(instantSchema.parse((payload as { snapshotAt?: unknown } | null)?.snapshotAt)),
        idSchema.optional().parse((payload as { restoreId?: unknown } | null)?.restoreId));
      if (!result.readyForOwnerReview) throw new Error('Restore reconciliation requires manual resolution');
    } },
  ];
}
export const jobs = createRunnerJobs();
