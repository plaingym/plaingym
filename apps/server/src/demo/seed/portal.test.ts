// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { attendances, classBookings, classSessions, gyms, households, invoices, memberRanks, members, memberships, paymentMethods,
  uuidv7, waiverSignatures } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createApp } from '../../core/app.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { FakePayments, type CreateCharge } from '../../infra/payments/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { StripePayments } from '../../infra/payments/stripe.js';
import { createWebhookInbox, webhookDispatchJob } from '../../areas/billing/webhooks/inbox.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import { authConfig } from '../../infra/auth/config.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { createAuthService } from '../../infra/auth/service.js';
import { createCheckinCodeService } from '../../areas/members/checkin-code.js';
import { verifyHouseholdPin } from '../../areas/members/pin.js';
import { createBillingStanding } from '../../areas/billing/kiosk-standing.js';
import { createGymDeleteService } from '../../areas/settings/gym-delete.js';
import { demoBootCheck } from '../config.js';
import { createDemoPayments } from '../payments.js';
import { createDemoIdentities } from '../identities.js';
import { createDemoService } from '../service.js';
import { demoWebhookMiddleware } from '../webhook.js';
import { createSeedCommand } from '../seed-cli.js';
import type { BillingSeedProvider } from './billing-payments.js';
import { runSeeds } from './index.js';
import { demoPin } from './members.js';
import { demoStudent, studentClassesPerWeek, studentPromotions, waitlistClass, waitlistFillers } from './portal.js';

const db = useTestDatabase(), factory = createFactories(db), pinKey = new Uint8Array(32).fill(7);
const baseEnv = { DEMO_MODE: 'true', TENANCY: 'multi', DEMO_DOMAIN: 'demo.example.test',
  APP_ENCRYPTION_KEY: 'cd'.repeat(32), AUTH_SECRET: 'demo-portal-seed-secret-with-more-than-32-characters', AUTH_PASSWORD_LOGIN: 'off' };

// Monday noon: the next Competition Training (Tuesday) is cancelled by the mat seed, so Thursday's holds the waitlist.
function fixture(configured: boolean, clock = new TestClock('2026-10-26T12:00:00Z')) {
  const env = { ...baseEnv, ...(configured ? { DEMO_STRIPE_TEST_KEY: 'rk_test_SYNTHETIC', DEMO_STRIPE_WEBHOOK_SECRET: 'whsec_SYNTHETIC' } : {}) };
  const config = demoBootCheck(env), scope = db.forGym, gateways = new Map<string, BillingSeedProvider>();
  const provider = vi.fn(async (gymId: string) => {
    let gateway = gateways.get(gymId);
    if (gateway) return gateway;
    class TestPayments extends FakePayments {
      override async createCharge(input: CreateCharge) {
        const charge = await super.createCharge(input);
        this.respondNextConfirmation('succeeded');
        return charge;
      }
    }
    const payments = new TestPayments(gymId, clock);
    gateway = { gymId, mode: 'test', payments, async seedCard(customerId) {
      const id = 'pm_' + uuidv7().replaceAll('-', '');
      payments.recordPaymentMethod({ id, customerId, last4: '4242', expiresMonth: 12, expiresYear: 2030 });
      return id;
    } };
    gateways.set(gymId, gateway); return gateway;
  });
  const payments = createDemoPayments({ config, scope, system: db.forSystem, clock, provider });
  const authentication = authConfig(env, true);
  const identities = createDemoIdentities({ config, authConfig: authentication, clock, scope,
    accounts: createAccountService(authentication, () => db.system.db),
    authFactory: options => createAuthService({ ...options, database: () => db.system.db }) });
  const uploads = new Map<string, FakeUploads>();
  const seed: typeof runSeeds = (context, steps) => runSeeds(context, steps, { env, scope, clock, pinSecret: async () => pinKey, log: () => {},
    billingPaymentsFor: payments.forSeed, uploadsFor: async (gymId: string) => {
      if (!uploads.has(gymId)) uploads.set(gymId, new FakeUploads(gymId, clock));
      return uploads.get(gymId)!;
    } });
  const deletion = createGymDeleteService({ clock, scope, system: db.forSystem, removeUploads: async () => {} });
  const service = createDemoService({ config, key: parseEncryptionKey(env.APP_ENCRYPTION_KEY), clock, scope, system: db.forSystem, identities, seed, deletion });
  return { service, seed, clock, provider };
}
async function studentRows(gymId: string) {
  return db.forGym(gymId, async tx => {
    const [home] = await tx.select().from(households).where(eq(households.name, demoStudent.household));
    const [member] = await tx.select().from(members).where(eq(members.householdId, home!.id));
    const bookings = await tx.select({ booking: classBookings, session: classSessions }).from(classBookings)
      .innerJoin(classSessions, eq(classBookings.sessionId, classSessions.id)).where(eq(classBookings.memberId, member!.id));
    return { home: home!, member: member!, bookings,
      visits: await tx.select().from(attendances).where(eq(attendances.memberId, member!.id)),
      promotions: await tx.select().from(memberRanks).where(eq(memberRanks.memberId, member!.id)),
      signatures: await tx.select().from(waiverSignatures).where(eq(waiverSignatures.memberId, member!.id)),
      invoices: await tx.select().from(invoices).where(eq(invoices.householdId, home!.id)),
      cards: await tx.select().from(paymentMethods).where(eq(paymentMethods.householdId, home!.id)),
      memberships: await tx.select().from(memberships).where(eq(memberships.householdId, home!.id)),
      gym: (await tx.select().from(gyms))[0]! };
  });
}

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

it('seeds the student without invoices and leaves billing off when the shared test account is not configured', async () => {
  const f = fixture(false), { gymId } = await f.service.create(), rows = await studentRows(gymId);
  expect(rows.bookings.map(row => row.booking.status).sort()).toEqual(['booked', 'booked', 'waitlisted']);
  expect(rows.promotions).toHaveLength(studentPromotions.length);
  expect(rows.invoices).toEqual([]); expect(rows.memberships).toEqual([]);
  expect(rows.gym.billingEnabled).toBe(false);
}, 60_000);

it('leaves a gym without the demo student alone', async () => {
  const f = fixture(false), { gymId } = await f.service.create();
  const before = await studentRows(gymId);
  await db.forGym(gymId, async tx => {
    await tx.update(households).set({ email: 'someone@example.invalid' }).where(eq(households.id, before.home.id));
    await tx.delete(classBookings).where(and(eq(classBookings.memberId, before.member.id)));
  });
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(await createSeedCommand(db.forGym, f.seed).run([gymId], io)).toBe(0);
  expect((await studentRows(gymId)).bookings).toEqual([]);
}, 60_000);

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

it('finishes the bookings, waitlist place and visits a failed run left unfinished', async () => {
  const f = fixture(false), { gymId } = await f.service.create(), rows = await studentRows(gymId);
  // As if the first run had stopped after one booking and three visits, before the waitlist.
  const [kept] = rows.bookings.filter(row => row.booking.status === 'booked');
  await db.forGym(gymId, async tx => {
    for (const row of rows.bookings) if (row.booking.id !== kept!.booking.id) await tx.delete(classBookings).where(eq(classBookings.id, row.booking.id));
    for (const visit of rows.visits.slice(3)) await tx.delete(attendances).where(eq(attendances.id, visit.id));
  });
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(await createSeedCommand(db.forGym, f.seed).run([gymId], io)).toBe(0);
  const again = await studentRows(gymId);
  expect(again.bookings.map(row => row.booking.status).sort()).toEqual(['booked', 'booked', 'waitlisted']);
  expect(again.bookings.some(row => row.booking.id === kept!.booking.id)).toBe(true);
  expect(again.visits).toHaveLength(4 * studentClassesPerWeek);
}, 90_000);

it('restores the billing switch when the student billing fails, and completes on retry', async () => {
  // A sandbox seeded before the test account was configured, then seeded again with it.
  const unkeyed = fixture(false), { gymId } = await unkeyed.service.create(), keyed = fixture(true, unkeyed.clock);
  const { home } = await studentRows(gymId), gateway = await keyed.provider(gymId), seedCard = gateway.seedCard.bind(gateway);
  const failing = vi.spyOn(gateway, 'seedCard').mockImplementation(async (customerId, householdId, declines) => {
    if (householdId === home.id) throw new Error('Test card unavailable');
    return seedCard(customerId, householdId, declines);
  });
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(await createSeedCommand(db.forGym, keyed.seed).run([gymId], io)).toBe(1);
  const failed = await studentRows(gymId);
  expect(failed.gym.billingEnabled).toBe(false); expect(failed.invoices).toEqual([]);
  failing.mockImplementation(seedCard);
  expect(await createSeedCommand(db.forGym, keyed.seed).run([gymId], io)).toBe(0);
  const again = await studentRows(gymId);
  expect(again.gym.billingEnabled).toBe(true);
  expect(again.cards).toHaveLength(1);
  expect(again.invoices.map(row => row.status)).toEqual(['paid', 'paid', 'paid']);
}, 120_000);
