// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { autoUpdateSettingsResponseSchema } from '@plaingym/shared/contracts';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import type { TenancyMode } from '../../core/tenancy.js';
import { authorize } from '../staff/auth.permissions.js';
import { createAutoUpdateSettings } from '../settings/auto-update.js';
import { createAutoUpdateRoutes } from './auto-update.routes.js';

const db = useTestDatabase(), factory = createFactories(db);
const roles = ['owner', 'admin', 'coach', 'front_desk'] as const;
type Role = (typeof roles)[number];
async function fixture(tenancy: TenancyMode = 'single') {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const clock = new TestClock('2026-11-03T12:00:00Z'), user = await factory('authUser', gymId);
  const settings = createAutoUpdateSettings({ scope: db.forGym, clock });
  /** A request as one staff role whose session belongs to `sessionGym`, sent to this gym's host. */
  const request = (role: Role, method: 'GET' | 'PUT' = 'GET', body?: unknown, sessionGym = gymId) => createApp({ clock, authorize, skipSetup: true,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId: sessionGym, userId: user.id, roles: [role] } }); await next(); },
    contributions: { routes: createAutoUpdateRoutes({ settings, tenancy }) },
  }).request('/api/health/auto-update', body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const read = async (response: Response) => autoUpdateSettingsResponseSchema.parse(await response.json()).data;
  return { gymId, settings, request, read };
}

describe('automatic update setting routes', () => {
  it('shows and changes the switch for owners only', async () => {
    const f = await fixture();
    for (const role of roles) {
      expect((await f.request(role)).status, role).toBe(role === 'owner' ? 200 : 403);
      expect((await f.request(role, 'PUT', { enabled: false, revision: 1 })).status, role).toBe(role === 'owner' ? 200 : 403);
    }
    expect(await f.settings.get(f.gymId)).toMatchObject({ enabled: false, revision: 2 });
    const response = await f.request('owner');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await f.read(response)).toEqual({ enabled: false, available: true, revision: 2 });
  });
  it('answers a stale revision 409 and an invalid body 400, changing nothing', async () => {
    const f = await fixture();
    expect(await f.read(await f.request('owner', 'PUT', { enabled: false, revision: 1 }))).toEqual({ enabled: false, available: true, revision: 2 });
    expect((await f.request('owner', 'PUT', { enabled: true, revision: 1 })).status).toBe(409);
    for (const body of [{ enabled: true }, { enabled: 'yes', revision: 2 }, { enabled: true, revision: 2, available: true }, 'invalid'])
      expect((await f.request('owner', 'PUT', body)).status, JSON.stringify(body)).toBe(400);
    expect(await f.settings.get(f.gymId)).toMatchObject({ enabled: false, revision: 2 });
  });
  it('denies another gym\'s owner and leaves both gyms alone', async () => {
    const a = await fixture(), b = await fixture();
    // The session's gym isn't the host's: authorization refuses before the handler, as for the other owner settings.
    expect((await b.request('owner', 'GET', undefined, a.gymId)).status).toBe(403);
    expect((await b.request('owner', 'PUT', { enabled: false, revision: 1 }, a.gymId)).status).toBe(403);
    expect(await b.settings.get(b.gymId)).toMatchObject({ enabled: true, revision: 1 });
    expect(await a.settings.get(a.gymId)).toMatchObject({ enabled: true, revision: 1 });
  });
  it('reads unavailable and refuses changes on an install that serves several gyms', async () => {
    const f = await fixture('multi');
    expect(await f.read(await f.request('owner'))).toEqual({ enabled: true, available: false, revision: 1 });
    expect((await f.request('owner', 'PUT', { enabled: false, revision: 1 })).status).toBe(409);
    expect(await f.settings.get(f.gymId)).toMatchObject({ enabled: true, revision: 1 });
  });
});
