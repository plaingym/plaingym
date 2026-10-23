// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { memberSchema, programSchema, rankSchema, type ListResponse } from '@plaingym/shared/contracts';
import { FakeAttendanceQueries, type AttendanceFixture } from '../../core/interfaces/attendance.js';
import { TestClock } from '../../core/clock.js';
import { createDashboardService } from './dashboard.js';
import type { MatWidgetServices } from './mat.js';

const gymId = '01900000-0000-7000-8000-000000000001';
const id = (n: number) => '01900000-0000-7000-8000-' + String(n).padStart(12, '0');
const clock = new TestClock('2026-10-22T12:00:00Z');
const member = (n: number, createdAt = '2026-09-01T00:00:00Z') => memberSchema.parse({ id: id(n), householdId: id(900),
  firstName: 'Member', lastName: String(n).padStart(3, '0'), email: null, phone: null, photoKey: null, dateOfBirth: null,
  status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1, createdAt });
function page<T>(rows: T[], input: { limit?: number | string; offset?: number | string }): ListResponse<T> {
  const limit = Number(input.limit ?? 50), offset = Number(input.offset ?? 0);
  return { data: rows.slice(offset, offset + limit), pagination: { limit, offset, total: rows.length } };
}
function fixtures(roster = [member(10)], entries: AttendanceFixture[] = []) {
  const services: MatWidgetServices = {
    members: { listMembers: vi.fn(async (_gymId, input) => page(roster, input)) },
    attendance: new FakeAttendanceQueries(entries),
    ranks: { listPrograms: vi.fn(async () => page([], {})), listRanks: vi.fn(async () => page([], {})),
      eligibility: vi.fn(async () => page([], {})) },
  };
  return services;
}
const context = { gymId, roles: ['owner'] as const, clock };
function visit(memberId: string, occurredAt: string, owner = gymId, kind: 'class' | 'open_mat' = 'class'): AttendanceFixture {
  return { gymId: owner, entry: { id: id(700 + Number(memberId.slice(-3))), memberId, sessionId: null, programId: null,
    occurredAt, source: 'coach', kind }, sessionProgramIds: [], sessionTagIds: [] };
}
describe('mat widget service logic', () => {
  it('uses any visit, includes the exact fourteen-day boundary, ignores future and foreign visits, and gives new members a grace period', async () => {
    const roster = [member(10), member(11), member(12), member(13, '2026-10-21T12:00:00Z'), member(14), member(15)];
    const services = fixtures(roster, [visit(id(10), '2026-10-08T12:00:00Z'), visit(id(11), '2026-10-08T12:00:00.001Z'),
      visit(id(12), '2026-10-21T12:00:00Z', gymId, 'open_mat'), visit(id(14), '2026-10-23T12:00:00Z'),
      visit(id(15), '2026-10-21T12:00:00Z', id(2))]);
    const response = await createDashboardService(services).get(context);
    const widget = response.data.widgets.find((item) => item.id === 'not_seen');
    expect(widget).toMatchObject({ count: 3, members: [{ memberId: id(10) }, { memberId: id(14), lastSeenAt: null }, { memberId: id(15), lastSeenAt: null }] });
    expect(response.data.generatedAt).toBe(clock.now().toISOString());
  });
  it('paginates the complete active roster but caps member payloads at 100', async () => {
    const services = fixtures(Array.from({ length: 105 }, (_, index) => member(index + 10)));
    const { data } = await createDashboardService(services).get({ ...context, roles: ['front_desk'] });
    expect(data.widgets.find((widget) => widget.id === 'active_members')).toHaveProperty('count', 105);
    const unseen = data.widgets.find((widget) => widget.id === 'not_seen');
    expect(unseen).toHaveProperty('count', 105);
    expect(unseen && 'members' in unseen ? unseen.members : []).toHaveLength(100);
    expect(data.widgets.map((widget) => widget.id)).not.toContain('promotion_ready');
    expect(services.ranks.listPrograms).not.toHaveBeenCalled();
    expect(services.members.listMembers).toHaveBeenCalledWith(gymId, { status: 'active', limit: 100, offset: 100 });
  });
  it('uses eligibility for the next step, forwards modules, and deduplicates ready members across programs', async () => {
    const services = fixtures([member(10), member(11)]);
    const programs = [30, 31].map((n) => programSchema.parse({ id: id(n), gymId, name: 'Program', rankSystemId: id(20), active: true, revision: 1, createdAt: clock.now().toISOString() }));
    const ranks = [40, 41].map((n, position) => rankSchema.parse({ id: id(n), gymId, name: 'Rank', rankSystemId: id(20), position, color: null, subRanks: [], criteria: [], revision: 1, createdAt: clock.now().toISOString() }));
    services.ranks.listPrograms = vi.fn(async () => page(programs, {}));
    services.ranks.listRanks = vi.fn(async () => page(ranks, {}));
    services.ranks.eligibility = vi.fn(async (_gymId, input) => {
      const query = input as { rankId: string; programId: string };
      return page([10, 11].map((n) => ({ memberId: id(n), rankSystemId: id(20), program: { id: query.programId, rankSystemId: id(20) },
        rank: { id: query.rankId, rankSystemId: id(20) }, subRank: 0, eligible: n === 11 || query.rankId === id(41), criteria: [] })), {});
    });
    const enabledModules = new Set(['custom']);
    const response = await createDashboardService(services).get({ ...context, enabledModules });
    expect(response.data.widgets.find((item) => item.id === 'promotion_ready')).toMatchObject({ count: 1,
      members: [{ memberId: id(11), rankId: id(40), programId: id(30) }] });
    expect(services.ranks.eligibility).toHaveBeenCalledWith(gymId, expect.anything(), enabledModules);
  });
  it('denies an empty role set before reading services', async () => {
    const services = fixtures();
    await expect(createDashboardService(services).get({ ...context, roles: [] })).rejects.toMatchObject({ status: 403 });
    expect(services.members.listMembers).not.toHaveBeenCalled();
  });
});
