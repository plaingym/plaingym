// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followServerVersion } from './version.js';

describe('the shared navigation version check', () => {
  const built = { version: '1.3.0', commit: '3'.repeat(40) };
  const navigation = { preload: false, location: { href: '/portal/schedule?day=2026-11-07#classes' } };
  let checkOnNavigation: typeof import('./version.js').checkOnNavigation;
  beforeEach(async () => { vi.resetModules(); ({ checkOnNavigation } = await import('./version.js')); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function fixture(remote: typeof built) {
    const values = new Map<string, string>();
    return { built, destination: navigation.location.href, request: vi.fn(async () => Response.json(remote)) as unknown as typeof fetch,
      reload: vi.fn(), storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } };
  }
  it('checks a real navigation, but neither a hovered link\'s preload nor the development server', async () => {
    const stale = { version: '1.4.0', commit: '4'.repeat(40) };
    const hovered = fixture(stale); await checkOnNavigation({ ...navigation, preload: true }, { ...hovered, development: false });
    const developing = fixture(stale); await checkOnNavigation(navigation, { ...developing, development: true });
    expect(hovered.request).not.toHaveBeenCalled(); expect(developing.request).not.toHaveBeenCalled();
    const navigated = fixture(stale); await checkOnNavigation(navigation, { ...navigated, destination: '/old-page', development: false });
    expect(navigated.reload).toHaveBeenCalledExactlyOnceWith(navigation.location.href);
  });
  it('checks at most once a minute across paths and search changes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const f = { ...fixture(built), development: false };
    await checkOnNavigation(navigation, f);
    now.mockReturnValue(159_999);
    await checkOnNavigation({ ...navigation, location: { href: '/portal/schedule?day=2026-11-08' } }, f);
    await checkOnNavigation({ preload: false, location: { href: '/kiosk?mode=pin' } }, f);
    expect(f.request).toHaveBeenCalledOnce();
    now.mockReturnValue(160_000);
    await checkOnNavigation(navigation, f);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('bounds a stalled check and does not let another navigation start a check', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const f = { ...fixture(built), development: false };
    f.request = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const started = performance.now();
    const pending = checkOnNavigation(navigation, f);
    await checkOnNavigation(navigation, f);
    await pending;
    expect(performance.now() - started).toBeLessThan(2500);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.reload).not.toHaveBeenCalled();
    f.request = vi.fn(async () => Response.json(built));
    await checkOnNavigation(navigation, f);
    expect(f.request).not.toHaveBeenCalled();
    now.mockReturnValue(110_000);
    await checkOnNavigation(navigation, f);
    expect(f.request).toHaveBeenCalledOnce();
  });
  it.each(['network', 'http', 'malformed'] as const)('waits ten seconds after a failed %s check, then a minute after an answer', async failure => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const f = { ...fixture(built), development: false };
    const request = vi.fn().mockResolvedValue(Response.json(built));
    if (failure === 'network') request.mockRejectedValueOnce(new TypeError('offline'));
    else request.mockResolvedValueOnce(failure === 'http' ? new Response(null, { status: 503 }) : Response.json({}));
    f.request = request;
    await checkOnNavigation(navigation, f);
    now.mockReturnValue(109_999);
    await checkOnNavigation(navigation, f);
    expect(request).toHaveBeenCalledOnce();
    now.mockReturnValue(110_000);
    await checkOnNavigation(navigation, f);
    expect(request).toHaveBeenCalledTimes(2);
    now.mockReturnValue(169_999);
    await checkOnNavigation(navigation, f);
    expect(request).toHaveBeenCalledTimes(2);
    now.mockReturnValue(170_000);
    await checkOnNavigation(navigation, f);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it.each(['/portal/schedule#classes', '/portal/schedule', '/portal/schedule?day=tomorrow', '/admin'])('loads the destination with the default reload: %s', async destination => {
    const location = { href: 'https://gym.example.test/portal/schedule#old', hash: '#old', assign: vi.fn(), reload: vi.fn() };
    const history = { state: { route: true }, replaceState: vi.fn() };
    vi.stubGlobal('window', { location, history });
    const f = fixture({ ...built, version: '1.4.0' });
    await followServerVersion({ built: f.built, request: f.request, storage: f.storage, destination });
    if (destination === '/portal/schedule#classes' || destination === '/portal/schedule') {
      if (destination.includes('#')) expect(location.hash).toBe('#classes');
      else expect(history.replaceState).toHaveBeenCalledExactlyOnceWith(history.state, '', 'https://gym.example.test/portal/schedule');
      expect(location.reload).toHaveBeenCalledOnce();
      expect(location.assign).not.toHaveBeenCalled();
    } else {
      expect(location.assign).toHaveBeenCalledExactlyOnceWith(destination);
      expect(location.reload).not.toHaveBeenCalled();
    }
  });
  it('keeps the page when the running version and commit match', async () => {
    const f = fixture(built); await followServerVersion(f); expect(f.reload).not.toHaveBeenCalled();
  });
  it.each(['1.2.0', '1.4.0'])('reloads on rollback or upgrade to %s and prevents a reload loop', async (version) => {
    const f = fixture({ version, commit: '2'.repeat(40) });
    await followServerVersion(f); expect(f.reload).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith('/healthz', expect.objectContaining({ cache: 'no-store' }));
    await expect(followServerVersion(f)).rejects.toThrow('could not load');
    expect(f.reload).toHaveBeenCalledOnce();
  });
  it('notices a changed commit even when the version is unchanged', async () => {
    const f = fixture({ ...built, commit: '4'.repeat(40) }); await followServerVersion(f); expect(f.reload).toHaveBeenCalledOnce();
  });
  it('keeps an open page through network failures', async () => {
    const f = fixture(built); f.request = vi.fn().mockRejectedValue(new TypeError('offline'));
    await followServerVersion(f); expect(f.reload).not.toHaveBeenCalled();
  });
  it('clears the stale-asset guard after receiving matching assets', async () => {
    const f = fixture({ version: '1.4.0', commit: '4'.repeat(40) });
    await followServerVersion(f);
    await followServerVersion({ ...f, built: { version: '1.4.0', commit: '4'.repeat(40) } });
    await followServerVersion(f);
    expect(f.reload).toHaveBeenCalledTimes(2);
  });
  it.each([null, { version: '1.4.0' }, { version: 4, commit: 'unknown' }])('ignores malformed health identity %j', async (remote) => {
    const f = fixture(built); f.request = vi.fn(async () => Response.json(remote));
    await followServerVersion(f); expect(f.reload).not.toHaveBeenCalled();
  });
  it('compares unknown archive identities normally', async () => {
    const f = fixture(built);
    await followServerVersion({ ...f, built: { version: '0.4.0+unknown', commit: 'unknown' },
      request: vi.fn(async () => Response.json({ version: '0.4.0+unknown', commit: 'unknown' })) });
    expect(f.reload).not.toHaveBeenCalled();
  });
});
