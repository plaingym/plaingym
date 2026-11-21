// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { auditEvents, paymentMethods } from '@plaingym/db';
import { FakeJobs } from '../../infra/jobs/index.js';
import { billingEmailDigest, type ClearedCustomerEmail } from '../../infra/payments/index.js';
import { detachJob } from '../billing/payments.mutations.js';
import { eligibility } from '../billing/runner/eligibility.js';
import { useRunnerFixture } from '../billing/runner/runner.fixture.test-helper.js';
import { billingEmailClearedAction, clearErasedBillingEmail } from './erasure-redaction.js';

const { db, factory, fixture, invoice } = useRunnerFixture();
const secret = 'fixture-retire-erasure-secret';

/**
 * A surviving household of two members: a default debit account `pm_pad` with its mandate, a non-default card
 * `pm_card`, and an open invoice due now. The payer email clear is a stub returning `cleared`.
 */
async function household(cleared: ClearedCustomerEmail) {
  const f = await fixture();
  await factory('members', f.gymId, { householdId: f.home.id });
  const [pad] = await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ processorId: 'pm_pad', type: 'acss_debit',
    mandateId: 'mandate_saved', brand: null, bankName: 'STRIPE TEST BANK', last4: '6789', expiryMonth: null, expiryYear: null }).where(eq(paymentMethods.householdId, f.home.id)).returning());
  const card = await factory('paymentMethods', f.gymId, { householdId: f.home.id, processorId: 'pm_card', isDefault: false });
  const bill = await invoice(f);
  const jobs = new FakeJobs(f.clock);
  const clear = vi.fn(async () => cleared);
  const payload = { householdId: f.home.id, customerId: 'cus_test', emailDigest: billingEmailDigest('payer@example.invalid', secret),
    paymentMethodIds: ['pm_pad', 'pm_card'] };
  const run = () => clearErasedBillingEmail(payload, f.gymId, clear,
    { secret, clock: f.clock, timezone: f.context.timezone, jobs, scope: db.forGym });
  const state = () => db.forGym(f.gymId, async tx => ({
    methods: await tx.select().from(paymentMethods).orderBy(asc(paymentMethods.processorId)),
    revoked: await tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.card.revoked')),
    cleared: await tx.select().from(auditEvents).where(and(eq(auditEvents.action, billingEmailClearedAction), eq(auditEvents.targetId, f.home.id))),
  }));
  return { f, pad: pad!, card, bill, jobs, clear, run, state };
}

it('retires a method left with the placeholder email: revoked, audited and queued for a plain detach, once', async () => {
  const { f, pad, card, bill, jobs, clear, run, state } = await household({ matched: true, placeholderMethods: ['pm_pad'] });
  const gym = await f.settings.get(f.gymId);
  expect(await db.forGym(f.gymId, tx => eligibility(tx, gym, f.clock, bill.id, 'automatic')))
    .toMatchObject({ status: 'eligible', payment: { methodId: 'pm_pad', mandateId: 'mandate_saved' } });
  await run();
  expect(clear).toHaveBeenCalledOnce();
  const after = await state();
  expect(after.methods.find(row => row.id === pad.id)).toMatchObject({ revokedAt: f.clock.now(), isDefault: false, mandateId: 'mandate_saved' });
  expect(after.methods.find(row => row.id === card.id)).toEqual(card);
  expect(after.revoked).toHaveLength(1);
  expect(after.revoked[0]).toMatchObject({ actorKind: 'system', targetType: 'payment_method', targetId: pad.id, after: { reason: 'notice_email_erased' } });
  expect(after.cleared).toHaveLength(1);
  expect(jobs.jobs.map(job => ({ name: job.name, payload: job.payload, key: job.options.idempotencyKey })))
    .toEqual([{ name: detachJob, payload: { paymentMethodId: pad.id }, key: `detach:${pad.id}` }]);

  // A retry of the same payload finds the row revoked: no row change, no revocation audit, no second detach.
  await run();
  const again = await state();
  expect(again.methods).toEqual(after.methods);
  expect(again.revoked).toEqual(after.revoked);
  expect(jobs.jobs).toHaveLength(1);

  // The household now has no saved method: the runner skips the invoice and reserves no attempt.
  expect(await f.runner.charge(f.gymId, bill.id)).toEqual({ status: 'skipped', reason: 'no_saved_card' });
  expect((await f.read()).attempts).toEqual([]);
});

it('never revokes a method of another household or one already revoked', async () => {
  const { f, pad, jobs, run, state } = await household({ matched: true, placeholderMethods: ['pm_other', 'pm_old'] });
  const other = await factory('households', f.gymId);
  await factory('paymentMethods', f.gymId, { householdId: other.id, processorId: 'pm_other', isDefault: true });
  await factory('paymentMethods', f.gymId, { householdId: f.home.id, processorId: 'pm_old', isDefault: false, revokedAt: new Date('2028-01-01T00:00:00Z') });
  const before = await state();
  await run();
  const after = await state();
  expect(after.methods).toEqual(before.methods);
  expect(after.methods.find(row => row.id === pad.id)).toMatchObject({ revokedAt: null, isDefault: true });
  expect(after.revoked).toEqual([]);
  expect(after.cleared).toHaveLength(1);
  expect(jobs.jobs).toEqual([]);
});

it('changes nothing beyond the clear audit when no method holds the placeholder', async () => {
  const { jobs, run, state } = await household({ matched: true, placeholderMethods: [] });
  const before = await state();
  await run();
  const after = await state();
  expect(after.methods).toEqual(before.methods);
  expect(after.revoked).toEqual([]);
  expect(after.cleared).toHaveLength(1);
  expect(jobs.jobs).toEqual([]);
});

it('refuses to run without a job queue, before calling out', async () => {
  const { f, clear, pad } = await household({ matched: true, placeholderMethods: ['pm_pad'] });
  await expect(clearErasedBillingEmail({ householdId: f.home.id, customerId: 'cus_test', emailDigest: billingEmailDigest('payer@example.invalid', secret),
    paymentMethodIds: ['pm_pad'] }, f.gymId, clear, { secret, clock: f.clock, timezone: f.context.timezone, scope: db.forGym }))
    .rejects.toThrow('Billing email erasure is not configured');
  expect(clear).not.toHaveBeenCalled();
  expect((await db.forGym(f.gymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.id, pad.id))))[0]).toMatchObject({ revokedAt: null });
});
