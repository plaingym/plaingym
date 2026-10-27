// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { createHmac } from 'node:crypto';
import { expect } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { auditEvents, households, invoiceLineItems, invoices, memberships, paymentAttempts, paymentMethods, payments, refunds, signedLinks, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Scenario observations and setup stay in their isolated database.
import { jobs, stripeEvents, gyms } from '@plaingym/db';
import type { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { TestClock } from '../../../core/clock.js';
import { createApp } from '../../../app.js';
import { FakeEmail } from '../../../infra/email/index.js';
import { PostgresJobs } from '../../../infra/jobs/index.js';
import { StripePayments } from '../../../infra/payments/stripe.js';
import { StripeFixtures } from '../../../infra/payments/stripe-fixtures.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { authorize } from '../../staff/auth.permissions.js';
import { createSignedLinksService } from '../../links/service.js';
import { createMembershipService } from '../memberships.js';
import { createPaymentService } from '../payments.js';
import { createChargeRunner } from '../runner/index.js';
import { createRunnerJobs } from '../runner/runner.jobs.js';
import { createSignedLinkCheckout } from '../signed-link-checkout.js';
import { createTransitionJobs } from '../transitions/transitions.jobs.js';
import { createWebhookInbox } from '../webhooks/inbox.js';
import { createWebhookInboxRoutes } from '../webhooks/inbox.routes.js';
import { createWebhookInboxJobs } from '../webhooks/inbox.jobs.js';
import { composeBillingWebhooks } from '../webhooks/handlers/composition.js';

export const origin = 'https://gym.example.invalid';
const secret = 'whsec_scenario_synthetic';
export async function workflowFixture(db: ReturnType<typeof useTestDatabase>, options: {
  now?: string; dueOn?: string; card?: string; enabled?: boolean; empty?: boolean;
} = {}) {
  const factory = createFactories(db), gymId = uuidv7(), timezone = 'America/Vancouver';
  const clock = new TestClock(options.now ?? '2028-03-01T17:00:00Z');
  await factory('gyms', gymId, { currency: 'USD', timezone, billingEnabled: options.enabled ?? true, memberEmailsEnabled: true });
  const home = await factory('households', gymId, { billingDay: 1, stripeCustomerId: 'cus_fixture', email: 'payer@example.invalid' });
  const user = await factory('authUser', gymId);
  const member = await factory('members', gymId, { householdId: home.id, email: 'member@example.invalid' });
  const plan = await factory('plans', gymId, { amountCents: 10000, currency: 'USD' });
  if (!options.empty) await factory('memberships', gymId, { householdId: home.id, memberId: member.id, planId: plan.id,
    amountCents: 10000, currency: 'USD', status: 'active', startsOn: '2028-01-01', nextDueOn: options.dueOn ?? '2028-03-01' });
  await factory('paymentMethods', gymId, { householdId: home.id, processorId: options.card ?? 'pm_4242', isDefault: true });
  const transport = new StripeFixtures(gymId, Math.floor(clock.now().getTime() / 1000));
  // The shared transport's Checkout defaults are $1. Supply the requested line's actual price.
  const provider = new StripePayments(gymId, { clock, webhookSecret: secret, transport: {
    async request(input) {
      const result = await transport.request(input);
      if (input.method === 'POST' && input.path === '/v1/checkout/sessions' && result.mode === 'payment') {
        const lines = input.params?.line_items as { price_data: { unit_amount: number; currency: string } }[];
        Object.assign(transport.objects.get(String(result.payment_intent))!, {
          amount: lines[0]!.price_data.unit_amount, currency: lines[0]!.price_data.currency,
        });
      }
      return result;
    },
  } });
  const queue = new PostgresJobs({ database: db, clock }), email = new FakeEmail();
  const settings = createGymSettingsAccessor({ scope: db.forGym }), paymentsFor = async () => provider;
  const common = { scope: db.forGym, clock, settings, jobs: queue };
  const links = createSignedLinksService(common);
  const checkout = createSignedLinkCheckout({ ...common, paymentsFor, originFor: async () => origin });
  const inbox = createWebhookInbox({ ...common, system: db.forSystem, gymSettings: settings, paymentsFor });
  const billing = composeBillingWebhooks({ ...common, inbox, paymentsFor,
    prepare: async () => ({ email, origin }), staffRecipients: async () => ['owner@example.invalid'],
    async afterCheckoutRecorded(gym, link, session) {
      try { await checkout.complete(gym, link, session); }
      catch (error) { if (!(error instanceof AppError && error.code === 'not_found')) throw error; }
    },
  });
  const runner = createChargeRunner({ ...common, transitions: billing.transitions, payments: paymentsFor });
  billing.attachRetry(runner.retry);
  const lifecycle = createMembershipService({ ...common, onAssigned: runner.onAssigned });
  const service = createPaymentService({ ...common, runner, paymentsFor, transitions: billing.transitions });
  for (const job of [...createWebhookInboxJobs(inbox), ...createTransitionJobs(() => billing.effects), ...createRunnerJobs(() => runner, settings)])
    queue.handle(job.id, job.handler);
  const app = createApp({ clock, authorize, skipSetup: true, contributions: { routes: createWebhookInboxRoutes(inbox) },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone, enabledModules: new Set() } }); await next(); },
    session: async (_c, next) => { await next(); } });
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const read = () => db.forGym(gymId, async tx => ({
    invoices: await tx.select().from(invoices).orderBy(asc(invoices.dueOn), asc(invoices.id)),
    attempts: await tx.select().from(paymentAttempts).orderBy(asc(paymentAttempts.createdAt), asc(paymentAttempts.attemptNumber)),
    payments: await tx.select().from(payments), refunds: await tx.select().from(refunds),
    memberships: await tx.select().from(memberships), lines: await tx.select().from(invoiceLineItems),
    audits: await tx.select().from(auditEvents), jobs: await tx.select().from(jobs), events: await tx.select().from(stripeEvents),
    links: await tx.select().from(signedLinks), methods: await tx.select().from(paymentMethods), homes: await tx.select().from(households),
  }));
  async function drain() {
    for (let n = 0; n < 80; n++) if (!await queue.runNext()) {
      const failed = (await read()).jobs.filter(j => j.status === 'failed' || j.status === 'pending' && j.attempts > 0);
      expect(failed, 'No job may silently back off after an unexpected failure').toEqual([]);
      return;
    }
    throw new Error('Scenario queue exceeded 80 jobs');
  }
  async function runJob(name: string, payload: object = {}) {
    await queue.enqueue(name, payload, { gymId, timezone }); await drain();
  }
  async function deliver(type: string, id: string, eventId = 'evt_' + uuidv7()) {
    const body = JSON.stringify({ id: eventId, object: 'event', type, livemode: false,
      data: { object: { ...transport.objects.get(id), id, metadata: { gym_id: gymId } } } });
    const timestamp = Math.floor(clock.now().getTime() / 1000);
    const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex')}`;
    const response = await app.request(origin + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signature } });
    expect(response.status, await response.clone().text()).toBe(200);
    return eventId;
  }
  async function setCard(processorId: string) {
    const card = (await read()).methods.find(row => row.processorId === processorId)
      ?? await factory('paymentMethods', gymId, { householdId: home.id, processorId, isDefault: false });
    await service.setDefault(context, home.id, card.id);
  }
  const enable = (billingEnabled: boolean) => db.forGym(gymId, tx => tx.update(gyms).set({ billingEnabled }).where(eq(gyms.id, gymId)));
  async function payLink(invoiceId: string) {
    const created = await links.create(context, { purpose: 'pay_invoice', invoiceId, householdId: home.id, expiresAt: '2035-01-01T00:00:00Z' });
    return { ...await checkout.start(gymId, created.link.id), link: created.link };
  }
  return { db, factory, gymId, timezone, clock, home, user, member, plan, transport, provider, queue, email, settings, common,
    links, checkout, inbox, billing, runner, lifecycle, service, context, read, drain, runJob, deliver, setCard, enable, payLink };
}
export type Workflow = Awaited<ReturnType<typeof workflowFixture>>;
export async function clearJobs(db: ReturnType<typeof useTestDatabase>) { await db.forSystem(tx => tx.delete(jobs)); }
