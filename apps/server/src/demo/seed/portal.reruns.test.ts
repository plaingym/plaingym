// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { attendances, classBookings, classSessions, households } from '@plaingym/db';
import { setLogSink } from '../../core/log.js';
import * as goLive from '../../areas/settings/go-live.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createSeedCommand } from '../seed-cli.js';
import { portalFixture, studentRows } from './portal.fixture.test-helper.js';
import { studentClassesPerWeek, studentPromotions, waitlistClass } from './portal.js';
import { useSeededDatabase } from './seeded-database.test-helper.js';

// One sandbox, created without the shared test account, that every test below starts from in its own copy of the
// database. The sandbox's uploads live in memory, so the tests share them (the seeds only write them once, and no
// test below changes them).
const uploads = new Map<string, FakeUploads>();
const db = useSeededDatabase(async database => {
  const { gymId } = await portalFixture(database, false, undefined, uploads).service.create();
  return { gymId };
});
const fixture = (configured: boolean, clock?: Parameters<typeof portalFixture>[2]) => portalFixture(db, configured, clock, uploads);

describe('demo portal seed on a sandbox seeded without the test account', { timeout: 90_000 }, () => {
  it('seeds the student without invoices and leaves billing off when the shared test account is not configured', async () => {
    const rows = await studentRows(db, db.seeded.gymId);
    expect(rows.bookings.map(row => row.booking.status).sort()).toEqual(['booked', 'booked', 'waitlisted']);
    expect(rows.promotions).toHaveLength(studentPromotions.length);
    expect(rows.invoices).toEqual([]); expect(rows.memberships).toEqual([]);
    expect(rows.gym.billingEnabled).toBe(false);
  });

  it('leaves a gym without the demo student alone', async () => {
    const f = fixture(false), { gymId } = db.seeded;
    const before = await studentRows(db, gymId);
    await db.forGym(gymId, async tx => {
      await tx.update(households).set({ email: 'someone@example.invalid' }).where(eq(households.id, before.home.id));
      await tx.delete(classBookings).where(and(eq(classBookings.memberId, before.member.id)));
    });
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(await createSeedCommand(db.forGym, f.seed).run([gymId], io)).toBe(0);
    expect((await studentRows(db, gymId)).bookings).toEqual([]);
  });

  it('finishes the bookings, waitlist place and visits a failed run left unfinished', async () => {
    const f = fixture(false), { gymId } = db.seeded, rows = await studentRows(db, gymId);
    // As if the first run had stopped after one booking and three visits, before the waitlist.
    const [kept] = rows.bookings.filter(row => row.booking.status === 'booked');
    await db.forGym(gymId, async tx => {
      for (const row of rows.bookings) if (row.booking.id !== kept!.booking.id) await tx.delete(classBookings).where(eq(classBookings.id, row.booking.id));
      for (const visit of rows.visits.slice(3)) await tx.delete(attendances).where(eq(attendances.id, visit.id));
    });
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(await createSeedCommand(db.forGym, f.seed).run([gymId], io)).toBe(0);
    const again = await studentRows(db, gymId);
    expect(again.bookings.map(row => row.booking.status).sort()).toEqual(['booked', 'booked', 'waitlisted']);
    expect(again.bookings.some(row => row.booking.id === kept!.booking.id)).toBe(true);
    expect(again.visits).toHaveLength(4 * studentClassesPerWeek);
  });

  it('restores the billing switch when the student billing fails, and completes on retry', async () => {
    // A sandbox seeded before the test account was configured, then seeded again with it.
    const { gymId } = db.seeded, keyed = fixture(true);
    const { home } = await studentRows(db, gymId), gateway = await keyed.provider(gymId), seedCard = gateway.seedCard.bind(gateway);
    const failing = vi.spyOn(gateway, 'seedCard').mockImplementation(async (customerId, householdId, declines) => {
      if (householdId === home.id) throw new Error('Test card unavailable');
      return seedCard(customerId, householdId, declines);
    });
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(await createSeedCommand(db.forGym, keyed.seed).run([gymId], io)).toBe(1);
    const failed = await studentRows(db, gymId);
    expect(failed.gym.billingEnabled).toBe(false); expect(failed.invoices).toEqual([]);
    failing.mockImplementation(seedCard);
    expect(await createSeedCommand(db.forGym, keyed.seed).run([gymId], io)).toBe(0);
    const again = await studentRows(db, gymId);
    expect(again.gym.billingEnabled).toBe(true);
    expect(again.cards).toHaveLength(1);
    expect(again.invoices.map(row => row.status)).toEqual(['paid', 'paid', 'paid']);
  });

  it('fails rather than shrinking another class when the waitlist class is missing, and needs it only for a missing place', async () => {
    const f = fixture(false), { gymId } = db.seeded, rows = await studentRows(db, gymId);
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    // No Competition Training ahead: with the student's places already held, a rerun still succeeds.
    await db.forGym(gymId, tx => tx.update(classSessions).set({ status: 'cancelled' }).where(eq(classSessions.name, waitlistClass)));
    expect(await createSeedCommand(db.forGym, f.seed).run([gymId], io)).toBe(0);
    // Without the waitlist place, the step fails and leaves every other class's capacity alone.
    const waitlisted = rows.bookings.find(row => row.booking.status === 'waitlisted')!;
    await db.forGym(gymId, tx => tx.delete(classBookings).where(eq(classBookings.id, waitlisted.booking.id)));
    const capacities = () => db.forGym(gymId, tx => tx.select({ id: classSessions.id, capacity: classSessions.capacity }).from(classSessions));
    const before = await capacities();
    expect(await createSeedCommand(db.forGym, f.seed).run([gymId], io)).toBe(1);
    expect(await capacities()).toEqual(before);
    expect((await studentRows(db, gymId)).bookings.map(row => row.booking.status)).toEqual(['booked', 'booked']);
  });

  it('reports the student billing failure, not a failing switch restore', async () => {
    const { gymId } = db.seeded, keyed = fixture(true);
    const { home } = await studentRows(db, gymId), gateway = await keyed.provider(gymId), seedCard = gateway.seedCard.bind(gateway);
    let studentFailed = false;
    vi.spyOn(gateway, 'seedCard').mockImplementation(async (customerId, householdId, declines) => {
      if (householdId === home.id) { studentFailed = true; throw Object.assign(new Error('Test card unavailable'), { code: 'TEST_CARD_DOWN' }); }
      return seedCard(customerId, householdId, declines);
    });
    // The portal seed's restore fails too (the billing seed's own restore, earlier, works); the seed's own failure must
    // still be the one reported.
    const create = goLive.createGoLiveService;
    const spy = vi.spyOn(goLive, 'createGoLiveService').mockImplementation(options => {
      const service = create(options);
      return { ...service, async update(context, input) {
        if (studentFailed && input.billingEnabled === false) throw Object.assign(new Error('Switch unavailable'), { code: 'RESTORE_DOWN' });
        return service.update(context, input);
      } };
    });
    const logs: string[] = [], previous = setLogSink(line => logs.push(line));
    try {
      expect(await createSeedCommand(db.forGym, keyed.seed).run([gymId], { stdout: vi.fn(), stderr: vi.fn() })).toBe(1);
    } finally { setLogSink(previous); spy.mockRestore(); }
    const events = logs.map(line => JSON.parse(line) as { event: string; step?: string; error?: { code?: string } });
    expect(events.find(entry => entry.event === 'demo.seed_failed')).toMatchObject({ step: 'portal', error: { code: 'TEST_CARD_DOWN' } });
    expect(events.find(entry => entry.event === 'demo.portal.billing_restore_failed')).toMatchObject({ gymId, error: { code: 'RESTORE_DOWN' } });
  });
});
