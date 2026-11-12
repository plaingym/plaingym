// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { memberSchema, type ListResponse, type MatDashboardWidget } from '@plaingym/shared/contracts';
import { FakeAttendanceQueries } from '../../core/interfaces/attendance.js';
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
function fixtures(roster = [member(10)]) {
  const widget: Extract<MatDashboardWidget, { id: 'not_seen' }> = {
    id: 'not_seen', titleKey: 'dashboard/dashboard:widget.not_seen', status: 'ready', days: 14, count: 105,
    members: Array.from({ length: 100 }, (_, index) => ({ memberId: id(index + 10), firstName: 'Member', lastName: 'Test', lastSeenAt: null })),
  };
  const services: MatWidgetServices = {
    // Canned dependency; visit boundaries are tested against the real PostgreSQL read.
    notSeen: Object.assign(vi.fn(async () => widget), { lastSeen: vi.fn(async () => new Map<string, string | null>()) }),
    members: { listMembers: vi.fn(async (_gymId, input) => page(roster, input)) },
    attendance: new FakeAttendanceQueries(),
    ranks: { dashboardEligibility: vi.fn(async () => []) },
  };
  return services;
}
const context = { gymId, roles: ['owner'] as const, clock };
describe('mat widget service logic', () => {
  it('forwards the capped read result and skips promotion reads without permission', async () => {
    const services = fixtures(Array.from({ length: 105 }, (_, index) => member(index + 10)));
    const { data } = await createDashboardService(services).get({ ...context, roles: ['front_desk'] });
    expect(data.widgets.find((widget) => widget.id === 'active_members')).toHaveProperty('count', 105);
    const unseen = data.widgets.find((widget) => widget.id === 'not_seen');
    expect(unseen).toHaveProperty('count', 105);
    expect(unseen && 'members' in unseen ? unseen.members : []).toHaveLength(100);
    expect(data.widgets.map((widget) => widget.id)).not.toContain('promotion_ready');
    expect(services.ranks.dashboardEligibility).not.toHaveBeenCalled();
    expect(services.members.listMembers).toHaveBeenCalledTimes(1);
  });
  it('forwards modules to batch eligibility and reads displayed last visits once', async () => {
    const services = fixtures([member(10), member(11)]);
    services.ranks.dashboardEligibility = vi.fn(async () => [{ memberId: id(11), firstName: 'Member', lastName: '011', programId: id(30), rankId: id(40) }]);
    services.notSeen.lastSeen = vi.fn(async () => new Map([[id(11), '2026-10-01T12:00:00.000Z']]));
    const enabledModules = new Set(['custom']);
    const response = await createDashboardService(services).get({ ...context, enabledModules });
    expect(response.data.widgets.find((item) => item.id === 'promotion_ready')).toMatchObject({ count: 1,
      members: [{ memberId: id(11), rankId: id(40), programId: id(30) }] });
    expect(services.ranks.dashboardEligibility).toHaveBeenCalledWith(gymId, enabledModules);
    expect(services.notSeen.lastSeen).toHaveBeenCalledWith(expect.objectContaining({ gymId }), [id(11)]);
    expect(response.data.widgets.find(item => item.id === 'promotion_ready')).toMatchObject({ members: [{ lastSeenAt: '2026-10-01T12:00:00.000Z' }] });
  });
  it('denies an empty role set before reading services', async () => {
    const services = fixtures();
    await expect(createDashboardService(services).get({ ...context, roles: [] })).rejects.toMatchObject({ status: 403 });
    expect(services.members.listMembers).not.toHaveBeenCalled();
  });
});
