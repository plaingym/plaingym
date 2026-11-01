// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { attendances, classBookings, classSessions, households } from '@plaingym/db';
import { createSeedCommand } from '../seed-cli.js';
import { studentRows, useUnconfiguredSandbox } from './portal.fixture.test-helper.js';
import { studentClassesPerWeek, studentPromotions, waitlistClass } from './portal.js';

// One sandbox, created without the shared test account, that every test below starts from in its own copy of the
// database. The reruns that configure billing are in `portal.reruns.billing.test.ts` and `portal.reruns.failure.test.ts`,
// which each seed their own copy, so no file passes a minute under full-suite load.
const { db, fixture } = useUnconfiguredSandbox();

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
});
