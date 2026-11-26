// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- One test holds the gym row and reads backend PIDs to verify the revoke waits for it.
import { eq, sql } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- One test locks the gym row the way a settings save does.
import { auditEvents, gyms, households, paymentMethods, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { revokeBankMethod } from './bank.js';

// A failed debit's revoke takes the gym settings before the household, the order every other default change uses.
const db = useTestDatabase(), factory = createFactories(db);

describe('bank revoke lock order', () => {
  it('waits for a transaction holding the gym row before it locks the household, then revokes and promotes', async () => {
    const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
    await factory('gyms', gymId, { currency: 'USD', billingEnabled: true });
    const household = await factory('households', gymId, { stripeCustomerId: 'cus_fixture' });
    const invoice = await factory('invoices', gymId, { householdId: household.id, currency: 'USD', status: 'open', kind: 'cycle',
      number: 1, periodStartsOn: '2026-10-01', periodEndsOn: '2026-11-01' });
    const bank = await factory('paymentMethods', gymId, { householdId: household.id, processorId: 'pm_bank', type: 'us_bank_account',
      brand: null, last4: '6789', isDefault: true, processorCreatedAt: new Date('2026-10-20T00:00:00Z') });
    const card = await factory('paymentMethods', gymId, { householdId: household.id, processorId: 'pm_card',
      expiryMonth: 12, expiryYear: 2035, processorCreatedAt: new Date('2026-10-10T00:00:00Z') });

    // The test database allows two app connections (the holder and the revoke), so the holder itself takes the
    // household row `nowait` once the revoke waits: it succeeds only if the waiting revoke holds no household lock.
    const locked = Promise.withResolvers<number>(), check = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let householdLock: Promise<unknown> | undefined;
    const holder = db.forGym(gymId, async tx => {
      // eslint-disable-next-line database/system-tables -- The holder's backend PID, for the lock-wait probe.
      const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
      await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, gymId)).for('update');
      locked.resolve(pid);
      await check.promise;
      householdLock = tx.select({ id: households.id }).from(households)
        .where(eq(households.id, household.id)).for('update', { noWait: true }).then(rows => rows, (error: unknown) => error);
      await householdLock;
      await release.promise;
    });
    const pid = await locked.promise;
    let finished = false;
    const revoking = db.forGym(gymId, tx => revokeBankMethod(tx, { gymId, actor: { kind: 'system' } }, clock, invoice, 'pm_bank'))
      .finally(() => { finished = true; });
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
      expect(await householdLock).toEqual([{ id: household.id }]);
      expect(finished).toBe(false);
    } finally {
      check.resolve();
      release.resolve();
    }
    await Promise.all([holder, revoking]);

    const rows = await db.forGym(gymId, async tx => ({
      methods: await tx.select().from(paymentMethods), audits: await tx.select().from(auditEvents) }));
    expect(rows.methods.find(row => row.id === bank.id)).toMatchObject({ isDefault: false, revokedAt: clock.now() });
    expect(rows.methods.find(row => row.id === card.id)).toMatchObject({ isDefault: true, revokedAt: null });
    expect(rows.audits.map(row => [row.action, row.targetId])).toEqual(expect.arrayContaining([
      ['billing.payment_method.revoked', bank.id], ['billing.card.default_changed', card.id]]));
  });
});
