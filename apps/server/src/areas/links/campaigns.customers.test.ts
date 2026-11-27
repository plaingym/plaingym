// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, households, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createTranslator } from '@plaingym/shared';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { createCustomersService } from '../billing/customers.js';
import { createCampaignsService } from './campaigns.js';
import { createCampaignJobs } from './campaigns.jobs.js';
import { matchCampaignCustomer } from './campaigns.customers.js';
import type { SignedLinkDelivery } from './service.delivery.js';
import campaignMessages from '../../../../../locales/en/links/campaigns.json' with { type: 'json' };
import messages from '../../../../../locales/en/links/service.json' with { type: 'json' };

const db = useTestDatabase(), factory = createFactories(db);
const address = 'someone@example.test';
const minutes = (n: number) => n * 60 * 1000;

async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-26T12:00:00Z');
  await factory('gyms', gymId, { memberEmailsEnabled: true, billingEnabled: true, timezone: 'America/Los_Angeles' });
  // A household given an address, for instance through the public join form, which stores it unproven.
  const household = await factory('households', gymId, { email: address });
  await factory('members', gymId, { householdId: household.id, email: address });
  const provider = new FakePayments(gymId, clock), jobs = new FakeJobs(clock), email = new FakeEmail();
  const paymentsFor = vi.fn(async () => { expect(isInTransaction()).toBe(false); return provider; });
  const delivery: SignedLinkDelivery = { prepare: async id => ({ gymId: id, gymName: 'Test Gym', origin: 'https://gym.example.test', email,
    memberEmailsEnabled: true, t: createTranslator({ 'links/service': messages, 'links/campaigns': campaignMessages }) }) };
  const service = createCampaignsService({ scope: db.forGym, clock, jobs, delivery, paymentsFor });
  createServerRegistry({ jobs: createCampaignJobs(() => service) }).registerJobs(jobs, new Set());
  const match = () => matchCampaignCustomer({ scope: db.forGym, clock, paymentsFor }, gymId, household.id);
  const read = () => db.forGym(gymId, async tx => ({
    customer: (await tx.select().from(households).where(eq(households.id, household.id)))[0]!.stripeCustomerId,
    audits: (await tx.select().from(auditEvents).where(eq(auditEvents.targetId, household.id))).map(event => event.action).sort(),
    matched: (await tx.select().from(auditEvents).where(eq(auditEvents.action, 'link_campaign.customer_matched'))).map(event => event.after),
  }));
  async function drain() { for (let n = 0; n < 50 && await jobs.runNext(); n++); }
  return { gymId, clock, household, provider, email, paymentsFor, service, match, read, drain };
}

describe('campaign customer matching by email', () => {
  it('links no customer naming no household by its email, and still sends the campaign link', async () => {
    const f = await fixture();
    // A customer the gym's account holds for this gym, naming no household, with a saved card: one a people import linked
    // and a charge or Checkout tagged, whose household then stopped storing its ID.
    f.provider.seedCustomer({ id: 'cus_someone_else', email: address });
    f.provider.recordPaymentMethod({ id: 'pm_someone_else', customerId: 'cus_someone_else', last4: '4242',
      expiresMonth: 12, expiresYear: 2030, brand: 'visa' });
    const lookup = vi.spyOn(f.provider, 'findCustomerByEmail');
    await f.service.create({ gymId: f.gymId, actor: { kind: 'system' } }, { name: 'Collect cards', purpose: 'update_card',
      expiresAt: '2026-11-26T12:00:00Z', reminderSchedule: [], recipients: [{ householdId: f.household.id }] });
    await f.drain();
    expect(lookup).toHaveBeenCalledWith(address);
    expect(await f.read()).toMatchObject({ customer: null, matched: [] });
    expect(f.email.messages.map(message => message.to)).toEqual([address]);
    expect(f.email.messages[0]!.text).toMatch(/\/l\/[A-Za-z0-9_-]+/);
  });
  it('links the one customer naming the household, and nothing when two do', async () => {
    const f = await fixture();
    f.provider.seedCustomer({ id: 'cus_untagged', email: address });
    f.provider.seedCustomer({ id: 'cus_own', email: address, householdId: f.household.id });
    await f.match();
    expect(await f.read()).toMatchObject({ customer: 'cus_own', matched: [{ matched: true, customerId: 'cus_own', tagged: true }] });
    const g = await fixture();
    g.provider.seedCustomer({ id: 'cus_own_one', email: address, householdId: g.household.id });
    g.provider.seedCustomer({ id: 'cus_own_two', email: address, householdId: g.household.id });
    await g.match();
    expect(await g.read()).toMatchObject({ customer: null, matched: [] });
  });
  it('releases an expired creation lease once and links no customer naming no household', async () => {
    const f = await fixture(), customers = createCustomersService({ scope: db.forGym, clock: f.clock, paymentsFor: f.paymentsFor });
    vi.spyOn(f.provider, 'createCustomer').mockRejectedValueOnce(new Error('Stripe unavailable'));
    await expect(customers.ensureCustomer(f.gymId, f.household.id)).rejects.toThrow();
    f.provider.seedCustomer({ id: 'cus_dashboard', email: address });
    f.clock.advance(minutes(15)); await f.match(); await f.match();
    expect(await f.read()).toEqual({ customer: null, matched: [],
      audits: ['billing.customer.creation_released', 'billing.customer.creation_reserved'] });
  });
});
