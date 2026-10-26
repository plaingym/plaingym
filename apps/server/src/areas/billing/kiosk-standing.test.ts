// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { attendances, invoices, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import { authorize } from '../staff/auth.permissions.js';
import { hashHouseholdPin } from '../members/pin.js';
import { createKioskCheckin } from '../kiosk/standing/checkin.js';
import { createKioskCheckinRoutes } from '../kiosk/standing/standing.routes.js';
import { createBillingStanding } from './kiosk-standing.js';
import { isOverdueInvoice, overdueInvoiceCondition } from './kiosk-standing.rules.js';
import { createInvoiceTransitions } from './transitions/index.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-26T12:00:00Z');
const secret = new Uint8Array(32).fill(3), standing = createBillingStanding(database.forGym);
async function fixture(options: { timezone?: string; invoice?: Partial<typeof invoices.$inferInsert> } = {}) {
  const gymId = uuidv7(); await factory('gyms', gymId, { timezone: options.timezone ?? 'UTC' });
  const id = uuidv7();
  const household = await factory('households', gymId, { id, name: 'River Family', pinHash: hashHouseholdPin(secret, gymId, id, '2468') });
  const member = await factory('members', gymId, { householdId: id, firstName: 'Alex', lastName: 'River', status: 'active' });
  const sibling = await factory('members', gymId, { householdId: id, firstName: 'Kai', lastName: 'River', status: 'active' });
  const invoice = await factory('invoices', gymId, { householdId: household.id, status: 'past_due', number: 1, amountCents: 12345, ...options.invoice });
  return { gymId, member, sibling, invoice };
}
async function kiosk(f: Awaited<ReturnType<typeof fixture>>) {
  const device = await factory('kioskDevices', f.gymId);
  const service = createKioskCheckin({ scope: database.forGym, clock, pinSecret: async () => secret });
  const app = createApp({ clock, authorize, skipSetup: true,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'kiosk', gymId: f.gymId, deviceId: device.id } }); await next(); },
    contributions: { routes: createKioskCheckinRoutes(service) },
  });
  return (memberId = f.member.id, name = 'Alex River') => app.request('/api/kiosk/checkin', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin: '2468', checkins: [{ memberId, sessionId: null }] }) });
}
describe('past-due kiosk standing', () => {
  it('checks the household, isolates households and gyms, and clears after settlement', async () => {
    const a = await fixture(), b = await fixture();
    for (const member of [a.member, a.sibling]) expect(await standing.check({ gymId: a.gymId, memberId: member.id, clock })).toEqual({ status: 'front_desk', reasonCode: 'past_due' });
    const other = await factory('members', a.gymId);
    expect(await standing.check({ gymId: a.gymId, memberId: other.id, clock })).toEqual({ status: 'ok' });
    expect(await standing.check({ gymId: a.gymId, memberId: b.member.id, clock })).toEqual({ status: 'front_desk', reasonCode: 'unavailable' });
    await database.forGym(a.gymId, tx => tx.update(invoices).set({ status: 'paid' }).where(eq(invoices.id, a.invoice.id)));
    expect(await standing.check({ gymId: a.gymId, memberId: a.member.id, clock })).toEqual({ status: 'ok' });
    expect(await standing.check({ gymId: b.gymId, memberId: b.member.id, clock })).toHaveProperty('status', 'front_desk');
  });
  it('returns only the neutral kiosk result, records no visit, and reveals no debt or sibling data', async () => {
    const f = await fixture(), checkin = await kiosk(f), response = await checkin();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ status: 'see_front_desk' }] });
    expect(await database.forGym(f.gymId, tx => tx.select().from(attendances))).toHaveLength(0);
  });
  for (const kind of ['assignment', 'manual'] as const) it(`blocks an overdue open ${kind} invoice after a declined charge, including a review hold`, async () => {
    const f = await fixture({ invoice: { kind: 'one_off', status: 'open', dueOn: '2026-10-25', needsReview: true } });
    await factory('invoiceLineItems', f.gymId, { householdId: f.member.householdId, invoiceId: f.invoice.id,
      kind: kind === 'assignment' ? 'signup_fee' : 'charge', amountCents: f.invoice.amountCents });
    const attempt = await factory('paymentAttempts', f.gymId, { invoiceId: f.invoice.id, paymentIntentId: 'pi_declined' });
    await createInvoiceTransitions({ scope: database.forGym, clock }).cardFailed({ gymId: f.gymId, actor: { kind: 'system' } },
      { invoiceId: f.invoice.id, attemptId: attempt.id, paymentIntentId: 'pi_declined', outcome: 'failed' });
    expect((await database.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, f.invoice.id))))[0]!.status).toBe('open');
    expect(await standing.check({ gymId: f.gymId, memberId: f.member.id, clock })).toEqual({ status: 'front_desk', reasonCode: 'past_due' });
    const response = await (await kiosk(f))();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ status: 'see_front_desk' }] });
    expect(await database.forGym(f.gymId, tx => tx.select().from(attendances))).toHaveLength(0);
  });
  for (const scenario of [
    { name: 'open due today', timezone: 'UTC', status: 'open', dueOn: '2026-10-26', amountCents: 100, blocked: false },
    { name: 'open due yesterday locally but today in UTC', timezone: 'Pacific/Auckland', status: 'open', dueOn: '2026-10-26', amountCents: 100, blocked: true },
    { name: 'zero past-due balance', timezone: 'UTC', status: 'past_due', dueOn: '2026-10-25', amountCents: 0, blocked: false },
    { name: 'zero open overdue balance', timezone: 'UTC', status: 'open', dueOn: '2026-10-25', amountCents: 0, blocked: false },
  ]) it(`uses the same standing and route decision for ${scenario.name}`, async () => {
    const f = await fixture({ timezone: scenario.timezone, invoice: { status: scenario.status, dueOn: scenario.dueOn, amountCents: scenario.amountCents } });
    expect(await standing.check({ gymId: f.gymId, memberId: f.member.id, clock })).toHaveProperty('status', scenario.blocked ? 'front_desk' : 'ok');
    const response = await (await kiosk(f))();
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].status).toBe(scenario.blocked ? 'see_front_desk' : 'checked_in');
  });
  it('keeps other households and gyms unaffected by an overdue open invoice', async () => {
    const a = await fixture({ invoice: { status: 'open', dueOn: '2026-10-25' } });
    const b = await fixture({ invoice: { status: 'open', dueOn: '2026-10-26' } });
    const homeId = uuidv7();
    await factory('households', a.gymId, { id: homeId, pinHash: hashHouseholdPin(secret, a.gymId, homeId, '2468') });
    const other = await factory('members', a.gymId, { householdId: homeId, firstName: 'Other', lastName: 'Family', status: 'active' });
    expect(await standing.check({ gymId: a.gymId, memberId: other.id, clock })).toEqual({ status: 'ok' });
    expect(await standing.check({ gymId: b.gymId, memberId: b.member.id, clock })).toEqual({ status: 'ok' });
    const checkinB = await kiosk(b);
    expect((await (await checkinB()).json()).data[0].status).toBe('checked_in');
    // A caller cannot select a member from another household or gym using this family's PIN.
    const checkin = await kiosk(a);
    expect((await (await checkin(other.id, 'Other Family')).json()).data[0].status).toBe('checked_in');
    for (const memberId of [other.id, b.member.id]) expect(await (await checkin(memberId)).json()).toEqual({ data: [{ status: 'see_front_desk' }] });
  });
  it('keeps the SQL and in-memory overdue rules identical for every status, date and balance', async () => {
    const f = await fixture();
    let number = 1;
    for (const status of ['draft', 'open', 'processing', 'past_due', 'paid', 'void', 'partially_refunded', 'refunded'])
      for (const dueOn of ['2026-10-25', '2026-10-26', '2026-10-27']) for (const amountCents of [0, 100])
        await factory('invoices', f.gymId, { householdId: f.member.householdId, status, number: status === 'draft' ? null : ++number, dueOn, amountCents });
    const [all, overdue] = await database.forGym(f.gymId, async tx => [await tx.select().from(invoices),
      await tx.select().from(invoices).where(overdueInvoiceCondition('2026-10-26'))]);
    expect(overdue.map(row => row.id).sort()).toEqual(all.filter(row => isOverdueInvoice(row, '2026-10-26')).map(row => row.id).sort());
  });
  it('ignores zero balances, void and paid invoices', async () => {
    const f = await fixture();
    for (const update of [{ amountCents: 0 }, { status: 'void', amountCents: 12345 }, { status: 'paid' }]) {
      await database.forGym(f.gymId, tx => tx.update(invoices).set(update).where(eq(invoices.id, f.invoice.id)));
      expect(await standing.check({ gymId: f.gymId, memberId: f.member.id, clock })).toEqual({ status: 'ok' });
    }
  });
});
