// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../../core/registry.js';
import { instantSchema, idSchema } from '@plaingym/shared/contracts';
import type { ChargeRunner } from './index.js';
import { gymSettingsAccessor } from '../../settings/settings.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';

let configured: ChargeRunner | undefined;
export function configureChargeRunner(runner: ChargeRunner) { configured = runner; }
export function createRunnerJobs(read: () => ChargeRunner | undefined = () => configured,
  settings: GymSettingsAccessor = gymSettingsAccessor): readonly JobRegistration[] {
  const required = () => { const runner = read(); if (!runner) throw new Error('Charge runner is not configured'); return runner; };
  async function scheduled(gymId: string) {
    const runner = read();
    if (!runner && (await settings.get(gymId)).billingEnabled) throw new Error('Charge runner is not configured');
    return runner;
  }
  return [
    { id: 'billing.runner.daily', cron: '0 9 * * *', async handler(_payload, context) {
      const result = await (await scheduled(context.gymId))?.daily(context.gymId);
      if (result?.errors.length) throw new Error('Some invoice charges need reconciliation');
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
        new Date(instantSchema.parse((payload as { snapshotAt?: unknown } | null)?.snapshotAt)));
      if (!result.readyForOwnerReview) throw new Error('Restore reconciliation requires manual resolution');
    } },
  ];
}
export const jobs = createRunnerJobs();
