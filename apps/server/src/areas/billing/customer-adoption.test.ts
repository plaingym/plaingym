// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { customerAdoptedAction, recordCustomerAdoption } from './customer-adoption.js';

const db = useTestDatabase(), factory = createFactories(db);

async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-11-25T12:00:00Z');
  await factory('gyms', gymId);
  const home = await factory('households', gymId);
  const write = (customerId: string, source = 'test') => (tx: Transaction) => writeAudit(tx, {
    gymId, actorKind: 'system', action: customerAdoptedAction, targetType: 'household', targetId: home.id,
    after: { customerId, source }, occurredAt: clock.now(),
  });
  const audits = () => db.forGym(gymId, tx => tx.select().from(auditEvents)
    .where(eq(auditEvents.action, customerAdoptedAction)));
  return { gymId, clock, home, write, audits };
}

describe('recordCustomerAdoption', () => {
  it('writes one audit per household and customer, and writes another for a different customer', async () => {
    const f = await fixture();
    expect(await recordCustomerAdoption(db.forGym, f.gymId, f.home.id, 'cus_one', f.write('cus_one'))).toBe(true);
    expect(await f.audits()).toHaveLength(1);

    expect(await recordCustomerAdoption(db.forGym, f.gymId, f.home.id, 'cus_one', f.write('cus_one'))).toBe(false);
    expect(await f.audits()).toHaveLength(1);

    expect(await recordCustomerAdoption(db.forGym, f.gymId, f.home.id, 'cus_two', f.write('cus_two'))).toBe(true);
    const rows = await f.audits();
    expect(rows).toHaveLength(2);
    expect(rows.map(row => (row.after as { customerId: string }).customerId).sort()).toEqual(['cus_one', 'cus_two']);
  });

  it('writes one audit across concurrent calls for the same household and customer', async () => {
    const f = await fixture();
    const results = await Promise.all([
      recordCustomerAdoption(db.forGym, f.gymId, f.home.id, 'cus_race', f.write('cus_race', 'first')),
      recordCustomerAdoption(db.forGym, f.gymId, f.home.id, 'cus_race', f.write('cus_race', 'second')),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await f.audits()).toHaveLength(1);
  });

  it('retries once when the first transaction fails, and rereads so a lost commit never writes twice', async () => {
    const f = await fixture();
    let calls = 0;
    const flakyScope: typeof db.forGym = (gymId, fn) => {
      if (++calls === 1) return Promise.reject(new Error('transient db error'));
      return db.forGym(gymId, fn);
    };
    expect(await recordCustomerAdoption(flakyScope, f.gymId, f.home.id, 'cus_retry', f.write('cus_retry'))).toBe(true);
    expect(calls).toBe(2);
    expect(await f.audits()).toHaveLength(1);

    // If the first transaction committed and its reply was lost, the retry sees the audit and writes nothing.
    let lostCalls = 0;
    const lostReplyScope: typeof db.forGym = async (gymId, fn) => {
      if (++lostCalls === 1) {
        await db.forGym(gymId, fn);
        throw new Error('reply lost after commit');
      }
      return db.forGym(gymId, fn);
    };
    const write = vi.fn(f.write('cus_lost'));
    expect(await recordCustomerAdoption(lostReplyScope, f.gymId, f.home.id, 'cus_lost', write)).toBe(false);
    expect(lostCalls).toBe(2);
    expect(write).toHaveBeenCalledOnce();
    const afterLost = (await f.audits()).filter(row => (row.after as { customerId: string }).customerId === 'cus_lost');
    expect(afterLost).toHaveLength(1);
  });

  it('rejects with the second error and writes nothing when both attempts fail', async () => {
    const f = await fixture();
    const firstError = new Error('first db error'), secondError = new Error('second db error');
    let calls = 0;
    const failingScope: typeof db.forGym = () => Promise.reject(++calls === 1 ? firstError : secondError);
    await expect(recordCustomerAdoption(failingScope, f.gymId, f.home.id, 'cus_fail', f.write('cus_fail')))
      .rejects.toBe(secondError);
    expect(calls).toBe(2);
    expect(await f.audits()).toHaveLength(0);
  });
});
