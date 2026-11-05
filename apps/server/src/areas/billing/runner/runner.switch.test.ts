// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line database/system-tables -- One test reads backend PIDs to see a reservation wait on the gym row lock.
import { eq, sql } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- One test holds the gym row the way a settings save does.
import { auditEvents, gyms } from '@plaingym/db';
import { FakePayments } from '../../../infra/payments/index.js';
import { stripeTestClearedAction } from '../customers.js';
import { createChargeRunner } from './index.js';
import { useRunnerFixture, type Fixture } from './runner.fixture.test-helper.js';

const { db, fixture, invoice } = useRunnerFixture();

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
  it('charges as before when no switch commits during the run', async () => {
    const f = await fixture(), bill = await invoice(f);
    await db.forGym(f.gymId, tx => tx.insert(auditEvents).values(switchAudit(f)));
    const resolve = vi.fn(async () => f.provider);
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments: resolve });
    expect(await runner.charge(f.gymId, bill.id)).toEqual({ status: 'succeeded' });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
