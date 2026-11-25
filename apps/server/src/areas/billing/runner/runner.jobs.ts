// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../../core/registry.js';
import { z } from 'zod';
import { dateSchema, instantSchema, idSchema } from '@plaingym/shared/contracts';
import { chargeFailuresJob, dailyRunJob, retryJob, type ChargeRunner } from './index.js';
import { gymSettingsAccessor } from '../../settings/settings.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import { checkoutNeedsReview, notConfigured } from './reconciliation.js';
import { restoreCheckLease, RestoreCheckBusyError, type RestoreCheckLease } from '../../health/restore.billing-lease.js';
import { StripeTestModeSwitched } from '../stripe-writes.js';

let configured: ChargeRunner | undefined;
export function configureChargeRunner(runner: ChargeRunner) { configured = runner; }
/** Used by go-live's explicit rerun; resolves the same runner configured for the worker. */
export async function rerunRestoreReconciliation(gymId: string, snapshotAt: Date, restoreId: string) {
  if (!configured) throw new Error('Charge runner is not configured');
  return configured.postRestore(gymId, snapshotAt, restoreId);
}
export function createRunnerJobs(read: () => ChargeRunner | undefined = () => configured,
  settings: GymSettingsAccessor = gymSettingsAccessor, lease: RestoreCheckLease = restoreCheckLease): readonly JobRegistration[] {
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
      const unresolved = result?.issues.filter(issue => issue.reason !== notConfigured && !checkoutNeedsReview(issue)) ?? [];
      const sources = [
        ...(unresolved.some(issue => issue.kind === 'charge') ? ['payment_attempts'] : []),
        ...(unresolved.some(issue => issue.kind === 'checkout_debit') ? ['Checkout bank debits'] : []),
      ];
      if (sources.length) throw new Error(`${sources.join(' and ')} remain unresolved`);
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
      const snapshotAt = instantSchema.parse((payload as { snapshotAt?: unknown } | null)?.snapshotAt);
      const restoreId = idSchema.optional().parse((payload as { restoreId?: unknown } | null)?.restoreId);
      const after = z.string().min(1).max(200).optional().parse((payload as { after?: unknown } | null)?.after);
      // A follow-up for a busy check, or a retry of the original job (an earlier attempt may have written a clear report
      // before the queue reclaimed it), decides under the lease whether it still needs to run: see `followUpRestore`.
      const decides = after !== undefined || context.attempt > 1;
      const result = await lease(context.gymId, () => decides
        ? required().followUpRestore(context.gymId, new Date(snapshotAt), restoreId)
        : required().postRestore(context.gymId, new Date(snapshotAt), restoreId)).catch(error => {
        if (error instanceof RestoreCheckBusyError || (error instanceof StripeTestModeSwitched && decides)) return 'busy' as const;
        throw error;
      });
      if (result === 'busy') {
        // The holder may end without a usable result (a failed rerun, or this job's own reclaimed earlier attempt), and a
        // follow-up or retry stopped by a Stripe switch wrote no report, so either queues one follow-up check a minute
        // later instead of spending this job's attempts.
        await required().queueRestoreCheck(context.gymId, context.timezone,
          { snapshotAt, ...(restoreId ? { restoreId } : {}), after: context.jobId }, new Date(context.clock.now().getTime() + 60_000), context.attempt);
        return;
      }
      if (!result) return; // A follow-up or retry with nothing left to check.
      if (result.superseded) return; // A delayed job for a restore that is no longer the latest.
      // Without Stripe a retry would find the same stored references; the report lists them for the owner, who connects
      // Stripe and checks again. A check that ran with Stripe and left issues retries.
      if (!result.readyForOwnerReview && result.stripeConfigured !== false)
        throw new Error('Restore reconciliation requires manual resolution');
    } },
  ];
}
export const jobs = createRunnerJobs();
