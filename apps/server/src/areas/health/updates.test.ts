// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { AppError, errorResponse, staffRoles } from '@plaingym/shared';
import { healthTileSchema, updateAvailableResponseSchema } from '@plaingym/shared/contracts';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import {
  compareVersions, createReleaseCheck, createUpdateAvailableProvider, parseVersion, releasesApiUrl, updateKind, type ReleaseCheck,
} from './updates.js';
import { createUpdateRoutes } from './updates.routes.js';

const clock = new TestClock('2026-11-03T12:00:00Z');
const hour = 3_600_000, day = 24 * hour;
const gymA = '019a0000-0000-7000-8000-00000000000a', gymB = '019a0000-0000-7000-8000-00000000000b';
const release = (tag: string, extra: object = {}) => ({ tag_name: tag, html_url: `https://github.com/plaingym/plaingym/releases/tag/${tag}`, ...extra });
const answer = (body: unknown, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('versions', () => {
  it('reads plain releases only', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('1.10.0')).toEqual({ major: 1, minor: 10, patch: 0 });
    for (const bad of ['1.2', 'v1.2.3-rc.1', '1.2.3+build', '01.2.3', 'latest', '', 'sha256:abc']) expect(parseVersion(bad), bad).toBeNull();
  });
  it('orders numerically and classifies the step', () => {
    const v = (s: string) => parseVersion(s)!;
    expect(compareVersions(v('1.10.0'), v('1.9.9'))).toBeGreaterThan(0);
    expect(updateKind(v('1.2.3'), v('1.2.3'))).toBe('none');
    expect(updateKind(v('1.2.3'), v('1.2.2'))).toBe('none');
    expect(updateKind(v('1.2.3'), v('1.2.4'))).toBe('patch');
    expect(updateKind(v('1.2.3'), v('1.3.0'))).toBe('minor');
    expect(updateKind(v('1.2.3'), v('2.0.0'))).toBe('major');
    expect(updateKind(v('1.9.0'), v('1.10.0'))).toBe('minor');
  });
});

describe('release check', () => {
  it('asks the public releases list without credentials, then serves the answer for a day', async () => {
    const fetcher = vi.fn(answer(release('v1.3.0')));
    const check = createReleaseCheck({ fetch: fetcher });
    const first = await check.latest(clock.now());
    expect(first).toMatchObject({ version: '1.3.0', url: 'https://github.com/plaingym/plaingym/releases/tag/v1.3.0' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(releasesApiUrl);
    expect(JSON.stringify(init.headers).toLowerCase()).not.toContain('authorization');
    await check.latest(new Date(clock.now().getTime() + day - 1));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await check.latest(new Date(clock.now().getTime() + day));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('is offline-tolerant: no answer yet is null, a failure keeps the last good answer and retries within the hour', async () => {
    let online = false;
    const fetcher = vi.fn(async () => { if (!online) throw new TypeError('fetch failed'); return new Response(JSON.stringify(release('v1.3.0'))); });
    const check = createReleaseCheck({ fetch: fetcher });
    expect(await check.latest(clock.now())).toBeNull();
    await check.latest(new Date(clock.now().getTime() + hour - 1));
    expect(fetcher).toHaveBeenCalledTimes(1);
    online = true;
    const later = new Date(clock.now().getTime() + hour);
    expect((await check.latest(later))?.version).toBe('1.3.0');
    online = false;
    // The day passes, GitHub is down: the cached answer still comes back at once.
    const tomorrow = new Date(later.getTime() + day);
    expect((await check.latest(tomorrow))?.version).toBe('1.3.0');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect((await check.latest(new Date(tomorrow.getTime() + hour - 1)))?.version).toBe('1.3.0');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('shares one request between concurrent callers', async () => {
    const fetcher = vi.fn(answer(release('v1.3.0')));
    const check = createReleaseCheck({ fetch: fetcher });
    await Promise.all([check.latest(clock.now()), check.latest(clock.now()), check.latest(clock.now())]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['rate limited', answer({ message: 'rate limit' }, 403)],
    ['not JSON', answer('<html>')],
    ['a draft', answer(release('v9.0.0', { draft: true }))],
    ['a pre-release', answer(release('v9.0.0', { prerelease: true }))],
    ['a non-release tag', answer(release('nightly'))],
    ['a release page on another host', answer({ tag_name: 'v9.0.0', html_url: 'https://evil.example/releases/v9.0.0' })],
    ['a script link', answer({ tag_name: 'v9.0.0', html_url: 'javascript:alert(1)' })],
    ['an oversized answer', answer('x'.repeat(300_000))],
  ])('ignores %s', async (_name, fetcher) => {
    expect(await createReleaseCheck({ fetch: fetcher }).latest(clock.now())).toBeNull();
  });
});

const check = (version: string): ReleaseCheck => ({ latest: async (now) => ({ version, url: `https://github.com/plaingym/plaingym/releases/tag/v${version}`, checkedAt: now }) });
const context = { gymId: gymA, roles: ['owner'] as ['owner'], clock };
async function tile(env: NodeJS.ProcessEnv, release: ReleaseCheck = check('1.3.0')) {
  return healthTileSchema.parse(await createUpdateAvailableProvider({ env: { APP_VERSION: '1.2.0', ...env }, check: release }).read(context));
}
describe('update_available tile', () => {
  it('warns for a newer minor or major and names both versions and the changelog', async () => {
    expect(await tile({})).toMatchObject({ status: 'warning', details: { currentVersion: '1.2.0', latestVersion: '1.3.0', available: true,
      releaseUrl: 'https://github.com/plaingym/plaingym/releases/tag/v1.3.0' } });
    expect(await tile({}, check('2.0.0'))).toMatchObject({ status: 'warning', details: { available: true } });
  });
  it('stays healthy for the same version and for a patch, which applies by itself', async () => {
    expect(await tile({}, check('1.2.0'))).toMatchObject({ status: 'healthy', details: { available: false } });
    expect(await tile({}, check('1.2.5'))).toMatchObject({ status: 'healthy', details: { available: false, latestVersion: '1.2.5' } });
    expect(await tile({}, check('1.2.0'))).toMatchObject({ message: 'This install runs 1.2.0, the latest release.' });
    expect(await tile({}, check('1.1.0'))).toMatchObject({ status: 'healthy', details: { available: false },
      message: 'This install runs 1.2.0, newer than the latest published release, 1.1.0.' });
  });
  it('is unavailable while no release has been read, and never throws', async () => {
    expect(await tile({}, { latest: async () => null })).toMatchObject({ status: 'unavailable', details: null });
  });
  it('is not set up for hosted mode, when switched off, and for a build that is not a release', async () => {
    const never: ReleaseCheck = { latest: vi.fn(async () => null) };
    for (const env of [{ TENANCY: 'multi' }, { UPDATE_CHECK: 'off' }, { UPDATE_CHECK: 'no' }, { UPDATE_CHECK: 'disabled' },
      { APP_VERSION: 'dev' }, { APP_VERSION: '1.2.0-rc.1' }]) {
      expect(await tile(env, never), JSON.stringify(env)).toMatchObject({ status: 'not_configured', details: null });
    }
    expect(never.latest).not.toHaveBeenCalled();
  });
  it('checks when the switch is unset, empty or on', async () => {
    for (const value of [undefined, '', 'on', 'ON', 'true', '1']) {
      expect(await tile(value === undefined ? {} : { UPDATE_CHECK: value }), String(value)).toMatchObject({ status: 'warning' });
    }
  });
});

function server(principal: Principal, gym = gymA, provider = createUpdateAvailableProvider({ env: { APP_VERSION: '1.2.0' }, check: check('1.3.0') })) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => { c.set('context', { gym: { gymId: gym, timezone: 'UTC', enabledModules: new Set() }, principal, clock, requestId: 'test' }); await next(); });
  app.onError((error, c) => c.json(errorResponse(error, 'test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createUpdateRoutes(provider) }).mount(app, authorize, new Set());
  return app;
}
describe('GET /api/health/update', () => {
  it.each(staffRoles)('is for settings managers only: %s', async (role) => {
    const response = await server({ kind: 'staff', gymId: gymA, userId: 'u', roles: [role] }).request('/api/health/update');
    expect(response.status).toBe(role === 'owner' || role === 'admin' ? 200 : 403);
    if (response.ok) {
      expect(updateAvailableResponseSchema.parse(await response.json()).data).toMatchObject({ status: 'warning', details: { available: true } });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
  it('refuses anonymous, kiosk and member principals and another gym\'s staff', async () => {
    expect((await server({ kind: 'anonymous' }).request('/api/health/update')).status).toBe(401);
    expect((await server({ kind: 'kiosk', gymId: gymA, deviceId: 'd' }).request('/api/health/update')).status).toBe(403);
    expect((await server({ kind: 'member', userId: 'u', scope: { gymId: gymA, householdId: 'h', role: 'payer' } }).request('/api/health/update')).status).toBe(403);
    expect((await server({ kind: 'staff', gymId: gymB, userId: 'u', roles: ['owner'] }, gymA).request('/api/health/update')).status).toBeGreaterThanOrEqual(403);
  });
  it('answers unavailable instead of failing when the check breaks', async () => {
    const broken = { id: 'update_available', permission: 'settings.manage', schema: healthTileSchema, read: async () => { throw new Error('boom'); } } as never;
    const response = await server({ kind: 'staff', gymId: gymA, userId: 'u', roles: ['owner'] }, gymA, broken).request('/api/health/update');
    expect(response.status).toBe(200);
    expect(updateAvailableResponseSchema.parse(await response.json()).data.status).toBe('unavailable');
  });
});
