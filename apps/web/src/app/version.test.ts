// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('the shared navigation version check', () => {
  const built = { version: '1.3.0', commit: '3'.repeat(40) };
  const navigation = { preload: false, location: { href: '/portal/schedule?day=2026-11-07#classes' } };
  const reloadKey = 'plaingym-version-reload';
  const wallStart = 10_000_000;
  let checkOnNavigation: typeof import('./version.js').checkOnNavigation;
  let followServerVersion: typeof import('./version.js').followServerVersion;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(wallStart);
    vi.resetModules();
    ({ checkOnNavigation, followServerVersion } = await import('./version.js'));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function fixture(remote: typeof built) {
    const values = new Map<string, string>();
    return { built, destination: navigation.location.href, request: vi.fn(async () => Response.json(remote)) as unknown as typeof fetch,
      reload: vi.fn(), storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } };
  }
  it('shares the navigation throttle with kiosk checks after a backward wall-clock jump', async () => {
    const { checkServerVersion } = await import('./version.js');
    const elapsed = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture(built);
    await checkOnNavigation(navigation, { ...f, development: false });
    elapsed.mockReturnValue(59_999);
    vi.setSystemTime(wallStart + 59_999 - 3_600_000);
    await checkServerVersion(f);
    expect(f.request).toHaveBeenCalledOnce();
    elapsed.mockReturnValue(60_000);
    await checkServerVersion(f);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('skips navigation checks during the reload hold and reports the same mismatch at the deadline', async () => {
    const { isStaleVersion, isVersionReloadPending, subscribeToStaleVersion } = await import('./version.js');
    const elapsed = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = { ...fixture({ ...built, version: '1.4.0' }), development: false }, changed = vi.fn();
    const unsubscribe = subscribeToStaleVersion(changed);
    await checkOnNavigation(navigation, f);
    elapsed.mockReturnValue(9_999);
    await checkOnNavigation({ ...navigation, location: { href: '/login' } }, f);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.reload).toHaveBeenCalledOnce();
    expect(isVersionReloadPending()).toBe(true);
    expect(isStaleVersion()).toBe(false);
    expect(changed).not.toHaveBeenCalled();

    elapsed.mockReturnValue(10_000);
    await expect(checkOnNavigation(navigation, f)).rejects.toThrow('could not load');
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.reload).toHaveBeenCalledOnce();
    expect(isVersionReloadPending()).toBe(false);
    expect(isStaleVersion()).toBe(true);
    expect(changed).toHaveBeenCalled();

    elapsed.mockReturnValue(70_000);
    await checkOnNavigation(navigation, { ...f, request: vi.fn(async () => Response.json(built)) });
    expect(isStaleVersion()).toBe(false);
    unsubscribe();
  });
  it('shares the deadline probe and clears the reload marker when versions match', async () => {
    const { checkServerVersion, isVersionReloadPending } = await import('./version.js');
    const elapsed = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture({ ...built, version: '1.4.0' });
    await checkServerVersion(f);
    expect(f.storage.getItem(reloadKey)).toBe('1.4.0:' + built.commit);
    elapsed.mockReturnValue(10_000);
    const reply = Promise.withResolvers<Response>();
    const request = vi.fn(() => reply.promise);
    const pending = checkServerVersion({ ...f, request });
    expect(checkServerVersion({ ...f, request })).toBe(pending);
    expect(request).toHaveBeenCalledOnce();
    reply.resolve(Response.json(built));
    await pending;
    expect(f.storage.getItem(reloadKey)).toBeNull();
    expect(isVersionReloadPending()).toBe(false);
    expect(f.reload).toHaveBeenCalledOnce();
  });
  it('consumes the reload deadline when the probe fails and retries ten seconds later', async () => {
    const { checkServerVersion } = await import('./version.js');
    const elapsed = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture({ ...built, version: '1.4.0' });
    await checkServerVersion(f);
    const request = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(Response.json(built));
    elapsed.mockReturnValue(10_000);
    await checkServerVersion({ ...f, request });
    elapsed.mockReturnValue(19_999);
    await checkServerVersion({ ...f, request });
    expect(request).toHaveBeenCalledOnce();
    elapsed.mockReturnValue(20_000);
    await checkServerVersion({ ...f, request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(f.storage.getItem(reloadKey)).toBeNull();
  });
  it('announces a stale bundle when blocked storage stops the reload', async () => {
    const { checkServerVersion, isStaleVersion, isVersionReloadPending } = await import('./version.js');
    const f = fixture({ ...built, version: '1.4.0' });
    f.storage.getItem = () => { throw new Error('blocked'); };
    await expect(checkServerVersion(f)).rejects.toThrow('blocked');
    expect(f.reload).not.toHaveBeenCalled();
    expect(isStaleVersion()).toBe(true);
    expect(isVersionReloadPending()).toBe(false);
  });
  it.each(['/kiosk', '/kiosk?mode=pin', '/kiosk/'])('lets the tablet render its stale notice after a reload fails at %s', async href => {
    const f = fixture({ ...built, version: '1.4.0' });
    f.storage.setItem(reloadKey, '1.4.0:' + built.commit);
    await expect(checkOnNavigation({ preload: false, location: { href } }, { ...f, development: false })).resolves.toBeUndefined();
    const { isStaleVersion } = await import('./version.js');
    expect(isStaleVersion()).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
  });
  it('checks a real navigation, but neither a hovered link\'s preload nor the development server', async () => {
    const stale = { version: '1.4.0', commit: '4'.repeat(40) };
    const hovered = fixture(stale); await checkOnNavigation({ ...navigation, preload: true }, { ...hovered, development: false });
    const developing = fixture(stale); await checkOnNavigation(navigation, { ...developing, development: true });
    expect(hovered.request).not.toHaveBeenCalled(); expect(developing.request).not.toHaveBeenCalled();
    const navigated = fixture(stale); await checkOnNavigation(navigation, { ...navigated, destination: '/old-page', development: false });
    expect(navigated.reload).toHaveBeenCalledExactlyOnceWith(navigation.location.href);
  });
  it('checks at most once a minute across paths and search changes', async () => {
    const elapsed = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = { ...fixture(built), development: false };
    await checkOnNavigation(navigation, f);
    elapsed.mockReturnValue(59_999);
    await checkOnNavigation({ ...navigation, location: { href: '/portal/schedule?day=2026-11-08' } }, f);
    await checkOnNavigation({ preload: false, location: { href: '/kiosk?mode=pin' } }, f);
    expect(f.request).toHaveBeenCalledOnce();
    elapsed.mockReturnValue(60_000);
    await checkOnNavigation(navigation, f);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('bounds a stalled check and does not let another navigation start a check', async () => {
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
    const retryAt = performance.now() + 10_000;
    vi.spyOn(performance, 'now').mockReturnValue(retryAt);
    await checkOnNavigation(navigation, f);
    expect(f.request).toHaveBeenCalledOnce();
  });
  it.each(['network', 'http', 'malformed'] as const)('keeps the retry throttle after a failed %s check and a forward wall-clock jump', async failure => {
    const elapsed = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = { ...fixture(built), development: false };
    const request = vi.fn().mockResolvedValue(Response.json(built));
    if (failure === 'network') request.mockRejectedValueOnce(new TypeError('offline'));
    else request.mockResolvedValueOnce(failure === 'http' ? new Response(null, { status: 503 }) : Response.json({}));
    f.request = request;
    await checkOnNavigation(navigation, f);
    elapsed.mockReturnValue(9_999);
    vi.setSystemTime(wallStart + 9_999 + 3_600_000);
    await checkOnNavigation(navigation, f);
    expect(request).toHaveBeenCalledOnce();
    elapsed.mockReturnValue(10_000);
    await checkOnNavigation(navigation, f);
    expect(request).toHaveBeenCalledTimes(2);
    elapsed.mockReturnValue(69_999);
    await checkOnNavigation(navigation, f);
    expect(request).toHaveBeenCalledTimes(2);
    elapsed.mockReturnValue(70_000);
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
