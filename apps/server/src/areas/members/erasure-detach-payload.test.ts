// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { households, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { detachJob } from '../billing/payments.mutations.js';
import { createMembersService } from './members.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymId = uuidv7(), clock = new TestClock('2026-11-23T12:00:00Z');
const service = createMembersService({ scope: database.forGym, clock });
beforeAll(async () => { await factory('gyms', gymId); });

async function fixture(customerId: string | null, members = 1) {
  const home = await factory('households', gymId, { stripeCustomerId: customerId });
  const people = [];
  for (let index = 0; index < members; index++) people.push(await factory('members', gymId, { householdId: home.id }));
  const card = await factory('paymentMethods', gymId, { householdId: home.id, type: 'acss_debit', isDefault: true });
  return { home, person: people[0]!, card };
}
async function erase(personId: string) {
  const jobs = new FakeJobs(clock);
  await service.eraseMember({ gymId, actor: { kind: 'system' } }, personId, { revision: 1 }, { jobs, timezone: 'UTC' });
  return jobs.jobs.filter(job => job.name === detachJob);
}

describe('the detach job a last-member erasure queues', () => {
  it('carries the customer ID the erasure cleared from the household', async () => {
    const { home, person, card } = await fixture('cus_csv');
    const detaches = await erase(person.id);
    expect(detaches).toHaveLength(1);
    expect(detaches[0]!.payload).toEqual({ paymentMethodId: card.id, redactBillingDetails: true, customerId: 'cus_csv' });
    expect(detaches[0]!.options).toMatchObject({ idempotencyKey: `detach:${card.id}`, maxAttempts: 12 });
    expect(detaches[0]!.runAt).toEqual(new Date(clock.now().getTime() + 60_000));
    const [stored] = await database.forGym(gymId, tx => tx.select().from(households).where(eq(households.id, home.id)));
    expect(stored!.stripeCustomerId).toBeNull();
  });

  it('carries no customer ID when the household had none', async () => {
    const { person, card } = await fixture(null);
    const detaches = await erase(person.id);
    expect(detaches).toHaveLength(1);
    expect(detaches[0]!.payload).toEqual({ paymentMethodId: card.id, redactBillingDetails: true });
    expect(detaches[0]!.payload).not.toHaveProperty('customerId');
    expect(detaches[0]!.options).toMatchObject({ idempotencyKey: `detach:${card.id}` });
  });

  it('queues no detach when another member of the household remains', async () => {
    const { person } = await fixture('cus_csv', 2);
    expect(await erase(person.id)).toEqual([]);
  });
});
