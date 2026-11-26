// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- The tests hold the gym row and read backend PIDs to verify the handlers wait for it.
import { and, eq, sql } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The tests lock the gym row the way the Stripe key switch does.
import { auditEvents, gyms, households, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../../core/clock.js';
import type { Payments } from '../../../../infra/payments/index.js';
import { createCardHandlers } from './methods.js';

// Card handler transactions that lock a household hold the gym row first, as the Stripe key switch takes the gym
// before households.
const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency: 'USD', billingEnabled: true });
  const household = await factory('households', gymId, { stripeCustomerId: 'cus_lock', email: 'payer@example.invalid' });
  const handlers = createCardHandlers({ scope: db.forGym, clock });
  const audits = (action: string) => db.forGym(gymId, tx => tx.select().from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, household.id))));
  return { gymId, household, handlers, audits };
}

/** Runs `action` while another transaction holds the gym row `for update`, and checks it waits without the household. */
async function expectWaitsForGym(gymId: string, householdId: string, action: () => Promise<unknown>) {
  // The test database allows two app connections (the holder and the handler), so the holder itself takes the
  // household row `nowait` once the handler waits: it succeeds only if the waiting handler holds no household lock.
  const locked = Promise.withResolvers<number>(), check = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let householdLock: Promise<unknown> | undefined;
  const holder = db.forGym(gymId, async tx => {
    // eslint-disable-next-line database/system-tables -- The holder's backend PID, for the lock-wait probe.
    const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
    await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, gymId)).for('update');
    locked.resolve(pid);
    await check.promise;
    householdLock = tx.select({ id: households.id }).from(households)
      .where(eq(households.id, householdId)).for('update', { noWait: true }).then(rows => rows, (error: unknown) => error);
    await householdLock;
    await release.promise;
  });
  const pid = await locked.promise;
  let finished = false;
  const running = action().finally(() => { finished = true; });
  try {
    let sawWait = false;
    const deadline = Date.now() + 5000;
    while (!sawWait && !finished && Date.now() < deadline) {
      // eslint-disable-next-line database/system-tables -- The lock-wait probe.
      sawWait = (await db.system.db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`))[0]!.n > 0;
      if (!sawWait) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(sawWait).toBe(true);
    expect(finished).toBe(false);
    check.resolve();
    await expect.poll(() => householdLock).toBeDefined();
    expect(await householdLock).toEqual([{ id: householdId }]);
    expect(finished).toBe(false);
  } finally {
    check.resolve();
    release.resolve();
    // A failed check still ends both transactions before the next test, without an unhandled rejection.
    await Promise.allSettled([holder, running]);
  }
  const [, result] = await Promise.all([holder, running]);
  return result;
}

describe('card handler lock order', () => {
  it('records a finished deferred collection only after the gym row is released, and once', async () => {
    const f = await fixture(), action = 'billing.payment_method.deferred_collection_completed';
    const recorded = await expectWaitsForGym(f.gymId, f.household.id,
      () => f.handlers.markCollectionCompleted(f.gymId, 'cus_lock', 'pm_bank_lock', 'seti_lock'));
    expect(recorded).toBe(true);
    expect(await f.handlers.markCollectionCompleted(f.gymId, 'cus_lock', 'pm_bank_lock', 'seti_lock')).toBe(false);
    const rows = await f.audits(action);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toEqual({ paymentMethodId: 'pm_bank_lock', setupId: 'seti_lock' });
  });

  it('records an incomplete bank skip only after the gym row is released, and once', async () => {
    const f = await fixture(), action = 'billing.payment_method.incomplete_bank_skipped';
    const reads: string[] = [];
    const provider = {
      async readPaymentObject(reference: { kind: 'payment_method'; id: string }) {
        reads.push(reference.id);
        return { status: 'unknown', reference: { ...reference }, incompleteBankMethod: { customerId: 'cus_lock' } };
      },
    } as unknown as Payments;
    await expectWaitsForGym(f.gymId, f.household.id,
      () => f.handlers.collect(f.gymId, provider, 'cus_lock', 'pm_bank_lock', 'mandate_lock', 'seti_lock'));
    await f.handlers.collect(f.gymId, provider, 'cus_lock', 'pm_bank_lock', 'mandate_lock', 'seti_lock');
    const rows = await f.audits(action);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toEqual({ paymentMethodId: 'pm_bank_lock', mandateId: 'mandate_lock', setupId: 'seti_lock' });
    expect(reads).toEqual(Array(4).fill('pm_bank_lock'));
  });
});
