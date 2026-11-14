// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { classBookings, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { setLogSink } from '../../core/log.js';
import { memberWriteScope } from './member-write.js';

const db = useTestDatabase(), factory = createFactories(db);

it('maps a real lost member reference to conflict and logs its constraint without submitted values', async () => {
  const gymId = uuidv7(), memberId = uuidv7(), lines: string[] = [];
  await factory('gyms', gymId);
  const session = await factory('classSessions', gymId), user = await factory('authUser', gymId);
  const previous = setLogSink(line => lines.push(line));
  try {
    await expect(memberWriteScope(db.forGym)(gymId, tx => tx.insert(classBookings).values({ gymId, memberId,
      sessionId: session.id, bookedBy: user.id, bookedByKind: 'staff' }))).rejects.toMatchObject({ code: 'conflict' });
  } finally { setLogSink(previous); }
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'members.write.foreign_key', gymId,
    error: { cause: { constraint_name: 'class_bookings_member_fk' } } });
  expect(lines[0]).not.toContain(memberId);
});

it('also maps a deadlock victim to conflict when member and household writers take opposite lock orders', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const first = await factory('members', gymId), second = await factory('members', gymId);
  let unlock!: () => void, locked = 0;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const write = (id: string, other: string) => memberWriteScope(db.forGym)(gymId, async tx => {
    await tx.select({ id: members.id }).from(members).where(eq(members.id, id)).for('update');
    if (++locked === 2) unlock();
    await gate;
    await tx.select({ id: members.id }).from(members).where(eq(members.id, other)).for('update');
  });
  const results = await Promise.allSettled([write(first.id, second.id), write(second.id, first.id)]);
  const rejected = results.filter(result => result.status === 'rejected');
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.reason).toMatchObject({ code: 'conflict' });
});
