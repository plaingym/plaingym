// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { attendances, classBookings, classSessions, gyms, households, invoices, memberRanks, members, memberships, paymentMethods,
  waiverSignatures } from '@plaingym/db';
import { TestClock } from '../../core/clock.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { demoServiceFixture } from '../demo-service.test-helper.js';
import { demoStudent } from './portal.js';
import type { TestDatabase } from './seeded-database.test-helper.js';

export const pinKey = new Uint8Array(32).fill(7);
export const baseEnv = { DEMO_MODE: 'true', TENANCY: 'multi', DEMO_DOMAIN: 'demo.example.test',
  APP_ENCRYPTION_KEY: 'cd'.repeat(32), AUTH_SECRET: 'demo-portal-seed-secret-with-more-than-32-characters', AUTH_PASSWORD_LOGIN: 'off' };

// Monday noon: the next Competition Training (Tuesday) is cancelled by the mat seed, so Thursday's holds the waitlist.
export function portalFixture(db: TestDatabase, configured: boolean, clock = new TestClock('2026-10-26T12:00:00Z'), uploads = new Map<string, FakeUploads>()) {
  const env = { ...baseEnv, ...(configured ? { DEMO_STRIPE_TEST_KEY: 'rk_test_SYNTHETIC', DEMO_STRIPE_WEBHOOK_SECRET: 'whsec_SYNTHETIC' } : {}) };
  return demoServiceFixture(db, { env, clock, pinSecret: async () => pinKey, uploads });
}
export async function studentRows(db: TestDatabase, gymId: string) {
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
