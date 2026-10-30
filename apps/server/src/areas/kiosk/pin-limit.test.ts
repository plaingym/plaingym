// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { matDashboardResponseSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createApp } from '../../app.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { configureDashboard } from '../dashboard/dashboard.routes.js';
import { createMembersService } from '../members/members.js';
import { createPromotionCriteria } from '../ranks/criteria.js';
import { createRanksService } from '../ranks/ranks.service.js';
import { authorize } from '../staff/auth.permissions.js';
import { createPinLimitAudit, createPinLimitWidgetProvider, pinLimitReachedAction } from './pin-limit.js';

const database = useTestDatabase(), factory = createFactories(database);
const hour = 60 * 60 * 1000;

async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-30T12:00:00Z');
  await factory('gyms', gymId);
  const devices = [(await factory('kioskDevices', gymId)).id, (await factory('kioskDevices', gymId)).id];
  return { gymId, clock, devices };
}
const audit = createPinLimitAudit({ scope: database.forGym });
const reached = (gymId: string, deviceId: string, occurredAt: Date) =>
  audit({ gymId, deviceId, limit: 10, occurredAt, windowEndsAt: new Date(occurredAt.getTime() + 60_000) });

describe('kiosk PIN limit widget', () => {
  it('audits the device as the actor', async () => {
    const f = await fixture();
    await reached(f.gymId, f.devices[0]!, f.clock.now());
    const rows = await database.forGym(f.gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, pinLimitReachedAction)));
    expect(rows).toEqual([expect.objectContaining({ actorKind: 'device', actorDeviceId: f.devices[0], actorUserId: null,
      targetType: 'kiosk_device', targetId: f.devices[0], after: { limit: 10, windowEndsAt: '2026-10-30T12:01:00.000Z' } })]);
  });
  it('counts each device that hit the limit in the last 24 hours once, within its own gym', async () => {
    const f = await fixture(), other = await fixture();
    const widget = createPinLimitWidgetProvider({ scope: database.forGym });
    const read = (gymId = f.gymId) => widget.read({ gymId, roles: ['owner'], clock: f.clock });
    // Shown with a zero count until empty widgets can hide.
    expect(await read()).toEqual({ id: 'kiosk.pin-limits', titleKey: 'kiosk/devices:pinLimitTitle', status: 'ready', kind: 'count', count: 0 });
    const now = f.clock.now().getTime();
    await reached(f.gymId, f.devices[0]!, new Date(now - hour));
    await reached(f.gymId, f.devices[0]!, new Date(now - 2 * hour));
    await reached(f.gymId, f.devices[1]!, new Date(now - 24 * hour));
    await reached(other.gymId, other.devices[0]!, new Date(now - hour));
    // Other device audits don't count.
    await database.forGym(f.gymId, (tx) => writeAudit(tx, { gymId: f.gymId, actorKind: 'system', action: 'kiosk.device.revoked',
      targetType: 'kiosk_device', targetId: f.devices[1]!, occurredAt: new Date(now) }));
    expect(await read()).toHaveProperty('count', 1);
    expect(await read(other.gymId)).toHaveProperty('count', 1);
    await reached(f.gymId, f.devices[1]!, new Date(now - 23 * hour));
    expect(await read()).toHaveProperty('count', 2);
    f.clock.advance(23 * hour);
    expect(await read()).toHaveProperty('count', 0);
    for (const role of ['coach', 'front_desk'] as StaffRole[])
      await expect(widget.read({ gymId: f.gymId, roles: [role], clock: f.clock })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('shows the widget only to device managers through createApp and the production registrations', async () => {
    const f = await fixture(), foreign = await fixture();
    await reached(f.gymId, f.devices[0]!, f.clock.now());
    await reached(foreign.gymId, foreign.devices[0]!, f.clock.now());
    await reached(foreign.gymId, foreign.devices[1]!, f.clock.now());
    const provider = createPinLimitWidgetProvider({ scope: database.forGym }), read = vi.spyOn(provider, 'read');
    const attendance = createAttendanceQueries({ scope: database.forGym, clock: f.clock });
    configureDashboard({ members: createMembersService({ scope: database.forGym, clock: f.clock }),
      ranks: createRanksService({ scope: database.forGym, clock: f.clock, criteria: createPromotionCriteria(attendance) }), attendance }, [provider]);
    const owner = await factory('authUser', f.gymId), foreignOwner = await factory('authUser', foreign.gymId);
    let principal: Principal = { kind: 'anonymous' };
    const app = createApp({ contributions: areaContributions, clock: f.clock, authorize, setupToken: 'test-setup-token',
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'),
        gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); } });
    for (const role of staffRoles) {
      read.mockClear(); principal = { kind: 'staff', gymId: f.gymId, userId: owner.id, roles: [role] };
      const response = await app.request('/api/dashboard'); expect(response.status).toBe(200);
      const { data } = matDashboardResponseSchema.parse(await response.json());
      const widget = data.widgets.find((entry) => entry.id === 'kiosk.pin-limits');
      if (role === 'owner' || role === 'admin') expect(widget).toHaveProperty('count', 1);
      else { expect(widget).toBeUndefined(); expect(read).not.toHaveBeenCalled(); }
    }
    principal = { kind: 'staff', gymId: foreign.gymId, userId: foreignOwner.id, roles: ['owner'] };
    expect((await app.request('/api/dashboard')).status).toBe(403);
    expect(await database.forGym(f.gymId, (tx) => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, pinLimitReachedAction), eq(auditEvents.actorDeviceId, foreign.devices[0]!))))).toEqual([]);
  });
});
