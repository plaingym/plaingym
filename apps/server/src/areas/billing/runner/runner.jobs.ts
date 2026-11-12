// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../../core/registry.js';
import { z } from 'zod';
import { dateSchema, instantSchema, idSchema } from '@plaingym/shared/contracts';
import { chargeFailuresJob, dailyRunJob, retryJob, type ChargeRunner } from './index.js';
import { gymSettingsAccessor } from '../../settings/settings.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';

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
    // Also runs a stopped collection's continuation, whose payload names the day it continues. In the batch lane, so
    // webhook dispatch and transition effects never wait behind a collection.
    { id: dailyRunJob, cron: '0 9 * * *', lane: 'batch', async handler(payload, context) {
      const { continues } = z.object({ continues: dateSchema.optional() }).parse(payload);
      // The queue's job IDs key a stopped run's failure report, so a replayed run keeps one.
      const runId = idSchema.safeParse(context.jobId).data;
      const result = await (await scheduled(context.gymId))?.daily(context.gymId,
        { ...(continues ? { continues } : {}), ...(runId ? { runId } : {}) });
      // A stopped collection queued its continuation; failing would rerun it into the same outage at once.
      if (result?.errors.length && !result.stopped) throw new Error('Some invoice charges need reconciliation');
    } },
    { id: 'billing.runner.reconcile', cron: '17 * * * *', async handler(_payload, context) {
      const result = await (await scheduled(context.gymId))?.reconcile(context.gymId);
      if (result?.issues.length) throw new Error('Payment attempts remain unresolved');
    } },
    // Queued by the previous release for a stopped run's other failures: it records them as that run's report.
    { id: chargeFailuresJob, async handler(payload, context) {
      const { day, invoiceIds } = z.object({ day: dateSchema, invoiceIds: z.array(idSchema).min(1) }).parse(payload);
      await required().reportFailures(context.gymId, context.jobId, day,
        invoiceIds.map(invoiceId => ({ invoiceId, cause: 'unexpected' as const })));
    } },
    { id: retryJob, async handler(payload, context) {
      const { invoiceId, owner } = z.object({ invoiceId: idSchema, owner: z.string().min(1).optional() }).parse(payload);
      await required().retry(invoiceId, context, owner);
    } },
    { id: 'billing.runner.restore', async handler(payload, context) {
      const result = await required().postRestore(context.gymId,
        new Date(instantSchema.parse((payload as { snapshotAt?: unknown } | null)?.snapshotAt)),
        idSchema.optional().parse((payload as { restoreId?: unknown } | null)?.restoreId));
      // Without Stripe a retry would find the same stored references; the report lists them for the owner, who connects
      // Stripe and checks again. A check that ran with Stripe and left issues retries.
      if (!result.readyForOwnerReview && result.stripeConfigured !== false)
        throw new Error('Restore reconciliation requires manual resolution');
    } },
  ];
}
export const jobs = createRunnerJobs();
