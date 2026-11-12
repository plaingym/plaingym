// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { and, asc, eq, lt, max } from 'drizzle-orm';
import { attendances, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createNotSeenRead } from './not-seen.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-11-01T12:00:00Z');

it('matches the retired grouped query at visit and creation boundaries, caps details, and isolates gyms', async () => {
  const gymId = uuidv7(), foreignId = uuidv7();
  await factory('gyms', gymId); await factory('gyms', foreignId);
  const home = await factory('households', gymId);
  const foreign = await factory('members', foreignId, { status: 'active', createdAt: new Date('2026-01-01Z') });
  await factory('attendances', foreignId, { memberId: foreign.id, occurredAt: new Date('2026-02-01Z') });
  const roster = await database.forGym(gymId, tx => tx.insert(members).values(Array.from({ length: 400 }, (_, index) => ({
    gymId, householdId: home.id, firstName: 'Member', lastName: String(index).padStart(4, '0'),
    status: index % 10 === 9 ? 'cancelled' : 'active',
    createdAt: new Date(index % 10 === 8 ? '2026-10-31T12:00:00Z' : '2026-01-01T00:00:00Z'),
  }))).returning());
  const boundaryVisits = roster.flatMap((member, index) => {
    const dates = [[], ['2026-10-18T12:00:00Z'], ['2026-10-18T12:00:00.001Z'],
      ['2026-10-18T11:59:59.999Z'], ['2026-11-02T12:00:00Z'], ['2026-11-01T12:00:00Z'],
      ['2026-10-01T12:00:00Z', '2026-10-31T12:00:00Z'], [], [], ['2026-10-01T00:00:00Z']][index % 10]!;
    return dates.map(date => ({ gymId, memberId: member.id, kind: index % 2 ? 'class' as const : 'open_mat' as const,
      source: 'coach' as const, occurredAt: new Date(date) }));
  });
  await database.forGym(gymId, tx => tx.insert(attendances).values(boundaryVisits));
  // Years of older history must not change the last-visit rule or multiply the lateral result.
  for (let year = 2023; year < 2026; year++) await database.forGym(gymId, tx => tx.insert(attendances).values(
    roster.filter((_, index) => index % 10 !== 0 && index % 10 !== 4 && index % 10 !== 7 && index % 10 !== 8)
      .map(member => ({ gymId, memberId: member.id, occurredAt: new Date(`${year}-01-01Z`), source: 'import' })),
  ));
  // Keep only the retired grouped query as an independent oracle while the lateral path settles.
  const oldRows = await database.forGym(gymId, tx => tx.select({ memberId: members.id, firstName: members.firstName,
    lastName: members.lastName, createdAt: members.createdAt, lastSeenAt: max(attendances.occurredAt),
  }).from(members).leftJoin(attendances, and(eq(attendances.memberId, members.id), eq(attendances.gymId, members.gymId),
    lt(attendances.occurredAt, new Date(clock.now().getTime() + 1)))).where(eq(members.status, 'active'))
    .groupBy(members.id).orderBy(asc(members.lastName), asc(members.firstName), asc(members.id)));
  const oldUnseen = oldRows.filter(row => (row.lastSeenAt ? new Date(row.lastSeenAt) : row.createdAt).getTime() <= clock.now().getTime() - 14 * 86400000);
  const read = createNotSeenRead(database.forGym), context = { gymId, clock, roles: ['owner'] as const };
  const result = await read(context);
  expect(result).toMatchObject({ count: 200, members: oldUnseen.slice(0, 100).map(row => ({ memberId: row.memberId,
    firstName: row.firstName, lastName: row.lastName, lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null })) });
  expect(result.count).toBe(oldUnseen.length);
  expect(result.members).toHaveLength(100);
  const seen = await read.lastSeen(context, [...roster.map(member => member.id), foreign.id]);
  for (const row of oldRows) expect(seen.get(row.memberId)).toBe(row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null);
  expect(seen.has(foreign.id)).toBe(false);
  expect(await read({ ...context, gymId: foreignId })).toMatchObject({ count: 1, members: [{ memberId: foreign.id }] });
});

it('handles an empty roster and exact creation grace-period boundaries in PostgreSQL', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const context = { gymId, clock, roles: ['owner'] as const }, read = createNotSeenRead(database.forGym);
  expect(await read(context)).toMatchObject({ count: 0, members: [] });
  const included = await factory('members', gymId, { status: 'active', createdAt: new Date('2026-10-18T12:00:00Z') });
  await factory('members', gymId, { status: 'active', createdAt: new Date('2026-10-18T12:00:00.001Z') });
  expect(await read(context)).toMatchObject({ count: 1, members: [{ memberId: included.id, lastSeenAt: null }] });
  expect(await read.lastSeen(context, [])).toEqual(new Map());
});
