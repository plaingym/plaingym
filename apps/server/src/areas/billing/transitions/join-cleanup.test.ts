// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, households, invoices, members, memberships, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { FakeUploads } from '../../../infra/storage/index.js';
import { createJoinCleanup } from '../../../public/pages/join.cleanup.js';
import { voidAbandonedJoinInvoice } from './join-cleanup.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), other = uuidv7(), clock = new TestClock('2026-11-10T12:00:00Z');
  await factory('gyms', gymId); await factory('gyms', other);
  const home = await factory('households', gymId), person = await factory('members', gymId, { householdId: home.id, status: 'prospect' });
  const plan = await factory('plans', gymId), membership = await factory('memberships', gymId,
    { householdId: home.id, memberId: person.id, planId: plan.id, status: 'pending' });
  const bill = await factory('invoices', gymId, { householdId: home.id, status: 'open', number: 1 });
  await factory('invoiceLineItems', gymId, { householdId: home.id, invoiceId: bill.id, membershipId: membership.id });
  const uploads = new FakeUploads(gymId, clock), key = `${gymId}/waivers/${person.id}/signatures/${uuidv7()}.png`;
  await uploads.put(key, new Uint8Array([1]), 'image/png');
  async function mark(action: string, after?: unknown) {
    await db.forGym(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action, targetType: 'household', targetId: home.id,
      occurredAt: clock.now(), ...(after === undefined ? {} : { after }) }));
  }
  await mark('public.join.admitted', { memberIds: [person.id], joinedOn: '2026-11-10' });
  await mark('public.join.invoiced', { invoiceId: bill.id });
  const cleanup = createJoinCleanup({ scope: db.forGym, clock, uploadsFor: async () => uploads });
  const voidInvoice = (gym = gymId) => db.forGym(gym, tx => voidAbandonedJoinInvoice(tx, gym, home.id, bill.id, clock));
  const read = () => db.forGym(gymId, async tx => ({ bill: (await tx.select().from(invoices).where(eq(invoices.id, bill.id)))[0],
    people: await tx.select().from(members), memberships: await tx.select().from(memberships), homes: await tx.select().from(households),
    audits: await tx.select().from(auditEvents) }));
  return { gymId, other, clock, home, person, bill, membership, uploads, key, mark, cleanup, voidInvoice, read };
}
it('voids only the abandoned join invoice, removes its prospects and images, and retains accounting', async () => {
  const f = await fixture(); f.clock.advance(2 * 86_400_000);
  const unrelatedHome = await factory('households', f.gymId), unrelated = await factory('invoices', f.gymId, { householdId: unrelatedHome.id, status: 'open', number: 2 });
  expect(await f.cleanup.run(f.gymId, 'UTC')).toBe(1);
  const rows = await f.read();
  expect(rows.bill!.status).toBe('void'); expect(rows.people).toEqual([]); expect(rows.memberships).toEqual([]);
  expect(rows.homes.some(h => h.id === f.home.id)).toBe(true);
  expect(rows.audits.filter(a => a.action === 'billing.invoice.voided')).toHaveLength(1);
  expect((await f.uploads.head(f.key))!.deletedAt).toEqual(f.clock.now());
  expect(await db.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, unrelated.id)))).toMatchObject([{ status: 'open' }]);
  expect(await f.cleanup.run(f.gymId, 'UTC')).toBe(0);
});
it.each(['public.join.submitting', 'public.join.received', 'public.join.completed'])('preserves %s admissions', async action => {
  const f = await fixture(); await f.mark(action); f.clock.advance(2 * 86_400_000);
  expect(await f.voidInvoice()).toBe(false); expect(await f.cleanup.run(f.gymId, 'UTC')).toBe(0);
  expect((await f.read()).bill!.status).toBe('open'); expect(await f.uploads.head(f.key)).not.toBeNull();
});
it.each(['paid', 'processing', 'past_due', 'refunded', 'partially_refunded'])('preserves an invoice in %s state', async status => {
  const f = await fixture();
  await db.forGym(f.gymId, tx => tx.update(invoices).set({ status }).where(eq(invoices.id, f.bill.id)));
  expect(await f.voidInvoice()).toBe(false);
});
it.each(['reservation', 'checkout', 'pending', 'requires_action', 'payment', 'setup'])('preserves unresolved or paid work: %s', async kind => {
  const f = await fixture();
  if (kind === 'reservation' || kind === 'checkout') await db.forGym(f.gymId, tx => tx.update(invoices).set({
    checkoutExpiresAt: new Date('2026-01-01T00:00:00Z'), ...(kind === 'checkout' ? { checkoutSessionId: 'cs_unresolved' } : {}) }).where(eq(invoices.id, f.bill.id)));
  else if (kind === 'payment') await factory('payments', f.gymId, { invoiceId: f.bill.id });
  else if (kind === 'setup') {
    const link = await factory('signedLinks', f.gymId, { householdId: f.home.id });
    await db.forGym(f.gymId, tx => writeAudit(tx, { gymId: f.gymId, actorKind: 'system', targetType: 'signed_link', targetId: link.id,
      action: 'billing.card_setup.started', occurredAt: f.clock.now(), after: { sessionId: 'cs_unknown' } }));
  } else await factory('paymentAttempts', f.gymId, { invoiceId: f.bill.id, status: kind });
  f.clock.advance(2 * 86_400_000);
  expect(await f.voidInvoice()).toBe(false); expect(await f.cleanup.run(f.gymId, 'UTC')).toBe(0);
  expect((await f.read()).bill!.status).toBe('open'); expect(await f.uploads.head(f.key)).not.toBeNull();
});
it('rejects cross-gym invoice IDs and an invoice without its join association', async () => {
  const f = await fixture(); f.clock.advance(2 * 86_400_000);
  expect(await f.voidInvoice(f.other)).toBe(false); expect(await f.cleanup.run(f.other, 'UTC')).toBe(0);
  const home = await factory('households', f.gymId), bill = await factory('invoices', f.gymId, { householdId: home.id, number: 2, status: 'open' });
  expect(await db.forGym(f.gymId, tx => voidAbandonedJoinInvoice(tx, f.gymId, home.id, bill.id, f.clock))).toBe(false);
  expect((await f.read()).bill!.status).toBe('open');
});
it('preserves a review-held invoice even without a processor reference', async () => {
  const f = await fixture();
  await db.forGym(f.gymId, tx => tx.update(invoices).set({ needsReview: true }).where(eq(invoices.id, f.bill.id)));
  expect(await f.voidInvoice()).toBe(false);
});
