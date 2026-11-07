// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { checkOnNavigation, followServerVersion } from './version.js';

describe('the shared navigation version check', () => {
  const built = { version: '1.3.0', commit: '3'.repeat(40) };
  function fixture(remote: typeof built) {
    const values = new Map<string, string>();
    return { built, request: vi.fn(async () => Response.json(remote)) as unknown as typeof fetch,
      reload: vi.fn(), storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } };
  }
  it('checks a real navigation, but neither a hovered link\'s preload nor the development server', async () => {
    const stale = { version: '1.4.0', commit: '4'.repeat(40) };
    const hovered = fixture(stale); await checkOnNavigation({ preload: true }, { ...hovered, development: false });
    const developing = fixture(stale); await checkOnNavigation({ preload: false }, { ...developing, development: true });
    expect(hovered.request).not.toHaveBeenCalled(); expect(developing.request).not.toHaveBeenCalled();
    const navigated = fixture(stale); await checkOnNavigation({ preload: false }, { ...navigated, development: false });
    expect(navigated.reload).toHaveBeenCalledOnce();
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
});
