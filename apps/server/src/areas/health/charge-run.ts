// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { auditEvents, forGym, uuidv7, writeAudit } from '@plaingym/db';
import { createTranslator, type Clock } from '@plaingym/shared';
import { chargeRunHealthDetailsSchema } from '@plaingym/shared/contracts';
import type { ChargeRunHealthDetails } from '@plaingym/shared/contracts';
import type { ChargeRunner } from '../billing/runner/index.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import messages from '../../../../../locales/en/health/charge-run.json' with { type: 'json' };
import { healthProvider } from './status.js';
import { logError } from '../../core/log.js';

const t = createTranslator({ 'health/charge-run': messages });
const started = 'billing.runner.run.started', completed = 'billing.runner.run.completed';
export interface ChargeRunOptions { scope?: typeof forGym; clock: Clock; settings: GymSettingsAccessor; }
/** Wrap the runner before composing its jobs. No payment calls occur inside the audit transactions. */
export function monitorChargeRunner(runner: ChargeRunner, options: ChargeRunOptions): ChargeRunner {
  const scope = options.scope ?? forGym;
  return { ...runner, async daily(gymId, run) {
    if (!(await options.settings.get(gymId)).billingEnabled) return runner.daily(gymId, run);
    const lastStartedAt = options.clock.now().toISOString(), runId = uuidv7(options.clock.now().getTime());
    const record = (details: ChargeRunHealthDetails) => scope(gymId, tx => writeAudit(tx, {
      gymId, actorKind: 'system', action: details.result === 'running' ? started : completed, targetType: 'charge_run', targetId: runId,
      after: details, occurredAt: options.clock.now(),
    }));
    await record({ lastStartedAt, lastCompletedAt: null, result: 'running', invoicesProcessed: 0, failures: 0 });
    let result: Awaited<ReturnType<ChargeRunner['daily']>>;
    try { result = await runner.daily(gymId, run); }
    catch (error) {
      try {
        await record({ lastStartedAt, lastCompletedAt: options.clock.now().toISOString(), result: 'failed', invoicesProcessed: 0, failures: 1 });
      } catch (recordError) {
        logError('billing.runner.failure_record_failed', { gymId, runId }, recordError);
      }
      throw error;
    }
    await record({ lastStartedAt, lastCompletedAt: options.clock.now().toISOString(),
      result: result.errors.length ? 'failed' : 'succeeded', invoicesProcessed: result.attempted, failures: result.errors.length });
    return result;
  } };
}
export function createChargeRunHealthProvider(options: Pick<ChargeRunOptions, 'scope' | 'settings'>) {
  const scope = options.scope ?? forGym;
  return healthProvider('last_charge_run', async context => {
    const checkedAt = context.clock.now().toISOString(), gym = await options.settings.get(context.gymId);
    const rows = await scope(context.gymId, tx => tx.select({ after: auditEvents.after }).from(auditEvents)
      .where(and(inArray(auditEvents.action, [started, completed]), eq(auditEvents.targetType, 'charge_run')))
      // Completion sorts before start even when the injected clock has not advanced.
      .orderBy(desc(auditEvents.targetId), asc(auditEvents.action)).limit(1));
    const details = rows.length ? chargeRunHealthDetailsSchema.parse(rows[0]!.after) : {
      lastStartedAt: null, lastCompletedAt: null, result: 'never_run' as const, invoicesProcessed: 0, failures: 0,
    };
    // A completed run older than 26 hours or a running run older than 2 hours needs attention.
    const stale = details.lastStartedAt !== null && context.clock.now().getTime() - Date.parse(details.lastStartedAt)
      > (details.result === 'running' ? 2 : 26) * 3_600_000;
    const state = !gym.billingEnabled ? 'disabled' : details.result === 'failed' ? 'failed' : stale ? 'stale' : details.result;
    return { id: 'last_charge_run', checkedAt, details,
      status: state === 'disabled' ? 'not_configured' : state === 'failed' ? 'error' : state === 'succeeded' ? 'healthy' : 'warning',
      message: t('health/charge-run:' + state) };
  });
}
