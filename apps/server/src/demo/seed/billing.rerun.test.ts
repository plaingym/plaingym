// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createCustomersService } from '../../areas/billing/customers.js';
import { fixture, snapshot as rowsOf } from './billing.fixture.test-helper.js';

const db = useTestDatabase();
const snapshot = (gymId: string) => rowsOf(db, gymId);

describe('demo billing seed reruns', { timeout: 90_000 }, () => {
  it('is unchanged on rerun even a month later and never changes another gym', async () => {
    const other = await fixture(db), f = await fixture(db);
    await other.seed.run(other.context); const otherBefore = await snapshot(other.gymId);
    await f.seed.run(f.context); const before = await snapshot(f.gymId);
    f.clock.advance(32 * 86_400_000); await f.seed.run(f.context);
    expect(await snapshot(f.gymId)).toEqual(before); expect(await snapshot(other.gymId)).toEqual(otherBefore);
    expect(f.gateway.createCustomer).toHaveBeenCalledTimes(14); expect(f.gateway.seedCard).toHaveBeenCalledTimes(14);
    const customer = createCustomersService({ scope: db.forGym, clock: f.clock, paymentsFor: async () => f.gateway.payments });
    await expect(customer.ensureCustomer(f.gymId, otherBefore.households[0]!.id)).rejects.toMatchObject({ code: 'not_found' });
    f.gateway.payments.seedCustomer({ id: 'cus_foreign', email: 'foreign@example.invalid', gymId: other.gymId });
    await expect(f.gateway.payments.adoptCustomer('cus_foreign')).rejects.toThrow(/another gym/);
  });
});
