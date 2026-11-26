// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line database/system-tables -- One test holds the gym row and reads backend PIDs to verify promotion waits for an in-flight currency change.
import { and, eq, sql } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- One test locks and updates the gym row the way a settings save does.
import { auditEvents, gyms, paymentMethods, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createPaymentService } from './payments.js';
import { promoteDefaultCard } from './payments.mutations.js';

const db = useTestDatabase(), factory = createFactories(db);
const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`);

async function fixture(currency: string) {
  const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency, billingEnabled: true });
  const household = await factory('households', gymId);
  const context = { gymId, actor: { kind: 'system' as const } };
  const promote = () => db.forGym(gymId, tx => promoteDefaultCard(tx, context, clock, household.id, 'UTC'));
  const rows = () => db.forGym(gymId, tx => tx.select({ id: paymentMethods.id, type: paymentMethods.type,
    isDefault: paymentMethods.isDefault }).from(paymentMethods).where(eq(paymentMethods.householdId, household.id)));
  const defaults = async () => (await rows()).filter(row => row.isDefault).map(row => row.id);
  const audits = () => db.forGym(gymId, tx => tx.select().from(auditEvents).where(and(
    eq(auditEvents.action, 'billing.card.default_changed'), eq(auditEvents.targetType, 'payment_method'))));
  const method = (values: Record<string, unknown>) => factory('paymentMethods', gymId, { householdId: household.id, ...values });
  return { gymId, clock, household, context, promote, rows, defaults, audits, method };
}

describe('default promotion by the gym currency', () => {
  it('leaves an account the currency cannot charge on file without a default or audit', async () => {
    const f = await fixture('CAD');
    const imported = await f.method({ type: 'us_bank_account', last4: '6789', processorId: 'pm_imported',
      processorCreatedAt: at(20) });

    await f.promote();

    expect(await f.rows()).toEqual([{ id: imported.id, type: 'us_bank_account', isDefault: false }]);
    expect(await f.defaults()).toEqual([]);
    expect(await f.audits()).toEqual([]);
  });

  it('promotes the older card over a newer US bank account a CAD gym cannot charge', async () => {
    const f = await fixture('CAD');
    const card = await f.method({ processorId: 'pm_card', processorCreatedAt: at(20) });
    await f.method({ type: 'us_bank_account', last4: '6789', processorId: 'pm_us', processorCreatedAt: at(24) });

    await f.promote();

    expect(await f.defaults()).toEqual([card.id]);
    expect(await f.audits()).toHaveLength(1);
    expect((await f.audits())[0]).toMatchObject({ targetId: card.id, after: { householdId: f.household.id } });
  });

  it('promotes the currency bank type over an older card (CAD PAD, USD bank account)', async () => {
    const cad = await fixture('CAD');
    await cad.method({ processorId: 'pm_card', processorCreatedAt: at(20) });
    const pad = await cad.method({ type: 'acss_debit', mandateId: 'mandate_cad', last4: '6789', processorId: 'pm_pad',
      processorCreatedAt: at(24) });
    await cad.promote();
    expect(await cad.defaults()).toEqual([pad.id]);

    const usd = await fixture('USD');
    await usd.method({ processorId: 'pm_card', processorCreatedAt: at(20) });
    const us = await usd.method({ type: 'us_bank_account', last4: '9876', processorId: 'pm_us', processorCreatedAt: at(24) });
    await usd.promote();
    expect(await usd.defaults()).toEqual([us.id]);
  });

  it('falls back to an expired card when the gym currency has no chargeable bank type', async () => {
    const f = await fixture('GBP');
    await f.method({ type: 'us_bank_account', last4: '6789', processorId: 'pm_us', processorCreatedAt: at(24) });
    await f.method({ type: 'acss_debit', mandateId: 'mandate_cad', last4: '9876', processorId: 'pm_pad',
      processorCreatedAt: at(23) });

    await f.promote();
    expect(await f.defaults()).toEqual([]);

    const expired = await f.method({ processorId: 'pm_expired', expiryMonth: 9, expiryYear: 2026,
      processorCreatedAt: at(1) });
    await f.promote();

    expect(await f.defaults()).toEqual([expired.id]);
    expect(await f.audits()).toHaveLength(1);
  });

  it('never replaces a chosen default, whatever its type', async () => {
    const f = await fixture('CAD');
    const chosen = await f.method({ type: 'us_bank_account', last4: '6789', processorId: 'pm_chosen', isDefault: true,
      processorCreatedAt: at(1) });
    await f.method({ processorId: 'pm_newer_card', processorCreatedAt: at(24) });

    await f.promote();

    expect(await f.defaults()).toEqual([chosen.id]);
    expect(await f.audits()).toEqual([]);
  });

  it('skips a Canadian PAD without a mandate and promotes an older card when removing the default, while keeping mandated PADs and US bank accounts eligible', async () => {
    const f = await fixture('CAD');
    const currentDefault = await f.method({ processorId: 'pm_default', isDefault: true, processorCreatedAt: at(10) });
    const backupCard = await f.method({ processorId: 'pm_card', processorCreatedAt: at(20) });
    await f.method({ type: 'acss_debit', mandateId: null, last4: '6789', processorId: 'pm_pad_no_mandate',
      processorCreatedAt: at(24) });
    const user = await factory('authUser', f.gymId), clock = f.clock;
    const jobs = new FakeJobs(clock), provider = new FakePayments(f.gymId, clock);
    const detachCard = vi.fn(async () => { assertNoTransaction('detachCard'); });
    const service = createPaymentService({ scope: db.forGym, clock, jobs, detachCard, paymentsFor: async () => provider,
      settings: createGymSettingsAccessor({ scope: db.forGym }) });

    await service.revokeCard({ gymId: f.gymId, actor: { kind: 'user', userId: user.id } }, f.household.id, currentDefault.id);

    expect(await f.defaults()).toEqual([backupCard.id]);
    expect(await f.audits()).toHaveLength(1);
    expect((await f.audits())[0]).toMatchObject({ targetId: backupCard.id, after: { householdId: f.household.id } });

    const padOnly = await fixture('CAD');
    await padOnly.method({ type: 'acss_debit', mandateId: null, last4: '1111', processorId: 'pm_pad_only',
      processorCreatedAt: at(24) });
    await padOnly.promote();
    expect(await padOnly.defaults()).toEqual([]);
    expect(await padOnly.audits()).toEqual([]);

    const mandated = await fixture('CAD');
    await mandated.method({ processorId: 'pm_card_cad', processorCreatedAt: at(20) });
    const pad = await mandated.method({ type: 'acss_debit', mandateId: 'mandate_cad', last4: '2222', processorId: 'pm_pad_mandate',
      processorCreatedAt: at(24) });
    await mandated.promote();
    expect(await mandated.defaults()).toEqual([pad.id]);

    const usd = await fixture('USD');
    await usd.method({ processorId: 'pm_card_usd', processorCreatedAt: at(20) });
    const usBank = await usd.method({ type: 'us_bank_account', mandateId: null, last4: '3333', processorId: 'pm_us_bank',
      processorCreatedAt: at(24) });
    await usd.promote();
    expect(await usd.defaults()).toEqual([usBank.id]);
  });

  it('leaves no default when revoking the default card and the only other method is an unchargeable bank account', async () => {
    const f = await fixture('CAD');
    const card = await f.method({ processorId: 'pm_default', isDefault: true, processorCreatedAt: at(20) });
    await f.method({ type: 'us_bank_account', last4: '6789', processorId: 'pm_us', processorCreatedAt: at(24) });
    const user = await factory('authUser', f.gymId), clock = f.clock;
    const jobs = new FakeJobs(clock), provider = new FakePayments(f.gymId, clock);
    const detachCard = vi.fn(async () => { assertNoTransaction('detachCard'); });
    const service = createPaymentService({ scope: db.forGym, clock, jobs, detachCard, paymentsFor: async () => provider,
      settings: createGymSettingsAccessor({ scope: db.forGym }) });

    await service.revokeCard({ gymId: f.gymId, actor: { kind: 'user', userId: user.id } }, f.household.id, card.id);

    expect(await f.defaults()).toEqual([]);
    const auditRows = await db.forGym(f.gymId, tx => tx.select().from(auditEvents));
    expect(auditRows.filter(row => row.action === 'billing.card.revoked')).toHaveLength(1);
    expect(auditRows.filter(row => row.action === 'billing.card.default_changed')).toHaveLength(0);
  });

  it('waits for an in-flight currency change holding the gym row and promotes by the new currency rule', async () => {
    const f = await fixture('USD');
    await f.method({ processorId: 'pm_card', processorCreatedAt: at(20) });
    const pad = await f.method({ type: 'acss_debit', mandateId: 'mandate_cad', last4: '2222', processorId: 'pm_pad', processorCreatedAt: at(22) });
    await f.method({ type: 'us_bank_account', last4: '6789', processorId: 'pm_us', processorCreatedAt: at(24) });

    const locked = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    const holder = db.forGym(f.gymId, async tx => {
      // eslint-disable-next-line database/system-tables -- The holder's backend PID, for the lock-wait probe.
      const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
      await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, f.gymId)).for('update');
      await tx.update(gyms).set({ currency: 'CAD' }).where(eq(gyms.id, f.gymId));
      locked.resolve(pid);
      // Held until the probe below has seen the promotion wait, then released after 200 ms.
      await release.promise;
      await new Promise(resolve => setTimeout(resolve, 200));
    });
    const pid = await locked.promise;

    let finished = false;
    const promoting = f.promote().finally(() => { finished = true; });
    let sawWait = false;
    try {
      const deadline = Date.now() + 5000;
      while (!sawWait && !finished && Date.now() < deadline) {
        // eslint-disable-next-line database/system-tables -- The lock-wait probe.
        sawWait = (await db.system.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`))[0]!.n > 0;
        if (!sawWait) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(sawWait).toBe(true);
      expect(finished).toBe(false);
    } finally {
      release.resolve();
    }
    await Promise.all([holder, promoting]);

    expect(await f.defaults()).toEqual([pad.id]);
    expect(await f.audits()).toHaveLength(1);
    expect((await f.audits())[0]).toMatchObject({ targetId: pad.id, after: { householdId: f.household.id } });
  });
});
