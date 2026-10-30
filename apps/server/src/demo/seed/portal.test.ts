// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { classBookings, gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createApp } from '../../core/app.js';
import { StripePayments } from '../../infra/payments/stripe.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { createWebhookInbox, webhookDispatchJob } from '../../areas/billing/webhooks/inbox.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import { createCheckinCodeService } from '../../areas/members/checkin-code.js';
import { verifyHouseholdPin } from '../../areas/members/pin.js';
import { createBillingStanding } from '../../areas/billing/kiosk-standing.js';
import { demoBootCheck } from '../config.js';
import { createDemoPayments } from '../payments.js';
import { demoWebhookMiddleware } from '../webhook.js';
import { createSeedCommand } from '../seed-cli.js';
import { demoPin } from './members.js';
import { baseEnv, pinKey, portalFixture, studentRows as rowsOf } from './portal.fixture.test-helper.js';
import { demoStudent, studentClassesPerWeek, studentPromotions, waitlistClass, waitlistFillers } from './portal.js';

const db = useTestDatabase(), factory = createFactories(db);
const fixture = (configured: boolean) => portalFixture(db, configured);
const studentRows = (gymId: string) => rowsOf(db, gymId);

it('gives the sandbox student bookings, a waitlist place, rank progress, paid invoices and a QR code, once', async () => {
  const f = fixture(true), { gymId } = await f.service.create(), rows = await studentRows(gymId);
  expect(rows.member).toMatchObject({ firstName: demoStudent.firstName, lastName: demoStudent.lastName, status: 'active' });
  expect(verifyHouseholdPin(pinKey, gymId, rows.home.id, demoPin, rows.home.pinHash)).toBe(true);
  expect(rows.signatures).toHaveLength(1);

  // Two booked classes ahead of the cancellation cutoff, booked by the student's own login.
  const booked = rows.bookings.filter(row => row.booking.status === 'booked');
  expect(booked).toHaveLength(2);
  expect(booked.every(row => row.booking.bookedByKind === 'member' && row.session.startsAt.getTime() > f.clock.now().getTime() + 3_600_000)).toBe(true);
  const [waiting] = rows.bookings.filter(row => row.booking.status === 'waitlisted');
  expect(waiting).toMatchObject({ booking: { waitlistPosition: 1, bookedByKind: 'member' }, session: { name: waitlistClass, capacity: waitlistFillers.length, status: 'scheduled' } });
  const queue = await db.forGym(gymId, tx => tx.select().from(classBookings).where(eq(classBookings.sessionId, waiting!.session.id)));
  expect(queue.filter(row => row.status === 'booked')).toHaveLength(waitlistFillers.length);
  expect(queue.every(row => row.status === 'booked' ? row.bookedByKind === 'staff' : row.memberId === rows.member.id)).toBe(true);

  // Rank progress: every visit counts toward the next stripe (the portal's criteria are checked through the runtime).
  expect(rows.promotions).toHaveLength(studentPromotions.length);
  expect(rows.visits).toHaveLength(4 * studentClassesPerWeek);
  const latest = Math.max(...rows.promotions.map(row => row.promotedAt.getTime()));
  expect(rows.visits.every(row => row.occurredAt.getTime() > latest && row.source === 'kiosk')).toBe(true);

  // Three monthly periods, all paid; billing stays on so the public join page is open.
  expect(rows.invoices.map(row => row.status)).toEqual(['paid', 'paid', 'paid']);
  expect(rows.cards).toMatchObject([{ isDefault: true, revokedAt: null }]);
  expect(rows.memberships).toMatchObject([{ memberId: rows.member.id, status: 'active' }]);
  expect(rows.gym.billingEnabled).toBe(true);
  expect(await createBillingStanding(db.forGym).check({ gymId, memberId: rows.member.id, clock: f.clock })).toEqual({ status: 'ok' });

  // A QR code the kiosk resolves within this gym only.
  const codes = createCheckinCodeService({ scope: db.forGym, clock: f.clock, gymKey: async () => pinKey });
  const { code } = await codes.read(gymId, rows.member.id);
  expect(code).toMatch(/^pgci1_/);
  expect(await codes.resolve(gymId, code!)).toBe(rows.member.id);
  // A second sandbox from the same service needs its own student and QR key.
  const other = await f.service.create();
  expect(await codes.resolve(other.gymId, code!)).toBeNull();
  expect((await studentRows(other.gymId)).member.id).not.toBe(rows.member.id);

  // The seed command repeats nothing, even on a later day, and leaves billing to the gym once seeded.
  await db.forGym(gymId, tx => tx.update(gyms).set({ billingEnabled: false }).where(eq(gyms.id, gymId)));
  // Past midnight, still inside the sandbox's 24 hours.
  f.clock.advance(13 * 3_600_000);
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  const status = await createSeedCommand(db.forGym, f.seed).run([gymId], io);
  expect(io.stderr.mock.calls).toEqual([]); expect(status).toBe(0);
  const again = await studentRows(gymId);
  for (const part of ['bookings', 'visits', 'promotions', 'signatures', 'invoices', 'cards', 'memberships'] as const)
    expect(again[part]).toHaveLength(rows[part].length);
  expect(again.gym.billingEnabled).toBe(false);
  expect((await codes.read(gymId, rows.member.id)).code).toBe(code);
}, 120_000);

it('routes a join Checkout completion from the shared test account to its own sandbox with the real Stripe adapter', async () => {
  const clock = new TestClock('2026-10-26T12:00:00Z'), secret = 'whsec_SYNTHETIC', joined = uuidv7(), neighbour = uuidv7();
  for (const gymId of [neighbour, joined]) await factory('gyms', gymId, { settings: { demo: { sandbox: true, ready: true, expiresAt: '2026-10-27T12:00:00Z' } } });
  const config = demoBootCheck({ ...baseEnv, DEMO_STRIPE_TEST_KEY: 'rk_test_SYNTHETIC', DEMO_STRIPE_WEBHOOK_SECRET: secret });
  const transport = { request: vi.fn(async () => { throw new Error('Unexpected network lookup'); }) };
  const payments = createDemoPayments({ config, scope: db.forGym, system: db.forSystem, clock, provider: async gymId => ({
    gymId, mode: 'test', payments: new StripePayments(gymId, { transport, webhookSecret: secret, mode: 'test', clock }),
    async seedCard() { throw new Error('No card seeding during webhooks'); },
  }) });
  const queue = new PostgresJobs({ clock, database: db });
  const inbox = createWebhookInbox({ paymentsFor: payments.paymentsFor, jobs: queue, gymSettings: createGymSettingsAccessor({ scope: db.forGym, clock }),
    clock, scope: db.forGym, system: db.forSystem });
  const completed = vi.fn(async () => {});
  inbox.register('checkout.session.completed', completed);
  queue.handle(webhookDispatchJob, inbox.dispatch);
  const tenant = vi.fn(async () => { throw new Error('Install webhook reached tenant middleware'); });
  const app = createApp({ resolveGym: tenant, session: tenant, authorize: () => tenant, clock,
    restoreGate: demoWebhookMiddleware({ configured: true, inbox, demoGyms: payments.demoGyms }) });
  // The shape Stripe sends for a paid join: a payment-mode session carrying the gym metadata the adapter set on it.
  const body = JSON.stringify({ id: 'evt_join', object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: {
    id: 'cs_test_join', object: 'checkout.session', mode: 'payment', payment_status: 'paid', metadata: { gym_id: joined, invoice_id: uuidv7() } } } });
  const timestamp = Math.floor(clock.now().getTime() / 1000);
  const response = await app.request('https://demo.example.test/webhooks/stripe', { method: 'POST', body,
    headers: { 'stripe-signature': `t=${timestamp},v1=${createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex')}` } });
  expect(response.status).toBe(200);
  while (await queue.runNext()) { /* Dispatch the stored event. */ }
  expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'evt_join', gymId: joined, objectId: 'cs_test_join', objectKind: 'checkout' }),
    expect.objectContaining({ gymId: joined }));
  await expect(inbox.replay(neighbour, 'evt_join')).rejects.toMatchObject({ code: 'not_found' });
  expect(transport.request).not.toHaveBeenCalled(); expect(tenant).not.toHaveBeenCalled();
});
