// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FakeAttendanceQueries } from './attendance.js';
import { FakeMemberHouseholdContext } from './member-household.js';
import type { AttendanceFixture } from './attendance.js';
import { gym, otherGym, member, sibling, id } from './test-fixtures.js';
const gymScope = { kind: 'gym' as const, gymId: gym };
const since = '2026-10-20T00:00:00Z';
const at = '2026-10-21T00:00:00Z';
const entry = (n: number, owner = gym): AttendanceFixture => ({ gymId: owner,
  entry: { id: id(n), memberId: member, sessionId: id(10), programId: id(11), occurredAt: at, source: 'coach' },
  sessionProgramIds: [id(11), id(12)], sessionTagIds: [id(13)],
});
describe('AttendanceQueries fake', () => {
  it('counts each attendance once through multiple program joins and isolates gyms', async () => {
    const row = entry(20);
    const fake = new FakeAttendanceQueries([row, row, entry(21, otherGym)]);
    expect(await fake.countSince(gymScope, { memberId: member, since, programId: id(12), tagId: id(13) })).toBe(1);
    expect(await fake.countSince(gymScope, { memberId: sibling, since })).toBe(0);
    expect(await fake.countSince(gymScope, { memberId: member, since, programId: id(99) })).toBe(0);
  });
  it('uses direct programs for imported history without inventing tags or session links', async () => {
    const row = entry(20);
    const fake = new FakeAttendanceQueries([{ ...row, entry: { ...row.entry, sessionId: null, source: 'import' } }]);
    expect(await fake.countSince(gymScope, { memberId: member, since, programId: id(11) })).toBe(1);
    expect(await fake.countSince(gymScope, { memberId: member, since, programId: id(12) })).toBe(0);
    expect(await fake.countSince(gymScope, { memberId: member, since, tagId: id(13) })).toBe(0);
  });
  it('uses inclusive/exclusive instant boundaries across offsets', async () => {
    const fake = new FakeAttendanceQueries([entry(20)]);
    expect(await fake.countSince(gymScope, { memberId: member, since: '2026-10-20T17:00:00-07:00' })).toBe(1);
    expect(await fake.countSince(gymScope, { memberId: member, since, until: at })).toBe(0);
    await expect(fake.countSince(gymScope, { memberId: member, since: at, until: since })).rejects.toThrow();
  });
  it('sorts newest first with stable ties, paginates and clones results', async () => {
    const fake = new FakeAttendanceQueries([entry(22), entry(21), { ...entry(20), entry: { ...entry(20).entry, occurredAt: since } }]);
    const page = await fake.history(gymScope, {}, { limit: 1, offset: 1 });
    expect(page.data.map((row) => row.id)).toEqual([id(22)]);
    expect(page.pagination).toEqual({ limit: 1, offset: 1, total: 3 });
    page.data.length = 0;
    expect((await fake.history(gymScope, {}, { limit: 1, offset: 1 })).data).toHaveLength(1);
    await expect(fake.history(gymScope, {}, { limit: 101, offset: 0 })).rejects.toThrow();
  });
  it('uses household grants for portal queries and reloads them after revocation', async () => {
    const householdId = id(40);
    const identity = { gymId: gym, householdId, userId: id(41) };
    const households = new FakeMemberHouseholdContext([
      { gymId: gym, householdId, id: member }, { gymId: gym, householdId, id: sibling },
    ], [{ ...identity, role: 'member', memberId: member }]);
    const row = entry(20);
    const fake = new FakeAttendanceQueries([row, { ...entry(21), entry: { ...entry(21).entry, memberId: sibling } }], households);
    const scope = { kind: 'household' as const, identity };
    expect((await fake.history(scope, {}, { limit: 50, offset: 0 })).data.map((item) => item.memberId)).toEqual([member]);
    expect(await fake.countSince(scope, { memberId: member, since })).toBe(1);
    await expect(fake.countSince(scope, { memberId: sibling, since })).rejects.toMatchObject({ code: 'not_found' });
    await expect(fake.history({ kind: 'household', identity: { ...identity, householdId: id(42) } }, {}, { limit: 50, offset: 0 })).rejects.toMatchObject({ code: 'not_found' });
    households.revoke(identity);
    await expect(fake.history(scope, {}, { limit: 50, offset: 0 })).rejects.toMatchObject({ code: 'not_found' });
  });
});
