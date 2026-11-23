// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { classBookings, classSessions } from './schema/index.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';
import { createFactories } from './testing/factories.js';

const database = useUpgradeTestDatabase('0041_stripe_event_failed_at', { applySecurity: true });
const factory = createFactories(database);
const gymId = uuidv7(), householdId = uuidv7(), userId = uuidv7(), sessionId = uuidv7();
const memberIds = [uuidv7(), uuidv7(), uuidv7()];
const bookings = [
  { id: uuidv7(), memberId: memberIds[0]!, status: 'booked', waitlistPosition: null, cancelledAt: null },
  { id: uuidv7(), memberId: memberIds[1]!, status: 'waitlisted', waitlistPosition: 1, cancelledAt: null },
  { id: uuidv7(), memberId: memberIds[2]!, status: 'cancelled', waitlistPosition: null, cancelledAt: new Date('2026-11-20T10:00:00Z') },
];
const rejected = (constraint_name: string) => ({ cause: { code: '23514', constraint_name } });

beforeAll(async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Restore upgrade', ${gymId})`;
    await maintenance.sql`insert into auth_user (id, name, email) values (${userId}, 'Owner', ${userId + '@example.test'})`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Family')`;
    for (const [index, memberId] of memberIds.entries()) await maintenance.sql`insert into members (id, gym_id, household_id, first_name, last_name)
      values (${memberId}, ${gymId}, ${householdId}, 'Member', ${String(index)})`;
    await maintenance.sql`insert into class_sessions (id, gym_id, name, starts_at, ends_at, capacity, status)
      values (${sessionId}, ${gymId}, 'Fundamentals', '2026-11-25T18:00:00Z', '2026-11-25T19:00:00Z', 1, 'scheduled')`;
    for (const booking of bookings) await maintenance.sql`insert into class_bookings
      (id, gym_id, member_id, session_id, status, waitlist_position, booked_by, booked_by_kind, cancelled_at)
      values (${booking.id}, ${gymId}, ${booking.memberId}, ${sessionId}, ${booking.status}, ${booking.waitlistPosition},
        ${userId}, 'staff', ${booking.cancelledAt?.toISOString() ?? null})`;
  } finally { await maintenance.close(); }
  await migrateDatabase(database.maintenanceUrl);
});

it('keeps existing sessions and bookings, starting every session at zero restores and every booking without a marker', async () => {
  expect(await database.forGym(gymId, tx => tx.select().from(classSessions))).toMatchObject([
    { id: sessionId, name: 'Fundamentals', capacity: 1, status: 'scheduled', restoreCount: 0 },
  ]);
  const rows = await database.forGym(gymId, tx => tx.select().from(classBookings).orderBy(classBookings.id));
  expect(rows).toMatchObject(bookings.map(booking => ({ ...booking, sessionId, bookedBy: userId, bookedByKind: 'staff',
    sessionCancelStatus: null, sessionCancelPosition: null })));
});

it('accepts a marker only on a cancelled booking, with a position only for a waitlisted one', async () => {
  const base = { sessionId, bookedBy: userId, memberId: memberIds[2]! };
  await expect(factory('classBookings', gymId, { ...base, status: 'booked', sessionCancelStatus: 'booked' }))
    .rejects.toMatchObject(rejected('class_bookings_session_cancel_check'));
  await expect(factory('classBookings', gymId, { ...base, status: 'cancelled', sessionCancelStatus: 'waitlisted' }))
    .rejects.toMatchObject(rejected('class_bookings_session_cancel_check'));
  await expect(factory('classBookings', gymId, { ...base, status: 'cancelled', sessionCancelStatus: 'booked', sessionCancelPosition: 2 }))
    .rejects.toMatchObject(rejected('class_bookings_session_cancel_check'));
  await expect(factory('classBookings', gymId, { ...base, status: 'cancelled', sessionCancelPosition: 2 }))
    .rejects.toMatchObject(rejected('class_bookings_session_cancel_check'));
  expect(await factory('classBookings', gymId, { ...base, status: 'cancelled', sessionCancelStatus: 'waitlisted', sessionCancelPosition: 3 }))
    .toMatchObject({ status: 'cancelled', sessionCancelStatus: 'waitlisted', sessionCancelPosition: 3 });
  expect(await factory('classBookings', gymId, { ...base, status: 'cancelled', sessionCancelStatus: 'booked' }))
    .toMatchObject({ status: 'cancelled', sessionCancelStatus: 'booked', sessionCancelPosition: null });
  await expect(factory('classSessions', gymId, { restoreCount: -1 })).rejects.toMatchObject(rejected('class_sessions_restore_count_check'));
});
