// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { staffPermissions, memberPermissions, staffRoles, type StaffPermission, type MemberPermission, type RoutePermission } from '@plaingym/shared';
import { authorize } from './auth.permissions.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { areaContributions } from '../../core/registry-areas.js';

function appFor(principal: Principal, permission: RoutePermission) {
  const app = new Hono<RequestEnvironment>();
  app.use('*', async (context, next) => {
    context.set('context', { requestId: 'test', gym: { gymId: 'a', timezone: 'UTC', enabledModules: new Set() }, principal, clock: new TestClock('2026-10-22') });
    await next();
  });
  app.get('/', authorize(permission), (context) => context.json({ ok: true }));
  return app;
}
describe('permission middleware matrix', () => {
  for (const capability of Object.keys(staffPermissions) as StaffPermission[]) {
    for (const role of staffRoles) it(`${role}: ${capability}`, async () => {
      const permission: RoutePermission = { kind: 'staff', capability };
      const allowed: readonly string[] = staffPermissions[capability];
      expect((await appFor({ kind: 'staff', userId: 'user', gymId: 'a', roles: [role] }, permission).request('/')).status).toBe(allowed.includes(role) ? 200 : 403);
      expect((await appFor({ kind: 'anonymous' }, permission).request('/')).status).toBe(401);
      expect((await appFor({ kind: 'staff', userId: 'user', gymId: 'b', roles: [role] }, permission).request('/')).status).toBe(403);
      expect((await appFor({ kind: 'member', userId: 'user', scope: { gymId: 'a', householdId: 'home', role: 'payer' } }, permission).request('/')).status).toBe(403);
    });
  }
  for (const capability of Object.keys(memberPermissions) as MemberPermission[]) {
    for (const role of ['payer', 'member'] as const) it(`${role}: ${capability}`, async () => {
      const permission: RoutePermission = { kind: 'member', capability };
      const allowed: readonly string[] = memberPermissions[capability];
      expect((await appFor({ kind: 'member', userId: 'user', scope: { gymId: 'a', householdId: 'h', role, memberId: 'm' } }, permission).request('/')).status).toBe(allowed.includes(role) ? 200 : 403);
      expect((await appFor({ kind: 'anonymous' }, permission).request('/')).status).toBe(401);
      expect((await appFor({ kind: 'staff', userId: 'user', gymId: 'a', roles: ['owner'] }, permission).request('/')).status).toBe(403);
      expect((await appFor({ kind: 'member', userId: 'user', scope: { gymId: 'b', householdId: 'h', role, memberId: 'm' } }, permission).request('/')).status).toBe(403);
    });
  }
  it('requires opt-in public access and scopes kiosks and signed links', async () => {
    expect((await appFor({ kind: 'anonymous' }, { kind: 'public' }).request('/')).status).toBe(200);
    for (const gymId of ['a', 'b']) {
      expect((await appFor({ kind: 'kiosk', gymId, deviceId: 'device' }, { kind: 'kiosk', capability: 'checkin' }).request('/')).status).toBe(gymId === 'a' ? 200 : 403);
      expect((await appFor({ kind: 'signed_link', gymId, linkId: 'l', householdId: 'h', link: { purpose: 'update_card' } }, { kind: 'signed_link', purpose: 'update_card' }).request('/')).status).toBe(gymId === 'a' ? 200 : 403);
      expect((await appFor({ kind: 'signed_link', gymId, linkId: 'l', householdId: 'h', link: { purpose: 'onboarding' } }, { kind: 'signed_link', purpose: 'update_card' }).request('/')).status).toBe(403);
    }
  });
  it('inventories every registered route permission', () => {
    expect(areaContributions.routes?.length).toBeGreaterThan(0);
    for (const route of areaContributions.routes ?? []) expect(route.definition.permission).toBeDefined();
  });
});
