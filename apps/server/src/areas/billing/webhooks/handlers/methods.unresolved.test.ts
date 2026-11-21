// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, households, paymentMethods, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../../core/clock.js';
import { setLogSink } from '../../../../core/log.js';
import { createServerRegistry } from '../../../../core/registry.js';
import { FakeJobs } from '../../../../infra/jobs/index.js';
import { FakeEmail } from '../../../../infra/email/index.js';
import type { PaymentObjectReference } from '../../../../infra/payments/index.js';
import { StripePayments } from '../../../../infra/payments/stripe.js';
import { StripeFixtures } from '../../../../infra/payments/stripe-fixtures.js';
import { createGymSettingsAccessor } from '../../../settings/settings.js';
import { createWebhookHealthQuery, createWebhookInbox, type WebhookHandler } from '../inbox.js';
import { createWebhookInboxJobs } from '../inbox.jobs.js';
import { createTransitionJobs } from '../../transitions/transitions.jobs.js';
import { composeBillingWebhooks } from './composition.js';
import { registerBillingWebhookHandlers } from './index.js';

// Erasing a household's last member clears its Stripe customer link and redacts the cards still attached, and Stripe
// then sends an update for each of them: the update has no household to change, so it is finished rather than failed.
const db = useTestDatabase(), factory = createFactories(db);
const secret = 'whsec_SYNTHETIC';
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency: 'USD', billingEnabled: true, memberEmailsEnabled: true });
  const household = await factory('households', gymId, { stripeCustomerId: 'cus_fixture', email: 'payer@example.invalid' });
  const transport = new StripeFixtures(gymId, Math.floor(clock.now().getTime() / 1000));
  const provider = new StripePayments(gymId, { clock, transport, webhookSecret: secret });
  const jobs = new FakeJobs(clock), email = new FakeEmail(), settings = createGymSettingsAccessor({ scope: db.forGym });
  const inbox = createWebhookInbox({ scope: db.forGym, system: db.forSystem, clock, jobs, gymSettings: settings,
    async paymentsFor() { return provider; } });
  const composed = composeBillingWebhooks({ scope: db.forGym, clock, jobs, settings, inbox,
    async paymentsFor() { return provider; }, async prepare() { return { email, origin: 'https://gym.example.invalid' }; },
    async staffRecipients() { return ['owner@example.invalid']; } });
  createServerRegistry({ jobs: [...createWebhookInboxJobs(inbox), ...createTransitionJobs(() => composed.effects)] })
    .registerJobs(jobs, new Set());
  const handlers = new Map<string, WebhookHandler>();
  registerBillingWebhookHandlers({ register(type, handler) { handlers.set(type, handler); } },
    { scope: db.forGym, clock, transitions: composed.transitions });
  const context = { gymId, clock, timezone: 'UTC', attempt: 1, jobId: uuidv7(), payments: provider };
  const run = async (type: string, reference: PaymentObjectReference, eventId = 'evt_' + uuidv7()) =>
    handlers.get(type)!({ id: eventId, type, gymId, objectId: reference.id, objectKind: reference.kind }, context);
  const read = () => db.forGym(gymId, async tx => ({
    methods: await tx.select().from(paymentMethods), audits: await tx.select().from(auditEvents) }));
  const setup = (id: string, method: string) => transport.objects.set(id, { id, object: 'setup_intent', customer: 'cus_fixture',
    status: 'succeeded', payment_method: method, metadata: { gym_id: gymId } });
  // Collect the card while the household is linked, then unlink it as erasure does.
  setup('seti_new', 'pm_3155');
  await run('setup_intent.succeeded', { kind: 'setup', id: 'seti_new' });
  await db.forGym(gymId, tx => tx.update(households).set({ stripeCustomerId: null }).where(eq(households.id, household.id)));
  (transport.objects.get('pm_3155')!.card as Record<string, unknown>).exp_year = 2035;
  return { gymId, clock, transport, jobs, inbox, run, read, setup };
}
async function capture<T>(fn: () => Promise<T>) {
  const lines: string[] = [], previous = setLogSink(line => lines.push(line));
  try { return { result: await fn(), lines: lines.map(line => JSON.parse(line) as Record<string, unknown>) }; }
  finally { setLogSink(previous); }
}

describe('payment method updates for a customer no household is linked to', () => {
  for (const type of ['payment_method.updated', 'payment_method.automatically_updated'] as const) {
    it(`finishes ${type} with an info log and writes nothing`, async () => {
      const f = await fixture(), before = await f.read();
      expect(before.methods).toMatchObject([{ processorId: 'pm_3155', expiryYear: 2030 }]);
      const eventId = 'evt_' + uuidv7();
      const { lines } = await capture(() => f.run(type, { kind: 'payment_method', id: 'pm_3155' }, eventId));
      expect(await f.read()).toEqual(before);
      expect(lines).toEqual([{ time: expect.any(String), level: 'info', event: 'billing.payment_method.household_unresolved',
        gymId: f.gymId, paymentMethodId: 'pm_3155', customerId: 'cus_fixture', eventId }]);
    });
  }
  it('still fails a collection for the unlinked customer and writes no row', async () => {
    const f = await fixture(), before = await f.read();
    f.setup('seti_later', 'pm_0341');
    const { lines } = await capture(async () => {
      await expect(f.run('setup_intent.succeeded', { kind: 'setup', id: 'seti_later' }))
        .rejects.toThrow('Saved card household is unresolved');
    });
    expect(await f.read()).toEqual(before);
    expect(lines.filter(line => line.event === 'billing.payment_method.household_unresolved')).toEqual([]);
  });
  it('processes the delivered update on its first attempt through the inbox', async () => {
    const f = await fixture(), before = await f.read();
    const event = { id: 'evt_redacted_card', object: 'event', type: 'payment_method.updated', livemode: false,
      data: { object: { id: 'pm_3155', object: 'payment_method', customer: 'cus_fixture', metadata: { gym_id: f.gymId } } } };
    const body = new TextEncoder().encode(JSON.stringify(event)), timestamp = Math.floor(f.clock.now().getTime() / 1000);
    const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex')}`;
    await f.inbox.receive(f.gymId, body, signature);
    const { lines } = await capture(() => f.jobs.runNext());
    expect(f.jobs.jobs.filter(job => job.name === 'billing.webhooks.dispatch'))
      .toMatchObject([{ status: 'completed', attempt: 1 }]);
    expect(await createWebhookHealthQuery(db.forGym, f.clock).get(f.gymId)).toMatchObject({
      lastProcessedAt: f.clock.now().toISOString(), pendingCount: 0, failedCount: 0 });
    expect(await f.read()).toEqual(before);
    expect(lines.map(line => line.event)).toEqual(['billing.payment_method.household_unresolved']);
    expect(lines[0]).toMatchObject({ eventId: 'evt_redacted_card', paymentMethodId: 'pm_3155' });
  });
});
