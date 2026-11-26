// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line database/system-tables -- One test reads backend PIDs to see a reservation wait on the gym row lock.
import { eq, sql } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- One test holds the gym row the way a settings save does.
import { auditEvents, gyms, households, invoices, paymentAttempts, paymentMethods, type Transaction } from '@plaingym/db';
import type { SetupStripeRequest } from '@plaingym/shared/contracts';
import { FakePayments } from '../../../infra/payments/index.js';
import { StripeFixtures } from '../../../infra/payments/stripe-fixtures.js';
import { stripeProvisioner } from '../../../infra/payments/setup.js';
import { createStripeStep } from '../../setup/stripe-step.js';
import { stripeSwitchSnapshot, stripeTestClearedAction, stripeWriteCurrent, stripeWriteScope, StripeTestModeSwitched,
  withProviderWrites } from '../stripe-writes.js';
import { createChargeRunner } from './index.js';
import { useRunnerFixture, type Fixture } from './runner.fixture.test-helper.js';

const { db, factory, fixture, invoice } = useRunnerFixture();

/** A switch's audit, written as the switch's save writes it (target: the gym). */
const switchAudit = (f: Fixture) => ({ gymId: f.gymId, actorKind: 'system' as const, action: stripeTestClearedAction,
  targetType: 'gym', targetId: f.gymId, before: null, after: {}, occurredAt: f.clock.now() });
/**
 * A runner whose first provider is the old test key, resolved just before `switching` commits a switch; every later
 * resolution returns the fixture's (live) provider.
 */
function switchingRunner(f: Fixture, switching: () => Promise<void>) {
  const old = new FakePayments(f.gymId, f.clock);
  old.keyMode = 'test';
  old.seedCustomer({ id: 'cus_test', email: 'payer@example.invalid' });
  const oldCalls = [vi.spyOn(old, 'adoptCustomer'), vi.spyOn(old, 'createCharge'), vi.spyOn(old, 'confirmCharge')];
  let resolved = 0;
  const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, async payments() {
    if (resolved++ === 0) { await switching(); return old; }
    return f.provider;
  } });
  return { runner, oldCalls, resolutions: () => resolved };
}

describe('a charge run across a switch from Stripe test mode to live', () => {
  it('reserves nothing with a provider resolved before the switch, and charges with the provider resolved again', async () => {
    const f = await fixture(), bill = await invoice(f), create = vi.spyOn(f.provider, 'createCharge');
    const { runner, oldCalls, resolutions } = switchingRunner(f, async () => {
      await db.forGym(f.gymId, tx => tx.insert(auditEvents).values(switchAudit(f)));
    });
    expect(await runner.charge(f.gymId, bill.id)).toEqual({ status: 'succeeded' });
    expect(resolutions()).toBe(2);
    for (const call of oldCalls) expect(call).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const state = await f.read();
    expect(state.attempts).toMatchObject([{ attemptNumber: 1, status: 'succeeded' }]);
    expect(state.audits.filter(row => row.action === 'billing.runner.reserved')).toHaveLength(1);
  });
  it('waits for a switch that holds the gym row when it comes to reserve, then resolves the provider again', async () => {
    const f = await fixture(), bill = await invoice(f), create = vi.spyOn(f.provider, 'createCharge');
    const locked = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    let saving: Promise<void> | undefined;
    const { runner, oldCalls } = switchingRunner(f, async () => {
      // The switch's save locks the gym row first and writes its audit before it commits.
      saving = db.forGym(f.gymId, async tx => {
        // eslint-disable-next-line database/system-tables -- The holder's backend PID, for the lock-wait probe.
        const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
        await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, f.gymId)).for('update');
        await tx.insert(auditEvents).values(switchAudit(f));
        locked.resolve(pid); await release.promise;
      });
      await locked.promise;
    });
    const charging = runner.charge(f.gymId, bill.id);
    let finished = false;
    void charging.then(() => { finished = true; }, () => { finished = true; });
    try {
      const pid = await locked.promise;
      let sawWait = false;
      // From the system connection: the switch and the waiting reservation hold both of the gym pool's connections.
      for (let tries = 0; tries < 5_000 && !sawWait && !finished; tries++)
        // eslint-disable-next-line database/system-tables -- The lock-wait probe.
        sawWait = (await db.system.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`))[0]!.n > 0;
      expect(sawWait).toBe(true);
      expect(finished).toBe(false);
      expect(create).not.toHaveBeenCalled();
    } finally { release.resolve(); await saving; }
    expect(await charging).toEqual({ status: 'succeeded' });
    for (const call of oldCalls) expect(call).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect((await f.read()).attempts).toMatchObject([{ attemptNumber: 1, status: 'succeeded' }]);
  });
  /**
   * A runner whose first provider resolution sees a switch that committed after the charge read the invoice: the switch
   * (`clear`, then its audit) commits first, so that resolution already returns the live provider.
   */
  function switchedOnResolve(f: Fixture, clear: (tx: Transaction) => Promise<unknown>) {
    let resolved = 0;
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, async payments() {
      if (resolved++ === 0) await db.forGym(f.gymId, async tx => { await clear(tx); await tx.insert(auditEvents).values(switchAudit(f)); });
      return f.provider;
    } });
    return { runner, resolutions: () => resolved };
  }
  it('makes no release call with the live provider for a test Checkout session the switch cleared after it was read', async () => {
    const f = await fixture(), bill = await invoice(f);
    // The provider resolved after the switch holds the live key, so it runs outside the guard and only the runner's own
    // recheck stops the release.
    f.provider.keyMode = 'live';
    const old = new FakePayments(f.gymId, f.clock);
    old.keyMode = 'test';
    old.seedCustomer({ id: 'cus_test', email: 'payer@example.invalid' });
    const session = await old.createCheckout({ mode: 'payment', customerId: 'cus_test', amount: 10000, currency: 'cad', invoiceId: bill.id,
      successUrl: 'https://gym.example.invalid/success', cancelUrl: 'https://gym.example.invalid/cancel', saveForOffSession: true,
      idempotencyKey: bill.id + ':checkout' });
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ checkoutSessionId: session.id }).where(eq(invoices.id, bill.id)));
    const expire = vi.spyOn(f.provider, 'expireCheckout'), read = vi.spyOn(f.provider, 'readPaymentObject');
    const { runner, resolutions } = switchedOnResolve(f, tx =>
      tx.update(invoices).set({ checkoutSessionId: null, checkoutExpiresAt: null }).where(eq(invoices.id, bill.id)));
    expect(await runner.charge(f.gymId, bill.id)).toEqual({ status: 'succeeded' });
    expect(resolutions()).toBe(2);
    expect(expire).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalledWith(expect.objectContaining({ id: session.id }));
    expect((await f.read()).attempts).toMatchObject([{ attemptNumber: 1, status: 'succeeded' }]);
  });
  it('does not apply a test success returned while releasing action-needed work across a switch', async () => {
    const f = await fixture(), bill = await invoice(f);
    f.provider.keyMode = 'test';
    f.provider.respondNextConfirmation('authentication_required');
    expect((await f.runner.charge(f.gymId, bill.id)).status).toBe('action_required');
    const cancel = vi.spyOn(f.provider, 'cancelCharge').mockImplementationOnce(async id => {
      // Confirmation won cancellation just as the owner committed the switch.
      const outcome = await f.provider.confirmCharge(id, { idempotencyKey: 'confirmation-race' });
      await db.forGym(f.gymId, async tx => {
        await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, f.gymId)).for('update');
        await tx.update(households).set({ stripeCustomerId: null });
        await tx.update(paymentMethods).set({ revokedAt: f.clock.now(), isDefault: false });
        await tx.update(paymentAttempts).set({ status: 'failed', declineCode: 'test_cleared', resolvedAt: f.clock.now() });
        await tx.insert(auditEvents).values(switchAudit(f));
      });
      return outcome;
    });
    const user = await factory('authUser', f.gymId);
    expect((await f.runner.charge(f.gymId, bill.id, { mode: 'staff',
      context: { gymId: f.gymId, actor: { kind: 'user', userId: user.id } } })).status).toBe('skipped');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await f.read()).payments).toEqual([]);
    expect((await f.read()).attempts).toMatchObject([{ status: 'failed', declineCode: 'test_cleared' }]);
  });
  it('charges as before when no switch commits during the run', async () => {
    const f = await fixture(), bill = await invoice(f);
    await db.forGym(f.gymId, tx => tx.insert(auditEvents).values(switchAudit(f)));
    const resolve = vi.fn(async () => f.provider);
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments: resolve });
    expect(await runner.charge(f.gymId, bill.id)).toEqual({ status: 'succeeded' });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe("a switch through the setup wizard's Stripe step", () => {
  type Save = { choice: 'skip' } | { choice: 'configure'; restrictedKey: string };
  /**
   * Puts the fixture's gym in an unfinished setup with step 5 done; each call of the result saves the Stripe step. Every
   * key reads the gym's Stripe references (one account). With `references: false` the fixture's customer and card are
   * removed first, so the step may change the mode (it refuses a key in the other mode while the gym holds them).
   */
  async function setupStep(f: Fixture, { references = true } = {}) {
    if (!references) await db.forGym(f.gymId, async tx => {
      await tx.update(households).set({ stripeCustomerId: null });
      await tx.delete(paymentMethods);
    });
    const owner = await factory('authUser', f.gymId);
    const [gym] = await db.forGym(f.gymId, tx => tx.select().from(gyms).where(eq(gyms.id, f.gymId)));
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ settings: { ...gym!.settings as object,
      setup: { ownerId: owner.id, completed: false, completedSteps: [0, 1, 2, 3, 4, 5] } } }).where(eq(gyms.id, f.gymId)));
    let revision = gym!.revision;
    const accounts = new Map<string, StripeFixtures>();
    const step = createStripeStep({ key: Buffer.alloc(32, 7), origin: 'https://gym.example.invalid', clock: f.clock, scope: db.forGym,
      transport: () => ({ async request() { return {}; } }),
      provisioner: apiKey => {
        if (!accounts.has(apiKey)) accounts.set(apiKey, new StripeFixtures(f.gymId, undefined, accounts.size * 1000));
        return stripeProvisioner(accounts.get(apiKey)!);
      } });
    const context = { gymId: f.gymId, actor: { kind: 'user', userId: owner.id } } as const;
    return async (save: Save) => {
      revision = (await step.configure(context, { ...save, revision } as SetupStripeRequest)).revision;
    };
  }
  const snapshotOf = (f: Fixture) => db.forGym(f.gymId, tx => stripeSwitchSnapshot(tx, f.gymId));
  const currentFor = (f: Fixture, snapshot: string | null) => db.forGym(f.gymId, tx => stripeWriteCurrent(tx, f.gymId, snapshot));

  it.each<[string, Save | null, Save, boolean]>([
    ['a switch to live', { choice: 'configure', restrictedKey: 'rk_test_SETUPA' }, { choice: 'configure', restrictedKey: 'rk_live_SETUPB' }, false],
    ['a removal', { choice: 'configure', restrictedKey: 'rk_test_SETUPA' }, { choice: 'skip' }, false],
    ['a same-mode rotation', { choice: 'configure', restrictedKey: 'rk_test_SETUPA' }, { choice: 'configure', restrictedKey: 'rk_test_SETUPC' }, true],
    ['a first save from no Stripe', null, { choice: 'configure', restrictedKey: 'rk_test_SETUPA' }, true],
  ])('%s: a snapshot read before it is checked against the saved mode', async (_name, first, then, current) => {
    const f = await fixture(), save = await setupStep(f, { references: false });
    if (first) await save(first);
    const snapshot = await snapshotOf(f);
    await save(then);
    expect(await currentFor(f, snapshot)).toBe(current);
  });
  it('does not count a setup audit written without the mode it replaced', async () => {
    const f = await fixture(), save = await setupStep(f);
    await save({ choice: 'configure', restrictedKey: 'rk_test_SETUPA' });
    const snapshot = await snapshotOf(f);
    await db.forGym(f.gymId, tx => tx.insert(auditEvents).values({ gymId: f.gymId, actorKind: 'system', action: 'setup.stripe_configured',
      targetType: 'gym', targetId: f.gymId, before: null, after: { configured: true, mode: 'live', endpointId: 'we_old', endpointReused: false },
      occurredAt: f.clock.now() }));
    expect(await snapshotOf(f)).toBe(snapshot);
    expect(await currentFor(f, snapshot)).toBe(true);
  });
  // While the gym holds a card the step refuses a key in the other mode, so the setup change a charge run can meet is a removal.
  it('refuses a setup switch to live while the gym holds a card', async () => {
    const f = await fixture(), save = await setupStep(f);
    await save({ choice: 'configure', restrictedKey: 'rk_test_SETUPA' });
    await expect(save({ choice: 'configure', restrictedKey: 'rk_live_SETUPB' })).rejects.toMatchObject({ details: { restrictedKey: ['mode_locked'] } });
  });
  it('reserves nothing with a test provider resolved before a setup removal, and charges with the provider resolved again', async () => {
    const f = await fixture(), bill = await invoice(f), create = vi.spyOn(f.provider, 'createCharge'), save = await setupStep(f);
    await save({ choice: 'configure', restrictedKey: 'rk_test_SETUPA' });
    const { runner, oldCalls, resolutions } = switchingRunner(f, () => save({ choice: 'skip' }));
    expect(await runner.charge(f.gymId, bill.id)).toEqual({ status: 'succeeded' });
    expect(resolutions()).toBe(2);
    for (const call of oldCalls) expect(call).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const state = await f.read();
    expect(state.attempts).toMatchObject([{ attemptNumber: 1, status: 'succeeded' }]);
    expect(state.audits.filter(row => row.action === 'billing.runner.reserved')).toHaveLength(1);
  });
});

describe('reconciliation across a switch from Stripe test mode to live', () => {
  /**
   * Two invoices, each left with a pending attempt whose PaymentIntent the test provider confirmed but whose answer was
   * lost; billing paused and the attempts stale. With `switching`, the first `findCharge` commits a switch before it answers.
   */
  async function twoPending(switching: boolean) {
    const f = await fixture();
    f.provider.keyMode = 'test';
    // One cycle invoice per household and due date: move the first aside before issuing the second.
    const first = await invoice(f);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ dueOn: '2028-02-28', periodStartsOn: '2028-02-28' })
      .where(eq(invoices.id, first.id)));
    const second = await invoice(f);
    for (const bill of [first, second]) {
      f.provider.loseNextResponse('confirmCharge');
      await f.runner.charge(f.gymId, bill.id).catch(() => undefined);
    }
    expect((await f.read()).attempts.map(row => [row.status, !!row.paymentIntentId])).toEqual([['pending', true], ['pending', true]]);
    await f.enable(false);
    f.clock.advance(16 * 60_000);
    const real = f.provider.findCharge.bind(f.provider);
    const find = vi.spyOn(f.provider, 'findCharge');
    if (switching) find.mockImplementationOnce(async (...args) => {
      await db.forGym(f.gymId, tx => tx.insert(auditEvents).values(switchAudit(f)));
      return real(...args);
    });
    const list = vi.spyOn(f.provider, 'listChangesSince');
    return { f, find, list };
  }
  it('ends a restore check at the switch as its incomplete test-mode report, with no further Stripe read', async () => {
    const { f, find, list } = await twoPending(true);
    expect(await f.runner.postRestore(f.gymId, f.clock.now())).toEqual({ inspected: 0, readyForOwnerReview: false,
      issues: [{ kind: 'provider', id: f.gymId, reason: 'provider_or_transition_error' }], stripeConfigured: true, stripeMode: 'test' });
    expect(find).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });
  it('stops the hourly reconciliation at the switch and reports nothing that hour', async () => {
    const { f, find } = await twoPending(true);
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    expect(find).toHaveBeenCalledTimes(1);
    expect((await f.read()).attempts.map(row => row.status)).toEqual(['pending', 'pending']);
  });
  it('publishes no issue for an unknown outcome read while a switch commits, and reads nothing more', async () => {
    const { f, find } = await twoPending(false);
    find.mockImplementationOnce(async reference => {
      await db.forGym(f.gymId, tx => tx.insert(auditEvents).values(switchAudit(f)));
      return { status: 'unknown' as const, reference: { kind: 'charge' as const, id: reference.id } };
    });
    expect(await f.runner.reconcile(f.gymId)).toEqual({ inspected: 0, issues: [] });
    expect(find).toHaveBeenCalledTimes(1);
    expect((await f.read()).attempts.map(row => row.status)).toEqual(['pending', 'pending']);
  });
  it('reads every stale attempt when no switch commits', async () => {
    const { f, find } = await twoPending(false);
    await f.runner.reconcile(f.gymId);
    expect(find).toHaveBeenCalledTimes(2);
  });
  it('carries the snapshot for every provider that does not hold a live key', async () => {
    const f = await fixture(), guarded = stripeWriteScope(db.forGym);
    await db.forGym(f.gymId, tx => tx.insert(auditEvents).values(switchAudit(f)));
    const work = () => guarded(f.gymId, async () => 'written');
    await expect(withProviderWrites({ keyMode: 'live' }, f.gymId, null, work)).resolves.toBe('written');
    await expect(withProviderWrites({ keyMode: 'test' }, f.gymId, null, work)).rejects.toBeInstanceOf(StripeTestModeSwitched);
    await expect(withProviderWrites({}, f.gymId, null, work)).rejects.toBeInstanceOf(StripeTestModeSwitched);
  });
});
