// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { portalContracts } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { portalFixture, portalServices, type PortalFixture } from './schedule.testing.js';

const db = useTestDatabase(), factory = createFactories(db);
const clock = new TestClock('2026-10-29T16:00:00Z');
const services = portalServices(db, clock);

/** A three-step rank system: the child holds the first rank's last sub-rank, the parent the top rank. */
async function ranked(f: PortalFixture) {
  const system = await factory('rankSystems', f.gymId);
  const program = await factory('programs', f.gymId, { name: 'Grappling', rankSystemId: system.id });
  const retired = await factory('programs', f.gymId, { name: 'Retired', rankSystemId: system.id, active: false });
  const first = await factory('ranks', f.gymId, { rankSystemId: system.id, name: 'First', position: 0, color: '#ffffff', subRanks: [{ id: 'one', name: 'One' }] });
  const second = await factory('ranks', f.gymId, { rankSystemId: system.id, name: 'Second', position: 1, color: '#0000ff',
    criteria: [{ providerId: 'classes-since-promotion', config: { target: 2 } }, { providerId: 'minimum-age', config: { target: 16 } }] });
  const third = await factory('ranks', f.gymId, { rankSystemId: system.id, name: 'Third', position: 2 });
  const coach = await factory('staffProfiles', f.gymId, { userId: f.staff.id });
  const promote = (memberId: string, rankId: string, subRank: number, promotedAt: string, programId = program.id, notes: string | null = null) =>
    factory('memberRanks', f.gymId, { memberId, programId, rankId, rankSystemId: system.id, subRank, promotedAt: new Date(promotedAt), notes, promotedBy: coach.id });
  await promote(f.child.id, first.id, 0, '2026-09-01T00:00:00Z');
  await promote(f.child.id, first.id, 1, '2026-10-01T00:00:00Z', program.id, 'Private coach note');
  await promote(f.child.id, first.id, 0, '2026-08-01T00:00:00Z', retired.id);
  await promote(f.parent.id, third.id, 0, '2026-06-01T00:00:00Z');
  const attend = (memberId: string, occurredAt: string, kind = 'class') => factory('attendances', f.gymId, { memberId, programId: program.id, occurredAt: new Date(occurredAt), kind });
  await attend(f.child.id, '2026-09-15T18:00:00Z'); await attend(f.child.id, '2026-10-15T18:00:00Z'); await attend(f.parent.id, '2026-10-16T18:00:00Z');
  return { system, program, retired, first, second, third, coach };
}
async function progress(f: PortalFixture, principal: Principal, memberId: string) {
  const response = await services.app(f.gymId, principal).request(`/api/portal/members/${memberId}/progress`);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body: unknown = await response.json();
  return { raw: JSON.stringify(body), data: portalContracts.progress.response.parse(body).data };
}
const attendancePath = (memberId: string, query = '') => `/api/portal/members/${memberId}/attendance${query}`;

describe('portal progress', () => {
  it("a parent sees the child's next step, criterion bars and referenced ranks only", async () => {
    const f = await portalFixture(factory), r = await ranked(f);
    const { raw, data } = await progress(f, f.principal('payer'), f.child.id);
    expect(data.history.map(row => [row.programId, row.rankId, row.subRank])).toEqual([
      [r.program.id, r.first.id, 1], [r.program.id, r.first.id, 0], [r.retired.id, r.first.id, 0]]);
    expect(data.programs).toEqual([{ id: r.program.id, name: 'Grappling', current: { rankId: r.first.id, subRank: 1 }, next: { rankId: r.second.id, subRank: 0 } },
      { id: r.retired.id, name: 'Retired', current: { rankId: r.first.id, subRank: 0 }, next: null }]);
    expect(data.ranks).toEqual([{ id: r.first.id, name: 'First', color: '#ffffff', subRanks: [{ id: 'one', name: 'One' }] },
      { id: r.second.id, name: 'Second', color: '#0000ff', subRanks: [] }]);
    expect(data.criteria).toEqual([
      { programId: r.program.id, rankId: r.second.id, criterionId: 'classes-since-promotion', labelKey: 'ranks/ranks:classes', current: 1, required: 2, eligible: false },
      { programId: r.program.id, rankId: r.second.id, criterionId: 'minimum-age', labelKey: 'ranks/ranks:age', current: 10, required: 16, eligible: false }]);
    for (const hidden of ['Private coach note', 'notes', 'promotedBy', r.coach.id, 'config', f.parent.id]) expect(raw).not.toContain(hidden);
    // The staff eligibility screen reaches the same target and the same measurements.
    const staff = (await services.ranks.eligibility(f.gymId, { programId: r.program.id, rankId: r.second.id, limit: 100 })).data.find(row => row.memberId === f.child.id)!;
    expect(staff.subRank).toBe(0);
    expect(staff.criteria.map(item => [item.providerId, item.current, item.target, item.met]))
      .toEqual(data.criteria.map(item => [item.criterionId, item.current, item.required, item.eligible]));
  });
  it('returns no next step at the top rank, and nothing for a member without ranks', async () => {
    const f = await portalFixture(factory), r = await ranked(f);
    const top = (await progress(f, f.principal('payer'), f.parent.id)).data;
    expect(top.programs).toEqual([{ id: r.program.id, name: 'Grappling', current: { rankId: r.third.id, subRank: 0 }, next: null }]);
    expect(top.criteria).toEqual([]);
    expect(top.ranks.map(rank => rank.id)).toEqual([r.third.id]);
    expect((await progress(f, f.principal('adult'), f.grown.id)).data).toEqual({ history: [], programs: [], ranks: [], criteria: [] });
  });
  it('breaks a same-time tie by rank order, so history, current rank, next step and the staff list agree', async () => {
    const f = await portalFixture(factory), r = await ranked(f);
    // Recorded at the same instant; the lower sub-rank was created later, so creation order alone would pick it.
    const at = new Date('2026-10-20T00:00:00Z');
    const higher = await factory('memberRanks', f.gymId, { memberId: f.grown.id, programId: r.program.id, rankId: r.first.id, rankSystemId: r.system.id,
      subRank: 1, promotedAt: at, createdAt: new Date('2026-10-20T00:00:00Z') });
    const lower = await factory('memberRanks', f.gymId, { memberId: f.grown.id, programId: r.program.id, rankId: r.first.id, rankSystemId: r.system.id,
      subRank: 0, promotedAt: at, createdAt: new Date('2026-10-21T00:00:00Z') });
    const { data } = await progress(f, f.principal('adult'), f.grown.id);
    expect(data.programs).toEqual([{ id: r.program.id, name: 'Grappling', current: { rankId: r.first.id, subRank: 1 }, next: { rankId: r.second.id, subRank: 0 } }]);
    expect(data.history.map(row => row.id)).toEqual([higher.id, lower.id]);
    const staff = await services.ranks.listPromotions(f.gymId, { memberId: f.grown.id, limit: 50 });
    expect(staff.data.map(row => row.id)).toEqual([higher.id, lower.id]);
  });
  it("an adult non-payer reads only their own progress and attendance", async () => {
    const f = await portalFixture(factory); await ranked(f);
    const server = services.app(f.gymId, f.principal('adult'));
    for (const memberId of [f.parent.id, f.child.id]) {
      expect((await server.request(`/api/portal/members/${memberId}/progress`)).status).toBe(404);
      expect((await server.request(attendancePath(memberId))).status).toBe(404);
    }
    expect((await server.request(attendancePath(f.grown.id))).status).toBe(200);
  });
  it("lists a child's attendance newest first, filtered, without other members' visits", async () => {
    const f = await portalFixture(factory), r = await ranked(f), server = services.app(f.gymId, f.principal('payer'));
    const all = portalContracts.attendance.response.parse(await (await server.request(attendancePath(f.child.id))).json());
    expect(all.data.map(row => [row.memberId, row.occurredAt, row.kind, row.programId])).toEqual([
      [f.child.id, '2026-10-15T18:00:00.000Z', 'class', r.program.id], [f.child.id, '2026-09-15T18:00:00.000Z', 'class', r.program.id]]);
    const recent = portalContracts.attendance.response.parse(await (await server.request(attendancePath(f.child.id, '?since=2026-10-01T00:00:00Z&limit=1'))).json());
    expect(recent.pagination).toEqual({ limit: 1, offset: 0, total: 1 });
  });
  it('keeps other households and gyms out of progress and attendance', async () => {
    const f = await portalFixture(factory), foreign = await portalFixture(factory);
    await ranked(f); await ranked(foreign);
    const server = services.app(f.gymId, f.principal('payer'));
    for (const memberId of [f.other.id, foreign.child.id, f.erased.id, uuidv7()]) {
      expect((await server.request(`/api/portal/members/${memberId}/progress`)).status).toBe(404);
      expect((await server.request(attendancePath(memberId))).status).toBe(404);
    }
    const neighbour = services.app(f.gymId, f.principal('neighbour'));
    expect((await neighbour.request(`/api/portal/members/${f.child.id}/progress`)).status).toBe(404);
    const crossGym = services.app(f.gymId, foreign.principal('payer'));
    expect((await crossGym.request(`/api/portal/members/${foreign.child.id}/progress`)).status).toBe(404);
    expect((await crossGym.request(attendancePath(foreign.child.id))).status).toBe(404);
  });
  it('denies anonymous, staff and kiosk principals and reports unconfigured ranks as unavailable', async () => {
    const f = await portalFixture(factory);
    for (const principal of [{ kind: 'anonymous' }, { kind: 'staff', gymId: f.gymId, userId: f.staff.id, roles: ['owner'] },
      { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }] as Principal[]) {
      const server = services.app(f.gymId, principal);
      expect([401, 403, 404]).toContain((await server.request(`/api/portal/members/${f.parent.id}/progress`)).status);
      expect([401, 403, 404]).toContain((await server.request(attendancePath(f.parent.id))).status);
    }
    const unconfigured = portalServices(db, clock, { configured: false }).app(f.gymId, f.principal('payer'));
    expect((await unconfigured.request(`/api/portal/members/${f.parent.id}/progress`)).status).toBe(503);
  });
});
