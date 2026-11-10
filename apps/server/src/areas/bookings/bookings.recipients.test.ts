// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { readCancellationRecipients } from './bookings.recipients.js';

const db = useTestDatabase(), factory = createFactories(db);
it('reads only this gym and session’s booked and waitlisted members, without changing bookings', async () => {
  const gymId = uuidv7(), otherGymId = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGymId);
  const session = await factory('classSessions', gymId), other = await factory('classSessions', gymId);
  const expected: string[] = [];
  for (const status of ['booked', 'waitlisted', 'cancelled']) {
    const member = await factory('members', gymId);
    await factory('classBookings', gymId, { sessionId: session.id, memberId: member.id, status, waitlistPosition: status === 'waitlisted' ? 1 : null });
    if (status !== 'cancelled') expected.push(member.id);
  }
  await factory('classBookings', gymId, { sessionId: other.id });
  expect(await db.forGym(gymId, tx => readCancellationRecipients(tx, session.id))).toEqual(expected.sort());
  expect(await db.forGym(otherGymId, tx => readCancellationRecipients(tx, session.id))).toEqual([]);
  expect(await db.forGym(gymId, tx => readCancellationRecipients(tx, session.id))).toEqual(expected);
});
