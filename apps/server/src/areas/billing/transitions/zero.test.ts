// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, invoices, payments, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { FakeInvoiceTransitions } from '../../../core/interfaces/invoice-transitions.js';
import { createInvoiceTransitions } from './index.js';
import { snapshot, effectCreated } from './store.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(status = 'open', amountCents = 0) {
  const gymId = uuidv7(), clock = new TestClock('2028-03-01T17:00:00Z');
  await factory('gyms', gymId);
  const invoice = await factory('invoices', gymId, { status, amountCents, number: status === 'draft' ? null : 1 });
  const context = { gymId, actor: { kind: 'system' as const } };
  return { gymId, clock, invoice, context, transitions: createInvoiceTransitions({ scope: db.forGym, clock }) };
}
it.each(['open', 'past_due'])('settles %s zero invoices atomically and ignores concurrent/repeated settlement', async status => {
  const f = await fixture(status), request = { invoiceId: f.invoice.id };
  const result = await Promise.all([f.transitions.settleZero(f.context, request), f.transitions.settleZero(f.context, request)]);
  expect(result.map(item => item.outcome).sort()).toEqual(['applied', 'ignored']);
  expect((await f.transitions.settleZero(f.context, request)).outcome).toBe('ignored');
  await db.forGym(f.gymId, async tx => {
    expect(await tx.select().from(payments)).toHaveLength(0);
    expect((await tx.select().from(invoices))[0]).toMatchObject({ status: 'paid', paidAt: f.clock.now() });
    const events = await tx.select().from(auditEvents);
    expect(events.filter(row => row.action === 'billing.invoice.settled_zero')).toHaveLength(1);
    expect(events.filter(row => row.action === effectCreated).map(row => row.after)).toEqual([{ kind: 'activate_memberships', invoiceId: f.invoice.id }]);
  });
  const fake = new FakeInvoiceTransitions([{ gymId: f.gymId, invoice: snapshot(f.invoice) }], [], f.clock);
  expect(await fake.settleZero(f.context, request)).toEqual(result.find(item => item.outcome === 'applied'));
  expect((await fake.settleZero(f.context, request)).outcome).toBe('ignored');
  expect(fake.payments).toHaveLength(0); expect(fake.effects).toHaveLength(1);
});
it.each(['draft', 'void', 'processing'])('refuses zero settlement of %s invoices', async status => {
  const f = await fixture(status);
  await expect(f.transitions.settleZero(f.context, { invoiceId: f.invoice.id })).rejects.toThrow();
  expect((await db.forGym(f.gymId, tx => tx.select().from(invoices)))[0]!.status).toBe(status);
});
it('refuses non-zero invoices and accepted payments, and isolates gyms', async () => {
  const nonzero = await fixture('open', 100);
  await expect(nonzero.transitions.settleZero(nonzero.context, { invoiceId: nonzero.invoice.id })).rejects.toThrow('zero');
  const zero = await fixture();
  await factory('payments', zero.gymId, { invoiceId: zero.invoice.id, amountCents: 100 });
  await expect(zero.transitions.settleZero(zero.context, { invoiceId: zero.invoice.id })).rejects.toThrow('accepted');
  await expect(zero.transitions.settleZero(nonzero.context, { invoiceId: zero.invoice.id })).rejects.toThrow();
  expect((await db.forGym(zero.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, zero.invoice.id))))[0]!.status).toBe('open');
});
