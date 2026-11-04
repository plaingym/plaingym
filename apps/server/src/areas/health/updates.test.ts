// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { AppError, errorResponse, staffRoles } from '@plaingym/shared';
import { healthTileSchema, updateAvailableResponseSchema } from '@plaingym/shared/contracts';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import {
  compareVersions, createReleaseCheck, createUpdateAvailableProvider, parseVersion, releaseRepository, releasesApiUrl, releasesApiUrlFor, updateKind,
  type ReleaseCheck,
} from './updates.js';
import { configureUpdateRoutes, createUpdateRoutes } from './updates.routes.js';
import { staleAfterHours, type AutoUpdateAttempt, type AutoUpdateState } from './auto-update.js';

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

/** The URL of a fetcher's first call. */
const firstUrl = (fetcher: { mock: { calls: unknown[][] } }) => fetcher.mock.calls[0]?.[0];
/** Lets a background request finish; a read never waits for it. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
/** The first read answers null at once and starts the request; this reads again once it has landed. */
async function settled(check: ReleaseCheck, at: Date) {
  await check.latest(at);
  await flush();
  return check.latest(at);
}

describe('release check', () => {
  it('answers null at once while the first request is still running, without asking again', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
    const check = createReleaseCheck({ fetch: fetcher });
    expect(await check.latest(clock.now())).toBeNull();
    expect(await check.latest(clock.now())).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reports when its last request failed, until one succeeds, and not while the first is still running', async () => {
    let online = false;
    const check = createReleaseCheck({ fetch: async () => { if (!online) throw new TypeError('fetch failed'); return new Response(JSON.stringify(release('v1.3.0'))); } });
    expect(check.failedAt?.()).toBeNull();
    await settled(check, clock.now());
    expect(check.failedAt?.()).toEqual(clock.now());
    online = true;
    expect((await settled(check, new Date(clock.now().getTime() + hour)))?.version).toBe('1.3.0');
    expect(check.failedAt?.()).toBeNull();
    const hanging = createReleaseCheck({ fetch: () => new Promise<Response>(() => undefined) });
    await hanging.latest(clock.now());
    expect(hanging.failedAt?.()).toBeNull();
  });
  it('asks the public releases list without credentials, then serves the answer for a day', async () => {
    const fetcher = vi.fn(answer(release('v1.3.0')));
    const check = createReleaseCheck({ fetch: fetcher });
    expect(await check.latest(clock.now())).toBeNull();
    const first = await settled(check, clock.now());
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
    expect(await settled(check, clock.now())).toBeNull();
    await check.latest(new Date(clock.now().getTime() + hour - 1));
    expect(fetcher).toHaveBeenCalledTimes(1);
    online = true;
    const later = new Date(clock.now().getTime() + hour);
    expect((await settled(check, later))?.version).toBe('1.3.0');
    online = false;
    // The day passes, GitHub is down: the cached answer still comes back at once.
    const tomorrow = new Date(later.getTime() + day);
    expect((await check.latest(tomorrow))?.version).toBe('1.3.0');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await flush();
    expect((await check.latest(new Date(tomorrow.getTime() + hour - 1)))?.version).toBe('1.3.0');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('shares one request between concurrent callers', async () => {
    const fetcher = vi.fn(answer(release('v1.3.0')));
    const check = createReleaseCheck({ fetch: fetcher });
    await Promise.all([check.latest(clock.now()), check.latest(clock.now()), check.latest(clock.now())]);
    await flush();
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
    ['a release page of another repository', answer(release('v9.0.0', { html_url: 'https://github.com/other/repo/releases/tag/v9.0.0' }))],
  ])('ignores %s', async (_name, fetcher) => {
    expect(await settled(createReleaseCheck({ fetch: fetcher }), clock.now())).toBeNull();
  });
  it('releases the body of a refused answer', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new TextEncoder().encode('{}')); },
      cancel() { cancelled = true; } }, { highWaterMark: 0 });
    expect(await settled(createReleaseCheck({ fetch: async () => new Response(body, { status: 503 }) }), clock.now())).toBeNull();
    expect(cancelled).toBe(true);
  });
  it('refuses a declared length over the limit without reading the body', async () => {
    let pulled = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode('{}')); controller.close(); },
      cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const fetcher = vi.fn(async () => new Response(body, { headers: { 'content-length': String(300_000) } }));
    expect(await settled(createReleaseCheck({ fetch: fetcher }), clock.now())).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(pulled).toBe(0);
    expect(cancelled).toBe(true);
  });
  it('stops reading a stream that passes the limit, counting bytes', async () => {
    let pulled = 0, cancelled = false;
    // No length is declared and the stream never ends; two 200 KiB chunks pass 256 KiB.
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(200 * 1024).fill(32)); },
      cancel() { cancelled = true; } }, { highWaterMark: 0 });
    expect(await settled(createReleaseCheck({ fetch: async () => new Response(body) }), clock.now())).toBeNull();
    expect(pulled).toBe(2);
    expect(cancelled).toBe(true);
  });
  it('counts bytes, not characters: a multi-byte answer over the limit is refused', async () => {
    // 100,000 characters of 3 bytes each: under the limit as text, over it as bytes.
    expect(await settled(createReleaseCheck({ fetch: answer('€'.repeat(100_000)) }), clock.now())).toBeNull();
  });
  it('reads the repository it is given and only accepts a release page under it', async () => {
    const page = (repository: string) => release('v1.3.0', { html_url: `https://github.com/${repository}/releases/tag/v1.3.0` });
    const fetcher = vi.fn(answer(page('Example/App')));
    const check = createReleaseCheck({ fetch: fetcher, repository: 'example/app' });
    expect(await settled(check, clock.now())).toMatchObject({ version: '1.3.0', url: 'https://github.com/Example/App/releases/tag/v1.3.0' });
    expect(firstUrl(fetcher)).toBe(releasesApiUrlFor('example/app'));
    expect(releasesApiUrlFor('example/app')).toBe('https://api.github.com/repos/example/app/releases/latest');
    expect(await settled(createReleaseCheck({ fetch: answer(page('plaingym/plaingym')), repository: 'example/app' }), clock.now())).toBeNull();
  });
});

const check = (version: string): ReleaseCheck => ({ latest: async (now) => ({ version, url: `https://github.com/plaingym/plaingym/releases/tag/v${version}`, checkedAt: now }) });
const context = { gymId: gymA, roles: ['owner'] as ['owner'], clock };
const attempt = (fields: Partial<AutoUpdateAttempt>): AutoUpdateAttempt =>
  ({ attemptedAt: new Date(clock.now().getTime() - 10 * hour).toISOString(), result: 'up_to_date', reason: null, fromVersion: 'v1.2.0', toVersion: null, ...fields });
const nightly = (over: Partial<AutoUpdateState> = {}): AutoUpdateState => ({ enabled: true, attempt: attempt({}), ...over });
async function probe(env: NodeJS.ProcessEnv, release: ReleaseCheck = check('1.3.0'), state: AutoUpdateState | Error = nightly()) {
  const automatic = vi.fn(async () => { if (state instanceof Error) throw state; return state; });
  return { tile: healthTileSchema.parse(await createUpdateAvailableProvider({ env: { APP_VERSION: '1.2.0', ...env }, check: release, automatic }).read(context)), automatic };
}
const tile = async (...args: Parameters<typeof probe>) => (await probe(...args)).tile;
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
  it('answers unavailable, with no check time, without waiting for a first check that is still running', async () => {
    const hanging = createReleaseCheck({ fetch: () => new Promise<Response>(() => undefined) });
    expect(await tile({}, hanging)).toMatchObject({ status: 'unavailable', checkedAt: null, details: null, message: expect.stringContaining('for the first time') });
  });
  it('tells a request that failed from the first one still running: unavailable with the time it failed, and its own message', async () => {
    const failing = createReleaseCheck({ fetch: async () => { throw new TypeError('fetch failed'); } });
    await failing.latest(clock.now());
    await flush();
    const result = await tile({}, failing);
    expect(result).toMatchObject({ status: 'unavailable', checkedAt: clock.now().toISOString(), details: null,
      message: expect.stringContaining('could not be read from GitHub') });
    expect(result.message).toContain('UPDATE_CHECK=off');
  });
  describe('a newer patch', () => {
    const patch = check('1.2.5');
    const stale = new Date(clock.now().getTime() - (staleAfterHours + 1) * hour).toISOString();
    it.each([
      ['automatic updates are off', nightly({ enabled: false })],
      ['the last attempt skipped', nightly({ attempt: attempt({ result: 'skipped', reason: 'backups_not_configured' }) })],
      ['the last attempt skipped on a bad signature', nightly({ attempt: attempt({ result: 'skipped', reason: 'signature_invalid', toVersion: 'v1.2.5' }) })],
      ['the last attempt was rolled back', nightly({ attempt: attempt({ result: 'rolled_back', reason: 'health_check_failed', toVersion: 'v1.2.5' }) })],
      ['the last attempt failed', nightly({ attempt: attempt({ result: 'failed', reason: 'rollback_failed', toVersion: 'v1.2.5' }) })],
      ['no check has run for days', nightly({ attempt: attempt({ attemptedAt: stale }) })],
    ])('raises the banner when %s', async (_name, state) => {
      const result = await tile({}, patch, state);
      expect(result).toMatchObject({ status: 'warning', details: { available: true, currentVersion: '1.2.0', latestVersion: '1.2.5',
        releaseUrl: 'https://github.com/plaingym/plaingym/releases/tag/v1.2.5' } });
      expect(result.message).toContain('has not installed by itself');
    });
    it('says why: the switch, or the reason the last attempt gave', async () => {
      expect((await tile({}, patch, nightly({ enabled: false }))).message).toContain('Turn them on in Settings → Updates');
      expect((await tile({}, patch, nightly({ attempt: attempt({ result: 'skipped', reason: 'backups_not_configured' }) }))).message)
        .toContain("Backups aren't set up");
    });
    it('points to the by-hand update only where that is the right step: the switch off, or a stopped timer', async () => {
      for (const state of [nightly({ enabled: false }), nightly({ attempt: attempt({ attemptedAt: stale }) })]) {
        const { message } = await tile({}, patch, state);
        expect(message).toContain('update by hand as the updating guide describes');
        expect(message).not.toContain('Run the updater');
      }
    });
    it.each(['signature_invalid', 'digest_mismatch', 'manifest_invalid', 'migration_in_patch'] as const)(
      'says not to install a release the updater refused on purpose by hand: %s', async (reason) => {
        const { message } = await tile({}, patch, nightly({ attempt: attempt({ result: 'skipped', reason, toVersion: 'v1.2.5' }) }));
        expect(message).toContain('Do not install this release by hand: wait for a fixed release.');
        expect(message).not.toContain('update by hand');
        expect(message).not.toContain('Run the updater');
      });
    it.each([
      ['skipped', 'backups_not_configured'], ['skipped', 'release_list_unavailable'], ['rolled_back', 'health_check_failed'], ['failed', 'rollback_failed'],
    ] as const)('leaves the advice to the reason when the last attempt %s: %s', async (result, reason) => {
      const { message } = await tile({}, patch, nightly({ attempt: attempt({ result, reason, toVersion: 'v1.2.5' }) }));
      expect(message).not.toContain('by hand');
      expect(message).not.toContain('Run the updater');
    });
    it.each([
      ['skipped', 'signature_invalid'], ['rolled_back', 'health_check_failed'], ['failed', 'rollback_failed'],
    ] as const)('stays quiet when the last attempt (%s: %s) was about an older release than the newest one', async (result, reason) => {
      expect(await tile({}, patch, nightly({ attempt: attempt({ result, reason, toVersion: 'v1.2.4' }) })))
        .toMatchObject({ status: 'healthy', details: { available: false, latestVersion: '1.2.5' } });
    });
    it('still holds the release the last attempt was about, and one it cannot compare', async () => {
      for (const toVersion of ['v1.2.5', '1.2.5', '0.0.0-dev', null])
        expect(await tile({}, patch, nightly({ attempt: attempt({ result: 'skipped', reason: 'pull_failed', toVersion }) })), String(toVersion))
          .toMatchObject({ status: 'warning', details: { available: true } });
    });
    it('holds a newer patch back for the switch and the timer however old the last attempt was about', async () => {
      const older = { result: 'skipped', reason: 'signature_invalid', toVersion: 'v1.2.4' } as const;
      expect(await tile({}, patch, nightly({ enabled: false, attempt: attempt(older) }))).toMatchObject({ status: 'warning', details: { available: true } });
      expect(await tile({}, patch, nightly({ attempt: attempt({ ...older, attemptedAt: stale }) }))).toMatchObject({ status: 'warning', details: { available: true } });
    });
    it.each([
      ['the last check found nothing newer', nightly()],
      ['the last check installed an update', nightly({ attempt: attempt({ result: 'updated', toVersion: 'v1.2.4' }) })],
      ['automatic updates were just turned back on', nightly({ attempt: attempt({ result: 'skipped', reason: 'disabled' }) })],
      ['no check has run yet', nightly({ attempt: null })],
    ])("stays quiet when %s, since tonight's check installs it", async (_name, state) => {
      expect(await tile({}, patch, state)).toMatchObject({ status: 'healthy', details: { available: false, latestVersion: '1.2.5' },
        message: 'Version 1.2.5 is a patch release. It applies automatically; this install runs 1.2.0.' });
    });
    it('stays quiet when the setting and attempt cannot be read', async () => {
      expect(await tile({}, patch, new Error('database down'))).toMatchObject({ status: 'healthy', details: { available: false } });
    });
    it('is never asked about for a release that is not a patch', async () => {
      for (const version of ['1.3.0', '1.2.0', '1.1.0']) {
        const { automatic } = await probe({}, check(version), nightly({ enabled: false }));
        expect(automatic, version).not.toHaveBeenCalled();
      }
      expect(await tile({}, check('1.3.0'), nightly({ enabled: false }))).toMatchObject({
        message: 'Version 1.3.0 is available. This install runs 1.2.0. Run the updater on the server to install it.' });
    });
  });
  describe('the repository', () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    const readFrom = async (env: NodeJS.ProcessEnv, name: string) => {
      const page = `https://github.com/${name}/releases/tag/v1.3.0`;
      const fetcher = vi.fn(async () => new Response(JSON.stringify(release('v1.3.0', { html_url: page }))));
      vi.stubGlobal('fetch', fetcher);
      const provider = createUpdateAvailableProvider({ env: { APP_VERSION: '1.2.0', ...env }, automatic: async () => nightly() });
      const first = healthTileSchema.parse(await provider.read(context));
      await flush();
      return { fetcher, first, second: healthTileSchema.parse(await provider.read(context)), page };
    };
    it('is read from RELEASE_REPOSITORY, the one the updater follows', async () => {
      const { fetcher, first, second, page } = await readFrom({ RELEASE_REPOSITORY: ' example/read-from ' }, 'example/read-from');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(firstUrl(fetcher)).toBe(releasesApiUrlFor('example/read-from'));
      expect(first.status).toBe('unavailable');
      expect(second).toMatchObject({ status: 'warning', details: { latestVersion: '1.3.0', releaseUrl: page } });
    });
    it('is the official one when unset or empty', async () => {
      expect(releaseRepository({})).toBe('plaingym/plaingym');
      const { fetcher } = await readFrom({ RELEASE_REPOSITORY: '  ' }, 'plaingym/plaingym');
      expect(firstUrl(fetcher)).toBe(releasesApiUrl);
    });
    it.each(['example', 'a/b/c', 'https://github.com/example/app', 'exa mple/app'])('is not read when %s is not owner/name', async (value) => {
      const { fetcher, first } = await readFrom({ RELEASE_REPOSITORY: value }, 'plaingym/plaingym');
      expect(first).toMatchObject({ status: 'not_configured', details: null });
      expect(fetcher).not.toHaveBeenCalled();
    });
  });
  it('is not set up for hosted mode, when switched off, and for a build that is not a release', async () => {
    const never: ReleaseCheck = { latest: vi.fn(async () => null) };
    for (const env of [{ TENANCY: 'multi' }, { UPDATE_CHECK: 'off' }, { UPDATE_CHECK: 'no' }, { UPDATE_CHECK: 'disabled' },
      { APP_VERSION: 'dev' }, { APP_VERSION: '1.2.0-rc.1' }, { APP_VERSION: '0.0.0' }, { APP_VERSION: undefined }]) {
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

function server(principal: Principal, gym = gymA, provider: ReturnType<typeof createUpdateAvailableProvider> | null = createUpdateAvailableProvider({ env: { APP_VERSION: '1.2.0' }, check: check('1.3.0'), automatic: async () => nightly() })) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => { c.set('context', { gym: { gymId: gym, timezone: 'UTC', enabledModules: new Set() }, principal, clock, requestId: 'test' }); await next(); });
  app.onError((error, c) => c.json(errorResponse(error, 'test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createUpdateRoutes(provider ? () => provider : undefined) }).mount(app, authorize, new Set());
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
  it("reads the environment the runtime configures, as the Health page's tile does", async () => {
    const owner: Principal = { kind: 'staff', gymId: gymA, userId: 'u', roles: ['owner'] };
    const read = async () => updateAvailableResponseSchema.parse(await (await server(owner, gymA, null).request('/api/health/update')).json()).data;
    try {
      configureUpdateRoutes({ env: { APP_VERSION: '1.2.0', UPDATE_CHECK: 'off' }, check: check('1.3.0'), automatic: async () => nightly() });
      expect(await read()).toMatchObject({ status: 'not_configured', details: null });
      configureUpdateRoutes({ env: { APP_VERSION: '1.2.0' }, check: check('1.3.0'), automatic: async () => nightly() });
      expect(await read()).toMatchObject({ status: 'warning', details: { latestVersion: '1.3.0' } });
      configureUpdateRoutes({ env: { APP_VERSION: '1.2.0' }, check: check('1.2.5'), automatic: async () => nightly({ enabled: false }) });
      expect(await read()).toMatchObject({ status: 'warning', details: { latestVersion: '1.2.5', available: true } });
    } finally { configureUpdateRoutes({}); }
  });
});
