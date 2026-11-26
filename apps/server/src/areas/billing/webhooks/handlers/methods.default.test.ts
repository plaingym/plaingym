// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- One test holds the gym row and reads backend PIDs to verify the save waits for it.
import { eq, sql } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- One test locks the gym row the way a settings save does.
import { auditEvents, gyms, households, paymentMethods, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../../core/clock.js';
import { createServerRegistry } from '../../../../core/registry.js';
import { FakeJobs } from '../../../../infra/jobs/index.js';
import { FakeEmail } from '../../../../infra/email/index.js';
import type { PaymentObjectReference } from '../../../../infra/payments/index.js';
import { StripePayments } from '../../../../infra/payments/stripe.js';
import { StripeFixtures } from '../../../../infra/payments/stripe-fixtures.js';
import { createGymSettingsAccessor } from '../../../settings/settings.js';
import { createWebhookInbox, type WebhookHandler } from '../inbox.js';
import { createWebhookInboxJobs } from '../inbox.jobs.js';
import { createTransitionJobs } from '../../transitions/transitions.jobs.js';
import { composeBillingWebhooks } from './composition.js';
import { registerBillingWebhookHandlers } from './index.js';

// A collected method becomes the household's default only when the gym's current currency can charge it automatically.
const db = useTestDatabase(), factory = createFactories(db);
const secret = 'whsec_SYNTHETIC';
async function fixture(currency: 'USD' | 'CAD', withCardDefault: boolean) {
  const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency, billingEnabled: true, memberEmailsEnabled: true });
  const household = await factory('households', gymId, { stripeCustomerId: 'cus_fixture', email: 'payer@example.invalid' });
  const card = withCardDefault ? await factory('paymentMethods', gymId, { householdId: household.id, processorId: 'pm_card_default',
    isDefault: true, processorCreatedAt: new Date('2026-01-01T00:00:00Z') }) : undefined;
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
  const run = (type: string, reference: PaymentObjectReference) =>
    handlers.get(type)!({ id: 'evt_' + uuidv7(), type, gymId, objectId: reference.id, objectKind: reference.kind }, context);
  /** Collects `method` through a succeeded SetupIntent, with `mandate` on the setup when given. */
  const collect = (method: string, mandate?: string) => {
    const id = 'seti_' + method;
    transport.objects.set(id, { id, object: 'setup_intent', customer: 'cus_fixture', status: 'succeeded',
      payment_method: method, metadata: { gym_id: gymId }, ...(mandate ? { mandate } : {}) });
    return run('setup_intent.succeeded', { kind: 'setup', id });
  };
  const read = () => db.forGym(gymId, async tx => ({
    methods: await tx.select().from(paymentMethods), audits: await tx.select().from(auditEvents) }));
  const byProcessor = async (processorId: string) => (await read()).methods.find(row => row.processorId === processorId);
  const defaults = async () => (await read()).methods.filter(row => row.isDefault).map(row => row.processorId);
  const updates = async (rowId: string) => (await read()).audits
    .filter(row => row.action === 'billing.payment_method.updated' && row.targetId === rowId);
  return { gymId, household, card, collect, byProcessor, defaults, updates };
}

describe('webhook saves and the default rule', () => {
  it('saves a US bank account collected in a CAD gym as non-default and keeps the card default', async () => {
    const f = await fixture('CAD', true);
    await f.collect('pm_usbank_6789', 'mandate_setup');
    const bank = await f.byProcessor('pm_usbank_6789');
    expect(bank).toMatchObject({ type: 'us_bank_account', isDefault: false, revokedAt: null });
    expect(await f.defaults()).toEqual(['pm_card_default']);
    const audits = await f.updates(bank!.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ isDefault: false });
  });

  it('saves a Canadian debit without a mandate in a CAD gym as non-default, and makes one with a mandate default', async () => {
    const unmandated = await fixture('CAD', true);
    await unmandated.collect('pm_acss_6789');
    expect(await unmandated.byProcessor('pm_acss_6789')).toMatchObject({ type: 'acss_debit', isDefault: false, mandateId: null });
    expect(await unmandated.defaults()).toEqual(['pm_card_default']);

    const mandated = await fixture('CAD', true);
    await mandated.collect('pm_acss_6789', 'mandate_setup');
    expect(await mandated.byProcessor('pm_acss_6789')).toMatchObject({ type: 'acss_debit', isDefault: true, mandateId: 'mandate_setup' });
    expect(await mandated.defaults()).toEqual(['pm_acss_6789']);
  });

  it('leaves a USD household without a default for a Canadian debit, and makes a US bank account default', async () => {
    const f = await fixture('USD', false);
    await f.collect('pm_acss_6789', 'mandate_setup');
    expect(await f.byProcessor('pm_acss_6789')).toMatchObject({ type: 'acss_debit', isDefault: false, mandateId: 'mandate_setup' });
    expect(await f.defaults()).toEqual([]);
    await f.collect('pm_usbank_6789', 'mandate_us');
    expect(await f.byProcessor('pm_usbank_6789')).toMatchObject({ type: 'us_bank_account', isDefault: true });
    expect(await f.defaults()).toEqual(['pm_usbank_6789']);
  });

  it('waits for a transaction holding the gym row before it locks the household', async () => {
    const f = await fixture('USD', false);
    // The test database allows two app connections (the holder and the save), so the holder itself takes the
    // household row `nowait` once the save waits: it succeeds only if the waiting save holds no household lock.
    const locked = Promise.withResolvers<number>(), check = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let householdLock: Promise<unknown> | undefined;
    const holder = db.forGym(f.gymId, async tx => {
      // eslint-disable-next-line database/system-tables -- The holder's backend PID, for the lock-wait probe.
      const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
      await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, f.gymId)).for('update');
      locked.resolve(pid);
      await check.promise;
      householdLock = tx.select({ id: households.id }).from(households)
        .where(eq(households.id, f.household.id)).for('update', { noWait: true }).then(rows => rows, (error: unknown) => error);
      await householdLock;
      await release.promise;
    });
    const pid = await locked.promise;
    let finished = false;
    const saving = f.collect('pm_usbank_6789', 'mandate_us').finally(() => { finished = true; });
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
      expect(await householdLock).toEqual([{ id: f.household.id }]);
      expect(finished).toBe(false);
    } finally {
      check.resolve();
      release.resolve();
    }
    await Promise.all([holder, saving]);
    expect(await f.byProcessor('pm_usbank_6789')).toMatchObject({ type: 'us_bank_account', isDefault: true });
  });
});
