// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryHistory, RouterContextProvider, type AnyRoute } from '@tanstack/react-router';
import { createAppRouter } from '../../../app/router.js';
import { usePortalChunks, warmPortalChunks } from './chunks.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const sections = ['/portal/', '/portal/account/', '/portal/billing/', '/portal/checkin/', '/portal/claim', '/portal/household/', '/portal/progress/', '/portal/schedule/', '/portal/waivers/'];
const app = () => createAppRouter(createMemoryHistory({ initialEntries: ['/portal'] }));
const loadedIds = (load: { mock: { calls: unknown[][] } }) => load.mock.calls.map(([route]) => (route as AnyRoute).id).sort();

it('loads the code of every portal section and nothing outside the portal', async () => {
  const router = app(), load = vi.spyOn(router, 'loadRouteChunk').mockResolvedValue(undefined);
  expect(Object.keys(router.routesById).some((id) => id.startsWith('/admin'))).toBe(true);
  await expect(warmPortalChunks(router)).resolves.toBe(true);
  expect(loadedIds(load)).toEqual(sections);
});

it('reports a rejected load after trying every section', async () => {
  const router = app(), load = vi.spyOn(router, 'loadRouteChunk').mockResolvedValue(undefined);
  load.mockRejectedValueOnce(new Error('offline'));
  await expect(warmPortalChunks(router)).resolves.toBe(false);
  expect(loadedIds(load)).toEqual(sections);
});

it('reports a section whose component still waits for its code after a settled load', async () => {
  // The split component of a built app resolves `preload` even when the import failed, and keeps `preload` then.
  const component = Object.assign(() => null, { preload: async () => undefined });
  const route = { id: '/portal/billing/', options: { component } } as unknown as AnyRoute;
  const router = { routesById: { [route.id]: route }, loadRouteChunk: vi.fn(async () => undefined) } as unknown as Parameters<typeof warmPortalChunks>[0];
  await expect(warmPortalChunks(router)).resolves.toBe(false);
  Object.assign(component, { preload: undefined });
  await expect(warmPortalChunks(router)).resolves.toBe(true);
});

function mount(online: boolean) {
  const connection = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  const router = app(), load = vi.spyOn(router, 'loadRouteChunk').mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => <RouterContextProvider router={router}>{children}</RouterContextProvider>;
  const view = () => renderHook(() => usePortalChunks(), { wrapper });
  const reconnect = () => act(async () => { connection.mockReturnValue(true); window.dispatchEvent(new Event('online')); });
  const navigated = () => act(async () => {
    const { location } = router.state;
    router.emit({ type: 'onResolved', fromLocation: location, toLocation: location, pathChanged: false, hrefChanged: false, hashChanged: false });
  });
  return { load, view, reconnect, navigated };
}

it('waits for the connection, then loads once', async () => {
  const { load, view, reconnect } = mount(false);
  view();
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect(load).not.toHaveBeenCalled();
  await reconnect();
  expect(load).toHaveBeenCalledTimes(sections.length);
  await reconnect();
  expect(load).toHaveBeenCalledTimes(sections.length);
});

it('tries again on the next online event after a failed pass', async () => {
  const { load, view, reconnect } = mount(true);
  load.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { view(); });
  expect(load).toHaveBeenCalledTimes(sections.length);
  await reconnect();
  expect(load).toHaveBeenCalledTimes(sections.length * 2);
  await reconnect();
  expect(load).toHaveBeenCalledTimes(sections.length * 2);
});

it('runs one pass at a time', async () => {
  const { load, view, reconnect } = mount(true);
  let finish!: () => void;
  load.mockReturnValue(new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
  view();
  await reconnect();
  expect(load).toHaveBeenCalledTimes(sections.length);
  await act(async () => { finish(); });
});

it('runs again when the connection returned during a pass that then fails', async () => {
  const { load, view, reconnect } = mount(true);
  let fail!: () => void;
  load.mockReturnValueOnce(new Promise<undefined>((_, reject) => { fail = () => reject(new Error('offline')); }));
  view();
  await reconnect();
  expect(load).toHaveBeenCalledTimes(sections.length);
  await act(async () => { fail(); });
  expect(load).toHaveBeenCalledTimes(sections.length * 2);
});

it('tries again on the next portal navigation after a failed pass', async () => {
  const { load, view, navigated } = mount(true);
  load.mockRejectedValueOnce(new Error('dropped request'));
  await act(async () => { view(); });
  expect(load).toHaveBeenCalledTimes(sections.length);
  await navigated();
  expect(load).toHaveBeenCalledTimes(sections.length * 2);
  await navigated();
  expect(load).toHaveBeenCalledTimes(sections.length * 2);
});

it('loads nothing on a navigation while offline', async () => {
  const { load, view, navigated } = mount(false);
  view();
  await navigated();
  expect(load).not.toHaveBeenCalled();
});

it('loads nothing more once a pass has succeeded', async () => {
  const { load, view, reconnect, navigated } = mount(true);
  await act(async () => { view(); });
  await navigated();
  await reconnect();
  expect(load).toHaveBeenCalledTimes(sections.length);
});

it('does not run again once unmounted during a pass that then fails', async () => {
  const { load, view, navigated } = mount(true);
  let fail!: () => void;
  load.mockReturnValueOnce(new Promise<undefined>((_, reject) => { fail = () => reject(new Error('dropped request')); }));
  const { unmount } = view();
  await navigated();
  unmount();
  await act(async () => { fail(); });
  expect(load).toHaveBeenCalledTimes(sections.length);
});

it('stops listening once unmounted', async () => {
  const { load, view, reconnect, navigated } = mount(false);
  const removed = vi.spyOn(window, 'removeEventListener');
  view().unmount();
  expect(removed).toHaveBeenCalledWith('online', expect.any(Function));
  await reconnect();
  await navigated();
  expect(load).not.toHaveBeenCalled();
});
