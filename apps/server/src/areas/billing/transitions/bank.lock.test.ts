// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- One test holds the gym row and reads backend PIDs to verify the revoke waits for it.
import { eq, sql } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- One test locks the gym row the way a settings save does.
import { auditEvents, gyms, households, invoices, paymentMethods, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import type { ChargeOutcome, Payments } from '../../../infra/payments/index.js';
import { revokeBankMethod } from './bank.js';
import { createInvoiceTransitions } from './index.js';

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

// A bank failure that revokes its method takes the gym before the invoice, the order the Stripe key save's test-to-live
// clear uses (the gym `for update`, then payable invoices), so the two never deadlock.
describe('bank failure lock order', () => {
  async function setup() {
    const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
    await factory('gyms', gymId, { currency: 'USD', billingEnabled: true });
    const household = await factory('households', gymId, { stripeCustomerId: 'cus_fixture' });
    const invoice = await factory('invoices', gymId, { householdId: household.id, currency: 'USD', status: 'open', kind: 'cycle',
      number: 1, periodStartsOn: '2026-10-01', periodEndsOn: '2026-11-01' });
    const bank = await factory('paymentMethods', gymId, { householdId: household.id, processorId: 'pm_bank', type: 'us_bank_account',
      brand: null, last4: '6789', isDefault: true, processorCreatedAt: new Date('2026-10-20T00:00:00Z') });
    return { gymId, clock, invoice, bank, context: { gymId, actor: { kind: 'system' as const } } };
  }

  /**
   * Holds the gym row `for update`, as the Stripe key save does, while `work` runs on the second app connection, until
   * the probe sees `work` blocked by the holder. The holder then takes the invoice row `nowait` in a savepoint (so a
   * refusal leaves its transaction usable): it gets the row only if the waiting work holds no invoice lock.
   */
  async function whileGymHeld(gymId: string, invoiceId: string, work: () => Promise<unknown>) {
    const locked = Promise.withResolvers<number>(), check = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let invoiceLock: Promise<unknown> | undefined;
    const holder = db.forGym(gymId, async tx => {
      // eslint-disable-next-line database/system-tables -- The holder's backend PID, for the lock-wait probe.
      const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
      await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, gymId)).for('update');
      locked.resolve(pid);
      await check.promise;
      invoiceLock = tx.transaction(savepoint => savepoint.select({ id: invoices.id }).from(invoices)
        .where(eq(invoices.id, invoiceId)).for('update', { noWait: true })).then(rows => rows, (error: unknown) => error);
      await invoiceLock;
      await release.promise;
    });
    const pid = await locked.promise;
    let finished = false;
    const working = work().finally(() => { finished = true; });
    let invoiceProbe: unknown, waiting: string | undefined;
    try {
      const deadline = Date.now() + 5000;
      while (waiting === undefined && !finished && Date.now() < deadline) {
        // eslint-disable-next-line database/system-tables -- The lock-wait probe.
        waiting = (await db.system.db.execute<{ query: string }>(
          sql`select query from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`))[0]?.query;
        if (waiting === undefined) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBeDefined();
      expect(finished).toBe(false);
      check.resolve();
      await expect.poll(() => invoiceLock).toBeDefined();
      invoiceProbe = await invoiceLock;
      expect(finished).toBe(false);
    } finally {
      check.resolve();
      release.resolve();
      // Both finish before the next test, even when an assertion above failed.
      await Promise.allSettled([holder, working]);
    }
    const [, outcome] = await Promise.all([holder, working]);
    return { outcome, invoiceProbe, waiting: waiting! };
  }

  async function revoked(f: Awaited<ReturnType<typeof setup>>) {
    const rows = await db.forGym(f.gymId, async tx => ({
      invoice: (await tx.select().from(invoices).where(eq(invoices.id, f.invoice.id)))[0]!,
      method: (await tx.select().from(paymentMethods).where(eq(paymentMethods.id, f.bank.id)))[0]! }));
    expect(rows.invoice.status).toBe('past_due');
    expect(rows.method).toMatchObject({ isDefault: false, revokedAt: f.clock.now() });
  }

  it('a saved bank method an attempt finds unusable waits for the gym before it locks the invoice', async () => {
    const f = await setup(), transitions = createInvoiceTransitions({ scope: db.forGym, clock: f.clock });
    const attempt = await factory('paymentAttempts', f.gymId, { invoiceId: f.invoice.id, savedPaymentMethod: 'pm_bank',
      paymentIntentId: 'pi_bank' });
    const held = await whileGymHeld(f.gymId, f.invoice.id, () => transitions.cardFailed(f.context,
      { invoiceId: f.invoice.id, attemptId: attempt.id, paymentIntentId: 'pi_bank', outcome: 'payment_method_unusable' }));
    expect(held.invoiceProbe).toEqual([{ id: f.invoice.id }]);
    expect(held.outcome).toMatchObject({ outcome: 'applied' });
    await revoked(f);
  });

  it('a processing bank payment found unusable waits for the gym before it locks the invoice', async () => {
    const f = await setup();
    const failed: ChargeOutcome = { status: 'failed', code: 'payment_method_unusable', id: 'pi_checkout', amount: 10000, currency: 'usd',
      customerId: 'cus_fixture', paymentMethodId: 'pm_bank', metadata: { gymId: f.gymId, invoiceId: f.invoice.id } };
    const provider = { findCharge: async () => failed } as unknown as Payments;
    const transitions = createInvoiceTransitions({ scope: db.forGym, clock: f.clock, paymentsFor: async () => provider });
    await transitions.paymentProcessing(f.context, { invoiceId: f.invoice.id, paymentIntentId: 'pi_checkout' });
    const held = await whileGymHeld(f.gymId, f.invoice.id, () => transitions.processingFailed(f.context,
      { invoiceId: f.invoice.id, paymentIntentId: 'pi_checkout', code: 'payment_method_unusable' }));
    expect(held.invoiceProbe).toEqual([{ id: f.invoice.id }]);
    expect(held.outcome).toMatchObject({ outcome: 'applied' });
    await revoked(f);
  });

  // This pins today's order for a decline (invoice, then the gym through its first write), not a wanted one: taking the
  // gym first here too would change these expectations.
  it('a decline that keeps the method adds no gym lock before the invoice', async () => {
    const f = await setup(), transitions = createInvoiceTransitions({ scope: db.forGym, clock: f.clock });
    const attempt = await factory('paymentAttempts', f.gymId, { invoiceId: f.invoice.id, savedPaymentMethod: 'pm_bank',
      paymentIntentId: 'pi_bank' });
    // Every gym-owned row references its gym, so the decline's first write checks that key under the holder's lock;
    // the decline has locked the invoice by then, as before.
    const held = await whileGymHeld(f.gymId, f.invoice.id, () => transitions.cardFailed(f.context,
      { invoiceId: f.invoice.id, attemptId: attempt.id, paymentIntentId: 'pi_bank', outcome: 'failed' }));
    expect(held.waiting).toMatch(/^(insert|update)\b/);
    expect(held.invoiceProbe).toMatchObject({ cause: { code: '55P03' } });
    expect(held.outcome).toMatchObject({ outcome: 'applied' });
    const [method] = await db.forGym(f.gymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.id, f.bank.id)));
    expect(method).toMatchObject({ isDefault: true, revokedAt: null });
  });
});
