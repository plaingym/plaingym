// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, households, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { runInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { CustomerCreationInProgress, FakePayments } from '../../infra/payments/index.js';
import { createCustomersService, CustomerUnavailable } from './customers.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-26T12:00:00Z');
  await factory('gyms', gymId);
  const household = await factory('households', gymId, { name: 'New Family', email: 'payer@example.invalid' });
  const provider = new FakePayments(gymId, clock), paymentsFor = vi.fn(async () => provider);
  const options = { scope: db.forGym, clock, paymentsFor };
  const service = createCustomersService(options);
  const read = () => db.forGym(gymId, async tx => ({
    household: (await tx.select().from(households).where(eq(households.id, household.id)))[0]!,
    audits: await tx.select().from(auditEvents),
  }));
  return { gymId, clock, household, provider, paymentsFor, options, service, read };
}

describe('household Stripe customer reservations with PostgreSQL', () => {
  it('links and audits once without putting payer details into the audit log', async () => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCustomer');
    const id = await f.service.ensureCustomer(f.gymId, f.household.id);
    expect(create).toHaveBeenCalledExactlyOnceWith({ email: f.household.email, name: f.household.name,
      householdId: f.household.id, idempotencyKey: `household:${f.household.id}:customer` });
    const saved = await f.read();
    expect(saved.household).toMatchObject({ stripeCustomerId: id, revision: f.household.revision });
    expect(saved.audits.map(a => a.action).sort()).toEqual(['billing.customer.creation_reserved', 'billing.customer.linked']);
    expect(saved.audits.every(a => a.occurredAt.getTime() === f.clock.now().getTime())).toBe(true);
    expect(JSON.stringify(saved.audits)).not.toContain(f.household.email!);
    expect(JSON.stringify(saved.audits)).not.toContain(f.household.name);
    f.clock.advance(48 * 60 * 60 * 1000);
    expect(await f.service.ensureCustomer(f.gymId, f.household.id)).toBe(id);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('preserves imported IDs even with no email or configured provider', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(households).set({ stripeCustomerId: 'cus_imported', email: null }).where(eq(households.id, f.household.id)));
    f.paymentsFor.mockRejectedValue(new Error('Stripe not configured'));
    expect(await f.service.ensureCustomer(f.gymId, f.household.id)).toBe('cus_imported');
    expect(f.paymentsFor).not.toHaveBeenCalled();
    expect((await f.read()).audits).toHaveLength(0);
  });
  it('shares one reservation and one provider customer across independent concurrent openers', async () => {
    const f = await fixture(), original = f.provider.createCustomer.bind(f.provider);
    let release!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    vi.spyOn(f.provider, 'createCustomer').mockImplementation(async request => {
      if (++calls === 2) release();
      await both;
      return original(request);
    });
    const ids = await Promise.all([f.service, createCustomersService(f.options)].map(s => s.ensureCustomer(f.gymId, f.household.id)));
    expect(ids[0]).toBe(ids[1]);
    expect(await f.provider.findCustomerByEmail(f.household.email!)).toHaveLength(1);
    expect((await f.read()).audits).toHaveLength(2);
  });
  it('recovers a lost creation response on restart inside the reserved window', async () => {
    const f = await fixture(); f.provider.loseNextResponse('createCustomer');
    await expect(f.service.ensureCustomer(f.gymId, f.household.id)).rejects.toThrow('response lost');
    expect((await f.read()).household.stripeCustomerId).toBeNull();
    f.clock.advance(22 * 60 * 60 * 1000);
    const id = await createCustomersService(f.options).ensureCustomer(f.gymId, f.household.id);
    expect(await f.provider.findCustomerByEmail(f.household.email!)).toEqual([{ id, email: f.household.email }]);
  });
  it.each([23, 25])('refuses an unresolved response at %s hours without another provider call', async hours => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCustomer');
    f.provider.loseNextResponse('createCustomer');
    await expect(f.service.ensureCustomer(f.gymId, f.household.id)).rejects.toThrow();
    f.clock.advance(hours * 60 * 60 * 1000);
    await expect(createCustomersService(f.options).ensureCustomer(f.gymId, f.household.id)).rejects.toMatchObject({ code: 'unavailable' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await f.provider.findCustomerByEmail(f.household.email!)).toHaveLength(1);
    expect((await f.read()).household.stripeCustomerId).toBeNull();
  });
  it('recovers a database failure after creation without duplicating the customer', async () => {
    const f = await fixture(); let calls = 0;
    const service = createCustomersService({ ...f.options, scope: (gymId, fn) => {
      if (++calls === 3) throw new Error('Connection lost before save');
      return db.forGym(gymId, fn);
    } });
    await expect(service.ensureCustomer(f.gymId, f.household.id)).rejects.toThrow('before save');
    const id = await createCustomersService(f.options).ensureCustomer(f.gymId, f.household.id);
    expect(await f.provider.findCustomerByEmail(f.household.email!)).toEqual([{ id, email: f.household.email }]);
    expect((await f.read()).audits).toHaveLength(2);
  });
  it('starts the reservation after a delayed provider resolver, not before it', async () => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCustomer');
    f.paymentsFor.mockImplementation(async () => { f.clock.advance(25 * 60 * 60 * 1000); return f.provider; });
    await expect(f.service.ensureCustomer(f.gymId, f.household.id)).resolves.toMatch(/^cus_/);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await f.read()).audits.find(a => a.action === 'billing.customer.creation_reserved')!.occurredAt).toEqual(f.clock.now());
  });
  it('still refuses an existing reservation that expires during provider resolution', async () => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCustomer');
    f.provider.loseNextResponse('createCustomer');
    await expect(f.service.ensureCustomer(f.gymId, f.household.id)).rejects.toThrow();
    f.paymentsFor.mockImplementation(async () => { f.clock.advance(25 * 60 * 60 * 1000); return f.provider; });
    await expect(f.service.ensureCustomer(f.gymId, f.household.id)).rejects.toMatchObject({ code: 'unavailable', reason: 'creation_expired' });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('recovers after provider configuration fails for more than a day without an abandoned reservation', async () => {
    const f = await fixture(), cause = new Error('Stripe configuration unavailable');
    f.paymentsFor.mockRejectedValueOnce(cause);
    await expect(f.service.ensureCustomer(f.gymId, f.household.id)).rejects.toMatchObject({ code: 'unavailable', reason: 'stripe_not_configured', cause });
    expect((await f.read()).audits).toHaveLength(0);
    f.clock.advance(25 * 60 * 60 * 1000);
    await expect(f.service.ensureCustomer(f.gymId, f.household.id)).resolves.toMatch(/^cus_/);
    expect((await f.read()).audits.filter(a => a.action === 'billing.customer.creation_reserved')).toHaveLength(1);
    expect(await f.provider.findCustomerByEmail(f.household.email!)).toHaveLength(1);
  });
  it.each([{ name: '' }, { name: '  \t ' }, { email: null }])('does not reserve missing details: %j', async changes => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(households).set(changes).where(eq(households.id, f.household.id)));
    await expect(f.service.ensureCustomer(f.gymId, f.household.id)).rejects.toMatchObject({ code: 'unavailable', reason: 'missing_details' });
    expect(f.paymentsFor).not.toHaveBeenCalled();
    expect((await f.read()).audits).toHaveLength(0);
  });
  it.each(['linked', 'invalid'] as const)('rechecks household details after provider resolution: %s', async change => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCustomer');
    f.paymentsFor.mockImplementation(async () => {
      await db.forGym(f.gymId, tx => tx.update(households).set(change === 'linked' ? { stripeCustomerId: 'cus_imported' } : { name: ' ' }).where(eq(households.id, f.household.id)));
      return f.provider;
    });
    const result = f.service.ensureCustomer(f.gymId, f.household.id);
    if (change === 'linked') await expect(result).resolves.toBe('cus_imported');
    else await expect(result).rejects.toBeInstanceOf(CustomerUnavailable);
    expect(create).not.toHaveBeenCalled();
    expect((await f.read()).audits).toHaveLength(0);
  });
  it('retries a real in-flight fake conflict so both openers receive the same customer', async () => {
    const f = await fixture(), original = f.provider.createCustomer.bind(f.provider);
    let release!: () => void;
    f.provider.holdNextCustomerCreation(new Promise<void>(resolve => { release = resolve; }));
    const conflicts: unknown[] = [];
    vi.spyOn(f.provider, 'createCustomer').mockImplementation(async request => {
      try { return await original(request); }
      catch (error) { conflicts.push(error); release(); throw error; }
    });
    const ids = await Promise.all([f.service, createCustomersService(f.options)].map(service => service.ensureCustomer(f.gymId, f.household.id)));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toBeInstanceOf(CustomerCreationInProgress);
    expect(ids[0]).toBe(ids[1]);
    expect(await f.provider.findCustomerByEmail(f.household.email!)).toHaveLength(1);
    expect((await f.read()).audits).toHaveLength(2);
  });
  it('bounds conflict retries to three short backoffs and never retries other provider errors', async () => {
    const f = await fixture(), conflict = new CustomerCreationInProgress();
    const create = vi.spyOn(f.provider, 'createCustomer').mockRejectedValue(conflict);
    const sleep = vi.fn(async (ms: number) => { f.clock.advance(ms); });
    const service = createCustomersService({ ...f.options, sleep });
    await expect(service.ensureCustomer(f.gymId, f.household.id)).rejects.toBe(conflict);
    expect(create).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[100], [250], [500]]);
    const error = Object.assign(new Error('Invalid request'), { statusCode: 400, type: 'StripeInvalidRequestError' });
    create.mockClear().mockRejectedValue(error); sleep.mockClear();
    await expect(service.ensureCustomer(f.gymId, f.household.id)).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect((await f.read()).audits).toHaveLength(1);
  });
  it('does not retry past the reservation boundary or after a slow conflict response', async () => {
    for (const nearExpiry of [true, false]) {
      const f = await fixture(); f.provider.loseNextResponse('createCustomer');
      await expect(f.service.ensureCustomer(f.gymId, f.household.id)).rejects.toThrow();
      if (nearExpiry) f.clock.advance(23 * 60 * 60 * 1000 - 50);
      const conflict = new CustomerCreationInProgress(), create = vi.spyOn(f.provider, 'createCustomer').mockImplementation(async () => {
        if (!nearExpiry) f.clock.advance(3000);
        throw conflict;
      });
      const sleep = vi.fn(async () => {}), service = createCustomersService({ ...f.options, sleep });
      if (nearExpiry) await expect(service.ensureCustomer(f.gymId, f.household.id)).rejects.toMatchObject({ reason: 'creation_expired' });
      else await expect(service.ensureCustomer(f.gymId, f.household.id)).rejects.toBe(conflict);
      expect(create).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });
  it.each(['name', 'email'] as const)('refuses changed %s after an uncertain call', async field => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCustomer');
    f.provider.loseNextResponse('createCustomer');
    await expect(f.service.ensureCustomer(f.gymId, f.household.id)).rejects.toThrow();
    await db.forGym(f.gymId, tx => tx.update(households).set({ [field]: field === 'email' ? 'other@example.invalid' : 'Other Family' }).where(eq(households.id, f.household.id)));
    await expect(f.service.ensureCustomer(f.gymId, f.household.id)).rejects.toMatchObject({ code: 'unavailable' });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('keeps an ID linked by an import while creation was in flight', async () => {
    const f = await fixture(), original = f.provider.createCustomer.bind(f.provider);
    vi.spyOn(f.provider, 'createCustomer').mockImplementation(async request => {
      const customer = await original(request);
      await db.forGym(f.gymId, tx => tx.update(households).set({ stripeCustomerId: 'cus_imported' }).where(eq(households.id, f.household.id)));
      return customer;
    });
    expect(await f.service.ensureCustomer(f.gymId, f.household.id)).toBe('cus_imported');
    expect((await f.read()).household.stripeCustomerId).toBe('cus_imported');
  });
  it('does not create or link a customer through another gym', async () => {
    const f = await fixture(), gymB = uuidv7(); await factory('gyms', gymB);
    await expect(f.service.ensureCustomer(gymB, f.household.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(f.paymentsFor).not.toHaveBeenCalled();
    expect((await f.read()).household.stripeCustomerId).toBeNull();
  });
  it('requires an email and rejects provider calls inside a transaction', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(households).set({ email: null }).where(eq(households.id, f.household.id)));
    await expect(f.service.ensureCustomer(f.gymId, f.household.id)).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.paymentsFor).not.toHaveBeenCalled();
    await runInTransaction(async () => {
      await expect(f.provider.createCustomer({ email: 'payer@example.invalid', name: 'Family', householdId: f.household.id, idempotencyKey: 'test' })).rejects.toThrow('transaction');
    });
  });
});
