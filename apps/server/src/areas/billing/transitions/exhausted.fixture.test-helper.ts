// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Isolated test queue rows simulate retention and inspect atomic retry.
import { jobs } from '@plaingym/db';
import { PostgresJobs } from '../../../infra/jobs/index.js';
import { createMembershipService } from '../memberships.js';
import { useRunnerFixture } from '../runner/runner.fixture.test-helper.js';
import { createTransitionEffects, effectJob, effectRecoveryExhausted } from './effects.js';
import { effectCreated, effectPublished, type TransitionEffect } from './store.js';

export function useExhaustedFixture() {
  const { db, factory, fixture: runner, invoice } = useRunnerFixture();
  async function fixture() {
    const f = await runner({ timezone: 'UTC' }), bill = await invoice(f), user = await factory('authUser', f.gymId);
    const queue = new PostgresJobs({ database: db, clock: f.clock });
    const notifications = { receipt: vi.fn(async () => {}), dunning: vi.fn(async () => {}), staffNotice: vi.fn(async () => {}) };
    const options = { ...f.serviceOptions, jobs: queue, recovery: queue, transitions: f.transitions,
      memberships: createMembershipService(f.serviceOptions), payments: async () => f.provider, notifications, retry: vi.fn(async () => {}) };
    const effects = createTransitionEffects(options);
    queue.handle(effectJob, (payload, context) => effects.run((payload as { effectId: string }).effectId, context));
    const context = { gymId: f.gymId, actor: { kind: 'user' as const, userId: user.id } };
    const audit = (action: string, id: string, after: unknown = {}) => factory('auditEvents', f.gymId,
      { action, targetType: 'invoice_effect', targetId: id, after, occurredAt: f.clock.now() });
    const create = async (kind: TransitionEffect['kind'] = 'receipt', extra: Partial<TransitionEffect> = {}, exhausted = true) => {
      const id = uuidv7(), work = { invoiceId: bill.id, kind, ...extra };
      await audit(effectCreated, id, work); await audit(effectPublished, id);
      const queued = await queue.enqueue(effectJob, { effectId: id }, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: id, maxAttempts: 1 });
      // Represent a retained job that has used up all its queue attempts, without spending twelve attempts in every route test.
      await db.forGym(f.gymId, tx => tx.update(jobs).set({ status: 'failed', attempts: 1, runAt: f.clock.now() }).where(eq(jobs.id, queued.jobId)));
      if (exhausted) await audit(effectRecoveryExhausted, id, { ...work, resets: 5, jobId: queued.jobId });
      return id;
    };
    const rows = () => db.forGym(f.gymId, tx => tx.select().from(jobs).where(eq(jobs.name, effectJob)));
    const removeJobs = () => db.forGym(f.gymId, tx => tx.delete(jobs));
    const audits = (action: string, id: string) => db.forGym(f.gymId, tx => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, id))));
    const drain = async () => { for (let n = 0; n < 20; n++) if (!await queue.runNext()) return; throw new Error('Queue did not drain'); };
    return { ...f, jobContext: f.context, bill, user, queue, options, effects, context, audit, create, rows, removeJobs, audits, drain };
  }
  return { db, factory, fixture };
}
