// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { attendances, memberRanks, ranks, uuidv7, type members } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { targetCriterionSchema } from '../../core/interfaces/extensions.js';
import { TestClock } from '../../core/clock.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { countPromotionAttendance, promotionAttendanceKey } from '../attendance/promotion.query.js';
import { promotionAttendanceScanChoices } from '../attendance/promotion.query.test-helper.js';
import { createMembersService } from '../members/members.js';
import { createPromotionCriteria } from '../ranks/criteria.js';
import { createRanksService } from '../ranks/ranks.service.js';
import { createDashboardService } from './dashboard.js';
import { createNotSeenRead } from './not-seen.js';

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
  // The next rank carries a criterion too, so the dashboard lists the member who reaches it.
  const second = await factory('ranks', gymId, { rankSystemId: system.id, name: 'Second', position: 1,
    criteria: [{ providerId: 'classes-since-promotion', config: { target: 0 } }] });
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
  const history = await database.forGym(gymId, tx => tx.select().from(memberRanks));
  for (const member of roster.filter(member => member.status === 'active')) {
    const progress = await ranks.memberProgress(gymId, { memberId: member.id, dateOfBirth: member.dateOfBirth,
      createdAt: member.createdAt, history, attendedProgramIds: programs.map(program => program.id), attendanceScope: { kind: 'gym', gymId } }, modules);
    for (const program of progress.programs) {
      if (!program.next) continue;
      const eligibility = await ranks.eligibility(gymId, { programId: program.id, rankId: program.next.rankId, limit: 100, offset: 0 }, modules);
      const own = eligibility.data.find(row => row.memberId === member.id)!;
      expect(own.subRank).toBe(program.next.subRank);
      expect(progress.criteria.filter(row => row.programId === program.id).map(row => ({ current: row.current, target: row.required, met: row.eligible })))
        .toEqual(own.criteria.map(({ current, target, met }) => ({ current, target, met })));
      // The dashboard leaves out a next step whose rank has no criteria; every other step must agree.
      expect(result.some(row => row.memberId === member.id)).toBe(own.eligible && own.criteria.length > 0);
    }
  }
  await expect(ranks.dashboardEligibility(gymId)).rejects.toMatchObject({ code: 'conflict' });
});

it('leaves out a next step whose rank has no criteria, while eligibility still offers that rank', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const system = await factory('rankSystems', gymId), program = await factory('programs', gymId, { rankSystemId: system.id, active: true });
  const rank = await factory('ranks', gymId, { rankSystemId: system.id, position: 0, criteria: [] });
  const member = await factory('members', gymId, { firstName: 'New', lastName: 'Member', status: 'active', createdAt: new Date('2026-10-01Z') });
  const service = createRanksService({ scope: database.forGym, clock, criteria: createPromotionCriteria(createAttendanceQueries({ scope: database.forGym, clock })) });
  const dashboard = createDashboardService({ members: createMembersService({ scope: database.forGym, clock }),
    ranks: service, notSeen: createNotSeenRead(database.forGym) });
  const widget = async () => (await dashboard.get({ gymId, roles: ['owner'], clock })).data.widgets.find(item => item.id === 'promotion_ready');
  expect(await widget()).toMatchObject({ count: 0, members: [] });
  // The Ranks page still offers the first rank so staff can award it in bulk.
  expect((await service.eligibility(gymId, { programId: program.id, rankId: rank.id, limit: 100, offset: 0 })).data)
    .toEqual([expect.objectContaining({ memberId: member.id, eligible: true, criteria: [] })]);
  // A zero-target criterion is met without attendance; a one-class target is not.
  await database.forGym(gymId, tx => tx.update(ranks).set({ criteria: [
    { providerId: 'classes-since-promotion', config: { target: 0 } }] }).where(eq(ranks.id, rank.id)));
  expect(await widget()).toMatchObject({ count: 1, members: [{ memberId: member.id, programId: program.id, rankId: rank.id }] });
  await database.forGym(gymId, tx => tx.update(ranks).set({ criteria: [
    { providerId: 'classes-since-promotion', config: { target: 1 } }] }).where(eq(ranks.id, rank.id)));
  expect(await widget()).toMatchObject({ count: 0, members: [] });
});

it('lists a ranked member for another program once and never for a later rank in a program whose next step has no criteria', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const [systemA, systemB, systemC] = await Promise.all([factory('rankSystems', gymId), factory('rankSystems', gymId), factory('rankSystems', gymId)]);
  const programA = await factory('programs', gymId, { name: 'A', rankSystemId: systemA.id, active: true });
  const programB = await factory('programs', gymId, { name: 'B', rankSystemId: systemB.id, active: true });
  const programC = await factory('programs', gymId, { name: 'C', rankSystemId: systemC.id, active: true });
  const whiteA = await factory('ranks', gymId, { name: 'White', rankSystemId: systemA.id, position: 0, criteria: [] });
  // A later rank that this member would meet must never be reached through the no-criteria first rank.
  await factory('ranks', gymId, { name: 'Yellow', rankSystemId: systemA.id, position: 1,
    criteria: [{ providerId: 'classes-since-promotion', config: { target: 0 } }] });
  const whiteC = await factory('ranks', gymId, { name: 'White', rankSystemId: systemC.id, position: 0, criteria: [] });
  await factory('ranks', gymId, { name: 'Yellow', rankSystemId: systemC.id, position: 1, criteria: [] });
  const beginnerB = await factory('ranks', gymId, { name: 'Beginner', rankSystemId: systemB.id, position: 0,
    criteria: [{ providerId: 'classes-since-promotion', config: { target: 1 } }] });
  const ranked = await factory('members', gymId, { firstName: 'Ranked', lastName: 'Member', status: 'active', createdAt: new Date('2026-10-01Z') });
  await factory('members', gymId, { firstName: 'Unranked', lastName: 'Member', status: 'active', createdAt: new Date('2026-10-01Z') });
  await factory('memberRanks', gymId, { memberId: ranked.id, programId: programC.id, rankSystemId: systemC.id,
    rankId: whiteC.id, subRank: 0, promotedAt: new Date('2026-10-02Z') });
  await factory('attendances', gymId, { memberId: ranked.id, programId: programB.id, occurredAt: new Date('2026-10-03Z'), kind: 'class' });
  const service = createRanksService({ scope: database.forGym, clock, criteria: createPromotionCriteria(createAttendanceQueries({ scope: database.forGym, clock })) });
  expect(await service.dashboardEligibility(gymId)).toEqual([{ memberId: ranked.id, firstName: 'Ranked', lastName: 'Member',
    programId: programB.id, rankId: beginnerB.id }]);
  // Both programs still offer their first, no-criteria rank to the Ranks page.
  expect((await service.eligibility(gymId, { programId: programA.id, rankId: whiteA.id, limit: 100, offset: 0 })).data).toHaveLength(2);
});

it.each([false, true])('scopes each promotion window to its own lower bound and agrees with evaluate (open mat = %s)', async openMatCountsAsClass => {
  const gymId = uuidv7(), until = '2026-04-01T00:00:00Z';
  await factory('gyms', gymId, { openMatCountsAsClass });
  const system = await factory('rankSystems', gymId), rankCriteria = [{ providerId: 'classes-since-promotion', config: { target: 2 } }];
  const program = await factory('programs', gymId, { rankSystemId: system.id });
  const rank = await factory('ranks', gymId, { rankSystemId: system.id, criteria: rankCriteria });
  const session = await factory('classSessions', gymId, { startsAt: new Date('2026-03-01Z'), endsAt: new Date('2026-03-01T01:00:00Z') });
  await factory('classSessionPrograms', gymId, { sessionId: session.id, programId: program.id });
  const roster = await Promise.all(['before', 'first', 'inside', 'after', 'none'].map(name =>
    factory('members', gymId, { firstName: name, status: 'active' })));
  for (const member of roster) {
    for (const occurredAt of ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'])
      await factory('attendances', gymId, { memberId: member.id, programId: program.id, occurredAt: new Date(occurredAt), kind: 'class' });
    await factory('attendances', gymId, { memberId: member.id, sessionId: session.id, programId: null,
      occurredAt: new Date('2026-03-01T00:00:00Z'), kind: 'class' });
    // Open mat counts only when the gym says so, and the visit at until is excluded.
    await factory('attendances', gymId, { memberId: member.id, programId: program.id,
      occurredAt: new Date('2026-02-15T00:00:00Z'), kind: 'open_mat' });
    await factory('attendances', gymId, { memberId: member.id, programId: program.id,
      occurredAt: new Date(until), kind: 'class' });
  }
  const windows: Record<string, string | null> = { before: '2025-12-01T00:00:00Z', first: '2026-01-01T00:00:00Z',
    inside: '2026-02-20T00:00:00Z', after: '2026-03-15T00:00:00Z', none: null };
  const attendance = createAttendanceQueries({ scope: database.forGym, clock: new TestClock(until) });
  const criteria = createPromotionCriteria(attendance);
  const contexts = roster.map(member => ({ attendanceScope: { kind: 'gym' as const, gymId }, gymId, memberId: member.id,
    programId: program.id, rankId: rank.id, promotedAt: windows[member.firstName]!, dateOfBirth: null, timezone: 'UTC',
    clock: new TestClock(until) }));
  const reads = { scope: database.forGym, gymId, until, openMatCountsAsClass };
  const batch = await criteria.prepareBatch(contexts.map(context => ({ context, rank: { criteria: rankCriteria } })), new Set(), reads);
  const expected = openMatCountsAsClass ? [4, 4, 1, 0, 4] : [3, 3, 1, 0, 3];
  for (const [index, context] of contexts.entries()) {
    const single = await criteria.evaluate(context, rankCriteria, new Set());
    expect(await batch.evaluate(context, rankCriteria, new Set())).toEqual(single);
    expect(single[0]).toMatchObject({ current: expected[index], target: 2, met: expected[index]! >= 2 });
  }
  // Two windows for one member and program must not duplicate that member's visits.
  const duplicate = await countPromotionAttendance(database.forGym, gymId, [
    { memberId: roster[0]!.id, programId: program.id, since: '2025-12-01T00:00:00Z' },
    { memberId: roster[0]!.id, programId: program.id, since: '2026-02-20T00:00:00Z' },
  ], until, openMatCountsAsClass);
  expect([...duplicate.values()].sort((a, b) => a - b)).toEqual([1, openMatCountsAsClass ? 4 : 3]);
});


// One candidate among two members takes the per-candidate arm; three candidates among four members take the
// whole-program arm. Either way the real count must leave out the outside member's visits in the same program.
it.each([
  { arm: 'per-candidate', candidates: 1, scanProgram: false },
  { arm: 'whole-program', candidates: 3, scanProgram: true },
])('counts only the candidates\' visits on the $arm arm with an outside member visiting the program', async ({ candidates: size, scanProgram }) => {
  const gymId = uuidv7(), until = '2026-04-01T00:00:00Z', since = '2026-01-15T00:00:00Z';
  await factory('gyms', gymId);
  const system = await factory('rankSystems', gymId), program = await factory('programs', gymId, { rankSystemId: system.id });
  const candidates = await Promise.all(Array.from({ length: size }, () => factory('members', gymId)));
  const outside = await factory('members', gymId);
  for (const [index, candidate] of candidates.entries()) {
    // Candidate n has n + 2 visits after its window opens, and one before it that must not count.
    for (const occurredAt of ['2026-01-01T00:00:00Z', ...Array.from({ length: index + 2 }, (_, day) => `2026-02-0${day + 1}T00:00:00Z`)])
      await factory('attendances', gymId, { memberId: candidate.id, programId: program.id, occurredAt: new Date(occurredAt), kind: 'class' });
  }
  await database.forGym(gymId, tx => tx.insert(attendances).values(Array.from({ length: 2_000 }, (_, index) => ({
    gymId, memberId: outside.id, programId: program.id, kind: 'class', source: 'import',
    occurredAt: new Date(Date.parse('2026-02-10T00:00:00Z') + index * 60_000),
  }))));
  const requests = candidates.map(candidate => ({ memberId: candidate.id, programId: program.id, since }));
  const choices = await database.forGym(gymId, tx =>
    // eslint-disable-next-line database/system-tables -- Inspect the same plan choice the attendance statement uses.
    tx.execute<{ scan_program: boolean }>(promotionAttendanceScanChoices(tx, gymId, requests, until, false)));
  expect(choices.map(row => row.scan_program)).toEqual([scanProgram]);
  const counts = await countPromotionAttendance(database.forGym, gymId, requests, until, false);
  expect(requests.map(request => counts.get(promotionAttendanceKey(request)))).toEqual(candidates.map((_, index) => index + 2));
});

it('chooses a read per program from distinct visitors inside that program window', async () => {
  const gymId = uuidv7(), since = '2026-02-01T00:00:00Z', until = '2026-04-01T00:00:00Z';
  await factory('gyms', gymId);
  const [busy, quiet] = await Promise.all([factory('programs', gymId), factory('programs', gymId)]);
  const candidates = await Promise.all(Array.from({ length: 3 }, () => factory('members', gymId, { status: 'active' })));
  const former = await factory('members', gymId, { status: 'cancelled' });
  const frozen = await factory('members', gymId, { status: 'frozen' });
  const session = await factory('classSessions', gymId, { startsAt: new Date(since), endsAt: new Date('2026-02-01T01:00:00Z') });
  await factory('classSessionPrograms', gymId, { sessionId: session.id, programId: busy.id });

  for (const member of candidates) {
    for (const program of [busy, quiet]) {
      await factory('attendances', gymId, { memberId: member.id, programId: program.id, occurredAt: new Date(since), kind: 'class' });
    }
  }
  await factory('attendances', gymId, { memberId: former.id, programId: busy.id, occurredAt: new Date(since), kind: 'class' });
  await factory('attendances', gymId, { memberId: frozen.id, programId: null, sessionId: session.id,
    occurredAt: new Date(since), kind: 'class' });
  await factory('attendances', gymId, { memberId: former.id, programId: quiet.id, occurredAt: new Date(since), kind: 'class' });
  for (const [when, kind] of [['2026-01-31T23:59:59Z', 'class'], [until, 'class'], [since, 'open_mat']] as const) {
    await factory('attendances', gymId, { memberId: frozen.id, programId: quiet.id, occurredAt: new Date(when), kind });
  }

  const windows = [busy, quiet].flatMap(program => candidates.map(member => ({ memberId: member.id, programId: program.id, since })));
  windows.push({ memberId: candidates[0]!.id, programId: busy.id, since: '2026-03-01T00:00:00Z' });
  windows.push({ memberId: candidates[0]!.id, programId: quiet.id, since: '2026-03-01T00:00:00Z' });
  const choices = await database.forGym(gymId, tx =>
    // eslint-disable-next-line database/system-tables -- Inspect the same plan choice the attendance statement uses.
    tx.execute<{ program_id: string; scan_program: boolean }>(promotionAttendanceScanChoices(tx, gymId, windows, until, false)));
  expect(new Map(choices.map(row => [row.program_id, row.scan_program]))).toEqual(new Map([[busy.id, false], [quiet.id, true]]));
  const counts = await countPromotionAttendance(database.forGym, gymId, windows, until, false);
  expect(counts.size).toBe(windows.length);
  for (const window of windows) expect(counts.get(promotionAttendanceKey(window))).toBe(Number(window.since === since));
});

// One candidate among ten members is above four members per allowed visitor, so the statement skips the
// probe even though only the candidate visits the program.
it('skips the visitor probe when the gym is far larger than its allowed visitors', async () => {
  const gymId = uuidv7(), until = '2026-04-01T00:00:00Z', since = '2026-01-15T00:00:00Z';
  await factory('gyms', gymId);
  const program = await factory('programs', gymId);
  const roster = await Promise.all(Array.from({ length: 10 }, () => factory('members', gymId, { status: 'active' })));
  const candidate = roster[0]!;
  for (const occurredAt of ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-02-08T00:00:00Z', '2026-02-15T00:00:00Z'])
    await factory('attendances', gymId, { memberId: candidate.id, programId: program.id, occurredAt: new Date(occurredAt), kind: 'class' });
  const requests = [{ memberId: candidate.id, programId: program.id, since }];
  const choices = await database.forGym(gymId, tx =>
    // eslint-disable-next-line database/system-tables -- Inspect the same plan choice the attendance statement uses.
    tx.execute<{ scan_program: boolean }>(promotionAttendanceScanChoices(tx, gymId, requests, until, false)));
  expect(choices.map(row => row.scan_program)).toEqual([false]);
  const counts = await countPromotionAttendance(database.forGym, gymId, requests, until, false);
  expect(counts.get(promotionAttendanceKey(requests[0]!))).toBe(3);
});

// One candidate allows one visitor, so the probe limit is four members: exactly four still probe (and find
// only the candidate, so the program scan wins), and a fifth member skips the probe.
it.each([{ memberCount: 4, scan: true }, { memberCount: 5, scan: false }])(
  'probes only up to four members per allowed visitor ($memberCount members)', async ({ memberCount, scan }) => {
    const gymId = uuidv7(), until = '2026-04-01T00:00:00Z', since = '2026-01-15T00:00:00Z';
    await factory('gyms', gymId);
    const program = await factory('programs', gymId);
    const roster = await Promise.all(Array.from({ length: memberCount }, () => factory('members', gymId, { status: 'active' })));
    const candidate = roster[0]!;
    for (const occurredAt of ['2026-02-01T00:00:00Z', '2026-02-08T00:00:00Z'])
      await factory('attendances', gymId, { memberId: candidate.id, programId: program.id, occurredAt: new Date(occurredAt), kind: 'class' });
    const requests = [{ memberId: candidate.id, programId: program.id, since }];
    const choices = await database.forGym(gymId, tx =>
      // eslint-disable-next-line database/system-tables -- Inspect the same plan choice the attendance statement uses.
      tx.execute<{ scan_program: boolean }>(promotionAttendanceScanChoices(tx, gymId, requests, until, false)));
    expect(choices.map(row => row.scan_program)).toEqual([scan]);
    const counts = await countPromotionAttendance(database.forGym, gymId, requests, until, false);
    expect(counts.get(promotionAttendanceKey(requests[0]!))).toBe(2);
  });
