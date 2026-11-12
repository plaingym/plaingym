// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7, type members } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { targetCriterionSchema } from '../../core/interfaces/extensions.js';
import { TestClock } from '../../core/clock.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { createPromotionCriteria } from '../ranks/criteria.js';
import { createRanksService } from '../ranks/ranks.service.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-11-01T12:00:00Z');

it.each([false, true])('matches paginated eligibility for next steps, linked programs, custom criteria and open mat = %s', async openMatCountsAsClass => {
  const gymId = uuidv7(), foreignId = uuidv7();
  await factory('gyms', gymId, { openMatCountsAsClass }); await factory('gyms', foreignId);
  const system = await factory('rankSystems', gymId);
  const programs = [await factory('programs', gymId, { name: 'A', rankSystemId: system.id }),
    await factory('programs', gymId, { name: 'B', rankSystemId: system.id })];
  await factory('programs', gymId, { name: 'Inactive', active: false, rankSystemId: system.id });
  await factory('programs', gymId, { name: 'Unranked' });
  const first = await factory('ranks', gymId, { rankSystemId: system.id, position: 0,
    subRanks: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }], criteria: [
    { providerId: 'classes-since-promotion', config: { target: 2 } },
    { providerId: 'time-at-rank', config: { target: 14 } },
    { providerId: 'minimum-age', config: { target: 16 } },
    { providerId: 'custom-check', config: { target: 1 } },
  ] });
  const second = await factory('ranks', gymId, { rankSystemId: system.id, name: 'Second', position: 1, criteria: [] });
  const roster: (typeof members.$inferSelect)[] = [];
  for (let index = 0; index < 8; index++) roster.push(await factory('members', gymId, {
    firstName: 'Member', lastName: String(index), status: index === 7 ? 'cancelled' : 'active',
    dateOfBirth: index === 6 ? '2020-01-01' : '2000-01-01', createdAt: new Date('2026-01-01Z'),
  }));
  const foreign = await factory('members', foreignId, { status: 'active' });
  await factory('attendances', foreignId, { memberId: foreign.id });
  for (const program of programs) {
    for (const index of [1, 2, 3, 4]) await factory('memberRanks', gymId, {
      memberId: roster[index]!.id, programId: program.id, rankSystemId: system.id,
      rankId: index === 4 ? second.id : first.id, subRank: index === 2 ? 2 : 0,
      promotedAt: new Date(index === 3 ? '2026-10-31Z' : '2026-10-01Z'),
    });
    // A future promotion cannot change which step is next.
    await factory('memberRanks', gymId, { memberId: roster[0]!.id, programId: program.id, rankSystemId: system.id,
      rankId: second.id, promotedAt: new Date('2026-11-02Z') });
  }
  const session = await factory('classSessions', gymId);
  for (const program of programs) await factory('classSessionPrograms', gymId, { sessionId: session.id, programId: program.id });
  for (const [index, member] of roster.entries()) {
    // The direct program AND session link must count only once. The other program uses its session link.
    await factory('attendances', gymId, { memberId: member.id, sessionId: session.id, programId: programs[0]!.id,
      occurredAt: new Date('2026-10-01Z'), kind: 'class' });
    for (const program of programs) await factory('attendances', gymId, { memberId: member.id, programId: program.id,
      occurredAt: new Date('2026-10-15Z'), kind: index === 5 ? 'open_mat' : 'class' });
    // Upper bound is exclusive; neither this nor a future visit satisfies a missing class.
    for (const instant of ['2026-11-01T12:00:00Z', '2026-11-02Z']) await factory('attendances', gymId, {
      memberId: member.id, programId: programs[0]!.id, occurredAt: new Date(instant), kind: 'class',
    });
  }
  const attendance = createAttendanceQueries({ scope: database.forGym, clock });
  const criteria = createPromotionCriteria(attendance);
  criteria.register({ id: 'custom-check', moduleId: 'custom', labelKey: 'custom:check', configSchema: targetCriterionSchema,
    async evaluate(_context, value) { const { target } = targetCriterionSchema.parse(value); return { current: 1, target, met: 1 >= target }; } });
  const ranks = createRanksService({ scope: database.forGym, clock, criteria }), modules = new Set(['custom']);
  const expected = new Map<string, { memberId: string; firstName: string; lastName: string; programId: string; rankId: string }>();
  // Independent public eligibility calls retain all provider evaluation and progression rules.
  for (const program of programs) {
    const considered = new Set<string>();
    for (const rank of [first, second]) {
      const page = await ranks.eligibility(gymId, { programId: program.id, rankId: rank.id, limit: 100, offset: 0 }, modules);
      for (const candidate of page.data) {
        if (considered.has(candidate.memberId)) continue;
        considered.add(candidate.memberId);
        if (!candidate.eligible || expected.has(candidate.memberId)) continue;
        const member = roster.find(member => member.id === candidate.memberId)!;
        expected.set(member.id, { memberId: member.id, firstName: member.firstName, lastName: member.lastName, programId: program.id, rankId: rank.id });
      }
    }
  }
  const result = await ranks.dashboardEligibility(gymId, modules);
  expect(result).toEqual([...expected.values()].sort((a, b) => a.lastName.localeCompare(b.lastName)));
  expect(result.map(row => row.memberId)).toEqual([0, 1, 2, ...(openMatCountsAsClass ? [5] : [])].map(index => roster[index]!.id));
  expect(result.find(row => row.memberId === roster[2]!.id)).toHaveProperty('rankId', second.id);
  expect(result.every(row => row.programId === programs[0]!.id)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(foreign.id);
  await expect(ranks.dashboardEligibility(gymId)).rejects.toMatchObject({ code: 'conflict' });
});
