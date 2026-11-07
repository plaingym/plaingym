// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, invoices, paymentAttempts, payments } from '@plaingym/db';
import { createFactories } from '@plaingym/db/testing/factories';
import { FakePayments } from '../../infra/payments/index.js';
import { createChargeRunner } from '../../areas/billing/runner/index.js';
import { nextRetryDeadline, retryDeadlines } from '../../areas/billing/runner/eligibility.js';
import { createInvoiceTransitions } from '../../areas/billing/transitions/index.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import { createSeedCommand } from '../seed-cli.js';
import { studentRows, useUnconfiguredSandbox } from './portal.fixture.test-helper.js';

const { db, fixture } = useUnconfiguredSandbox(), factory = createFactories(db);
async function failedStudent(retryDays = [3, 7]) {
  const { gymId } = db.seeded, f = fixture(true), gateway = await f.provider(gymId), { home } = await studentRows(db, gymId);
  await db.forGym(gymId, tx => tx.update(gyms).set({ retryDays }).where(eq(gyms.id, gymId)));
  const processor = gateway.payments;
  if (!(processor instanceof FakePayments)) throw new Error('Expected fake payments');
  const create = processor.createCharge.bind(processor);
  let fail = true;
  const creates = vi.spyOn(processor, 'createCharge').mockImplementation(async input => {
    const intent = await create(input);
    const [row] = await db.forGym(gymId, tx => tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)));
    if (fail && row!.householdId === home.id) processor.respondNextConfirmation('declined');
    return intent;
  });
  const command = createSeedCommand(db.forGym, f.seed), io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(await command.run([gymId], io)).toBe(1);
  fail = false;
  const invoice = (await studentRows(db, gymId)).invoices.find(row => row.status === 'past_due')!;
  const scope = db.forGym, clock = f.clock, settings = createGymSettingsAccessor({ scope, clock }), gym = await settings.get(gymId);
  const runner = createChargeRunner({ scope, clock, settings, transitions: createInvoiceTransitions({ scope, clock }),
    payments: async () => processor, jobs: { async enqueue() { throw new Error('Unexpected job'); } } });
  return { f, gymId, invoice, processor, creates, command, io, runner, gym };
}

it('reconciles a lost seed retry response after the normal stale interval, with no future records or duplicate charge', async () => {
  const { f, gymId, invoice, processor, creates, command, io, runner } = await failedStudent();
  processor.loseNextResponse('confirmCharge');
  expect(await command.run([gymId], io)).toBe(1);
  const count = creates.mock.calls.length;
  const attempts = () => db.forGym(gymId, tx => tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoice.id)));
  expect((await attempts()).filter(row => row.status === 'pending')).toHaveLength(1);
  expect((await attempts()).every(row => row.createdAt <= f.clock.now())).toBe(true);
  expect(await command.run([gymId], io)).toBe(1);
  expect(creates).toHaveBeenCalledTimes(count);
  f.clock.advance(16 * 60_000);
  expect(await runner.reconcile(gymId)).toMatchObject({ inspected: 1, issues: [] });
  expect(await command.run([gymId], io)).toBe(0);
  expect(creates).toHaveBeenCalledTimes(count);
  expect((await attempts()).map(row => row.status).sort()).toEqual(['failed', 'succeeded']);
  const dated = await db.forGym(gymId, async tx => ({ paid: await tx.select().from(payments), audit: await tx.select().from(auditEvents) }));
  expect(dated.paid.every(row => row.createdAt <= f.clock.now() && row.paidAt <= f.clock.now())).toBe(true);
  expect(dated.audit.every(row => row.occurredAt <= f.clock.now())).toBe(true);
}, 90_000);

it('leaves retry windows available after two abandoned creates and consumes them only on a real attempt', async () => {
  const { f, gymId, invoice, creates, command, io, gym } = await failedStudent([1, 2]);
  // Both saved windows have arrived within this sandbox's lifetime: the first failure was two days ago.
  const deadlines = await db.forGym(gymId, tx => retryDeadlines(tx, gym, invoice.id));
  expect(deadlines).toHaveLength(2);
  expect(deadlines.every(date => date <= f.clock.now())).toBe(true);
  for (const [index, date] of deadlines.entries()) await factory('paymentAttempts', gymId, { invoiceId: invoice.id,
    currency: invoice.currency, amountCents: invoice.amountCents, attemptNumber: index + 2, status: 'failed',
    declineCode: 'create_abandoned', createdAt: date, resolvedAt: date });
  expect(await db.forGym(gymId, tx => nextRetryDeadline(tx, gym, invoice.id))).toEqual(deadlines[0]);
  const before = creates.mock.calls.length;
  expect(await command.run([gymId], io)).toBe(0);
  expect(creates).toHaveBeenCalledTimes(before + 1);
  const rows = await db.forGym(gymId, tx => tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoice.id)));
  expect(rows).toHaveLength(4);
  expect(rows.find(row => row.attemptNumber === 4)).toMatchObject({ status: 'succeeded', createdAt: f.clock.now() });
  expect(await db.forGym(gymId, tx => nextRetryDeadline(tx, gym, invoice.id))).toBeUndefined();
}, 90_000);

it('requires reconciliation after the retry schedule is exhausted', async () => {
  const { f, gymId, creates } = await failedStudent([]);
  const before = creates.mock.calls.length;
  await expect(f.seed({ gymId, timezone: 'UTC', enabledModules: new Set() })).rejects.toThrow(/reconciliation/);
  expect(creates).toHaveBeenCalledTimes(before);
});
