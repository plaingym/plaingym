// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { households, invoices, signedLinks, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createChargeRunner } from '../billing/runner/index.js';
import { createInvoiceTransitions } from '../billing/transitions/index.js';
import { createTransitionNotifications } from '../billing/transitions/notifications.js';
import { createSignedLinkCheckout } from '../billing/signed-link-checkout.js';
import { createSignedLinksService } from '../links/service.js';
import { createGymSettingsAccessor } from './settings.js';
import { createGoLiveService } from './go-live.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(kind: 'cycle' | 'assignment' | 'one_off' = 'cycle') {
  const gymId = uuidv7(), clock = new TestClock('2026-10-26T12:00:00Z');
  await factory('gyms', gymId, { billingEnabled: false, memberEmailsEnabled: false });
  const household = await factory('households', gymId, { email: 'payer@example.invalid', stripeCustomerId: null });
  const member = await factory('members', gymId, { householdId: household.id, status: 'active' });
  const invoice = await factory('invoices', gymId, { householdId: household.id, kind: kind === 'cycle' ? kind : 'one_off', status: 'open', number: 1, dueOn: '2026-10-26',
    ...(kind === 'cycle' ? { periodStartsOn: '2026-10-26', periodEndsOn: '2026-11-26' } : {}) });
  await factory('invoiceLineItems', gymId, { householdId: household.id, invoiceId: invoice.id, kind: kind === 'one_off' ? 'charge' : 'membership' });
  const provider = new FakePayments(gymId, clock), email = new FakeEmail(), settings = createGymSettingsAccessor({ scope: db.forGym, clock });
  const service = createGoLiveService({ scope: db.forGym, clock, smtpConfigured: async () => true });
  const context = { gymId, actor: { kind: 'system' as const } };
  const toggle = async (changes: { billingEnabled?: boolean; memberEmailsEnabled?: boolean }) => service.update(context, { revision: (await settings.get(gymId)).revision, ...changes });
  const transitions = createInvoiceTransitions({ scope: db.forGym, clock });
  const runner = createChargeRunner({ scope: db.forGym, clock, settings, transitions, jobs: new FakeJobs(clock), payments: async () => provider });
  const links = createSignedLinksService({ scope: db.forGym, clock });
  const checkout = createSignedLinkCheckout({ scope: db.forGym, clock, paymentsFor: async () => provider, originFor: async () => 'https://gym.example.test' });
  const link = (purpose: 'pay_invoice' | 'update_card' | 'onboarding') => links.create(context, { householdId: household.id,
    ...(purpose === 'pay_invoice' ? { purpose, invoiceId: invoice.id } : { purpose }), expiresAt: '2026-11-01T12:00:00Z' });
  return { gymId, household, member, invoice, provider, email, settings, service, context, clock, toggle, runner, link, checkout };
}

describe('go-live switch enforcement across entry paths', () => {
  it.each(['automatic', 'retry', 'staff', 'assignment', 'daily'] as const)('uses the persisted billing switch for %s collection', async mode => {
    const f = await fixture(mode === 'assignment' ? 'assignment' : 'cycle');
    const create = vi.spyOn(f.provider, 'createCharge'), confirm = vi.spyOn(f.provider, 'confirmCharge');
    const job = { gymId: f.gymId, timezone: 'UTC', clock: f.clock, jobId: uuidv7(), attempt: 1 };
    const owner = await factory('authUser', f.gymId);
    if (mode === 'daily') await f.runner.daily(f.gymId);
    else if (mode === 'retry') await f.runner.retry(f.invoice.id, job);
    else if (mode === 'assignment') await f.runner.collectAssigned(f.gymId, f.household.id);
    else expect(await f.runner.charge(f.gymId, f.invoice.id, mode === 'staff'
      ? { mode, context: { gymId: f.gymId, actor: { kind: 'user', userId: owner.id } } } : { mode })).toEqual({ status: 'skipped', reason: 'billing_disabled' });
    expect(create).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
  it.each(['update_card', 'onboarding'] as const)('allows R6 customer creation and %s card setup with billing off, without charging', async purpose => {
    const f = await fixture(), link = await f.link(purpose);
    const create = vi.spyOn(f.provider, 'createCustomer'), charge = vi.spyOn(f.provider, 'createCharge');
    const result = await f.checkout.start(f.gymId, link.link.id);
    expect(result.session).toMatchObject({ mode: 'setup', savesCard: true });
    expect(create).toHaveBeenCalledOnce(); expect(charge).not.toHaveBeenCalled();
    const [saved] = await db.forGym(f.gymId, tx => tx.select().from(households).where(eq(households.id, f.household.id)));
    expect(saved!.stripeCustomerId).toBe(result.session.customerId);
  });
  it.each(['cycle', 'assignment', 'one_off'] as const)('paused billing must refuse %s payment Checkout before R6 creates a customer or saves a card', async kind => {
    const f = await fixture(kind), link = await f.link('pay_invoice');
    const customer = vi.spyOn(f.provider, 'createCustomer'), checkout = vi.spyOn(f.provider, 'createCheckout');
    await expect(f.checkout.start(f.gymId, link.link.id)).rejects.toMatchObject({ code: 'unavailable' });
    expect(customer).not.toHaveBeenCalled(); expect(checkout).not.toHaveBeenCalled();
  });
  it('paused billing must refuse an existing payment Checkout URL too', async () => {
    const f = await fixture(); await f.toggle({ billingEnabled: true });
    const link = await f.link('pay_invoice'); await f.checkout.start(f.gymId, link.link.id);
    await f.toggle({ billingEnabled: false });
    await expect(f.checkout.start(f.gymId, link.link.id)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it.each(['cycle', 'assignment', 'one_off'] as const)('creates an enabled %s pay-link customer and preserves its card-saving policy', async kind => {
    const f = await fixture(kind); await f.toggle({ billingEnabled: true });
    const link = await f.link('pay_invoice'), create = vi.spyOn(f.provider, 'createCustomer');
    const result = await f.checkout.start(f.gymId, link.link.id);
    expect(result.session).toMatchObject({ mode: 'payment', savesCard: kind !== 'one_off' }); expect(create).toHaveBeenCalledOnce();
    expect((await db.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, f.invoice.id))))[0]!.checkoutSessionId).toBe(result.session.id);
  });
  it('reads the email switch for receipts, resend, dunning and action-required notices, while allowing staff alerts', async () => {
    const f = await fixture();
    const notices = createTransitionNotifications({ scope: db.forGym, clock: f.clock, settings: f.settings,
      prepare: async () => ({ email: f.email, origin: 'https://gym.example.test' }), staffRecipients: async () => ['owner@example.invalid'] });
    const invoice = { id: f.invoice.id, householdId: f.household.id, kind: 'cycle' as const, status: 'open' as const,
      number: 1, amountCents: f.invoice.amountCents, currency: f.invoice.currency, paidAt: null };
    const notice = { gymId: f.gymId, invoice };
    await notices.receipt(notice); await notices.receipt(notice);
    await notices.dunning({ ...notice, actionRequired: false }); await notices.dunning({ ...notice, actionRequired: true });
    expect(f.email.messages).toHaveLength(0);
    await notices.staffNotice(notice); expect(f.email.messages).toHaveLength(1);
    await f.toggle({ memberEmailsEnabled: true }); await notices.receipt(notice); expect(f.email.messages).toHaveLength(2);
    await f.toggle({ memberEmailsEnabled: false }); await notices.receipt(notice); expect(f.email.messages).toHaveLength(2);
  });
  it.each(['receipt', 'dunning', 'action'] as const)('%s delivery must recheck member email after asynchronous preparation', async kind => {
    const f = await fixture(); await f.toggle({ memberEmailsEnabled: true });
    const notices = createTransitionNotifications({ scope: db.forGym, clock: f.clock, settings: f.settings,
      prepare: async () => { await f.toggle({ memberEmailsEnabled: false }); return { email: f.email, origin: 'https://gym.example.test' }; },
      staffRecipients: async () => [] });
    const notice = { gymId: f.gymId, invoice: { id: f.invoice.id, householdId: f.household.id, kind: 'cycle' as const, status: 'paid' as const,
      number: 1, amountCents: f.invoice.amountCents, currency: f.invoice.currency, paidAt: f.clock.now().toISOString() } };
    if (kind === 'receipt') await notices.receipt(notice);
    else await notices.dunning({ ...notice, actionRequired: kind === 'action' });
    expect(f.email.messages).toHaveLength(0);
    const links = await db.forGym(f.gymId, tx => tx.select().from(signedLinks));
    expect(links.every(link => !!link.revokedAt)).toBe(true);
  });
  it('signed-link delivery must recheck member email instead of trusting prepared preferences', async () => {
    const f = await fixture(); await f.toggle({ memberEmailsEnabled: true });
    const links = createSignedLinksService({ scope: db.forGym, clock: f.clock, delivery: { async prepare() {
      const enabled = (await f.settings.get(f.gymId)).memberEmailsEnabled;
      await f.toggle({ memberEmailsEnabled: false });
      return { gymId: f.gymId, gymName: 'Test Gym', origin: 'https://gym.example.test', email: f.email,
        memberEmailsEnabled: enabled, t: (key: string) => key };
    } } });
    await links.send(f.context, { purpose: 'update_card', householdId: f.household.id, expiresAt: '2026-11-01T12:00:00Z' })
      .catch(error => { expect(error).toMatchObject({ code: 'unavailable' }); });
    expect(f.email.messages).toHaveLength(0);
  });
});
