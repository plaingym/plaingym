// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { GymSettings } from '@plaingym/shared/contracts';
import { gymSettingsKey, useGymSettings } from './gym-settings.js';

const server = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: server }));
const reply = (status: number, data?: unknown) => ({ response: { ok: status < 300, status }, data });
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
let gym: GymSettings;
/** The server's rule for every save: the revision sent must be the gym's current one, and each save moves it on. */
const save = (changes: Partial<GymSettings> = {}) => async (revision: number) => {
  if (revision !== gym.revision) return reply(409);
  gym = { ...gym, ...changes, revision: revision + 1 };
  return reply(200, { data: gym });
};
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const mount = async () => {
  const hook = renderHook(() => useGymSettings(), { wrapper });
  await waitFor(() => expect(hook.result.current.settings?.revision).toBe(3));
  return hook;
};
/** Lets the zero-delay timer that drops an unobserved query (`gcTime: 0`) run. */
const flushGc = () => new Promise<void>((done) => setTimeout(done, 0));
const reads = () => (server.GET as Mock).mock.calls.length;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  gym = { id: '01900000-0000-7000-8000-000000000001', name: 'Gym', slug: 'gym', timezone: 'America/Vancouver', currency: 'CAD', address: {}, branding: {},
    websiteEnabled: false, existingSiteUrl: null, bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false,
    billingEnabled: false, memberEmailsEnabled: false, retryDays: [3, 7], dropInChargeTypeId: null, revision: 3,
    createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z' };
  // A read answers with the gym as it is when the request arrives.
  server.GET.mockReset(); server.GET.mockImplementation(async () => reply(200, { data: gym }));
});
afterEach(cleanup);

describe('the gym settings save queue', () => {
  it('runs a reload behind the saves asked for before it, so the older reply never replaces a newer saved revision', async () => {
    const { result } = await mount();
    const sending = deferred(), started = deferred();
    const saving = result.current.save(async (revision) => { started.resolve(); await sending.promise; return save({ retryDays: [9] })(revision); });
    await started.promise;
    result.current.reload();
    // The reload has not read the gym while the save is in flight, so it cannot see the revision from before the save.
    expect(reads()).toBe(1);
    sending.resolve();
    expect((await saving).settings.revision).toBe(4);
    await waitFor(() => expect(reads()).toBe(2));
    await waitFor(() => expect(result.current.epoch).toBeGreaterThan(1));
    expect(result.current.settings).toMatchObject({ revision: 4, retryDays: [9] });
    const next = await result.current.save(save());
    expect(next.status).toBe(200);
    expect(gym.revision).toBe(5);
  });

  it('runs a save asked for behind a reload only from settings fetched after it', async () => {
    const { result } = await mount();
    const reading = deferred<ReturnType<typeof reply>>();
    server.GET.mockImplementationOnce(() => reading.promise);
    const stale = result.current.save;
    result.current.reload();
    const sent = vi.fn(save());
    const saving = stale(sent);
    gym = { ...gym, name: 'Renamed elsewhere', revision: 4 };
    reading.resolve(reply(200, { data: gym }));
    expect((await saving).status).toBe(409);
    expect(sent).not.toHaveBeenCalled();
    expect(gym.name).toBe('Renamed elsewhere');
  });

  it('completes a save queued behind another while every section unmounts, and reports a change made elsewhere as a conflict', async () => {
    const { result, unmount } = await mount();
    const sending = deferred(), started = deferred();
    const first = result.current.save(async (revision) => { started.resolve(); await sending.promise; return save({ retryDays: [9] })(revision); });
    const second = result.current.save((revision) => save({ name: 'Second' })(revision));
    await started.promise;
    unmount(); await flushGc();
    // The queued save still has settings to run against.
    expect(client.getQueryData(gymSettingsKey)).toBeDefined();
    sending.resolve();
    expect((await first).status).toBe(200);
    expect(await second).toMatchObject({ status: 200, settings: { revision: 5, name: 'Second' } });
    expect(gym).toMatchObject({ retryDays: [9], name: 'Second', revision: 5 });
    // Nothing is held once the queue is empty, so the next visit loads fresh settings.
    await flushGc(); await flushGc();
    expect(client.getQueryData(gymSettingsKey)).toBeUndefined();
  });

  it('answers a queued save with a conflict, not an error, when another tab changed the gym and the sections unmounted', async () => {
    const { result, unmount } = await mount();
    const sending = deferred(), started = deferred();
    const first = result.current.save(async (revision) => { started.resolve(); await sending.promise; return save({ retryDays: [9] })(revision); });
    const second = result.current.save(save({ name: 'Second' }));
    await started.promise;
    unmount(); await flushGc();
    sending.resolve();
    await first;
    // Another tab saved between the two; the second save carries a revision the server has moved past.
    gym = { ...gym, name: 'Renamed elsewhere', revision: 5 };
    expect(await second).toMatchObject({ status: 409, settings: { revision: 5, name: 'Renamed elsewhere' } });
    expect(gym.name).toBe('Renamed elsewhere');
  });

  it('answers 409 when the reload after a conflict fails, and refuses saves until a reload succeeds', async () => {
    const { result } = await mount();
    gym = { ...gym, revision: 4 };
    server.GET.mockImplementation(async () => reply(500));
    const outcome = await result.current.save(save());
    expect(outcome.status).toBe(409);
    await waitFor(() => expect(result.current.failed).toBe(true));
    const sent = vi.fn(save());
    await expect(result.current.save(sent)).rejects.toThrow('not loaded');
    expect(sent).not.toHaveBeenCalled();
    server.GET.mockImplementation(async () => reply(200, { data: gym }));
    result.current.reload();
    await waitFor(() => expect(result.current.settings?.revision).toBe(4));
    expect((await result.current.save(save())).status).toBe(200);
  });

  it('returns the settings it adopted from the response', async () => {
    const { result } = await mount();
    const outcome = await result.current.save(save({ retryDays: [1, 2] }));
    expect(outcome.settings).toMatchObject({ revision: 4, retryDays: [1, 2] });
    await waitFor(() => expect(result.current.settings).toEqual(outcome.settings));
    expect(reads()).toBe(1);
  });

  it('refuses a save whose values were read at a revision the settings have moved past, and sends one that is not behind', async () => {
    const { result } = await mount();
    await result.current.save(save({ retryDays: [1] }));
    const sent = vi.fn(save());
    const refused = await result.current.save(sent, { readAt: 3 });
    expect(refused).toMatchObject({ status: 409, settings: { revision: 4 } });
    expect(sent).not.toHaveBeenCalled();
    expect((await result.current.save(sent, { readAt: 4 })).status).toBe(200);
    // Values read at a newer revision than this page holds are sent with the page's own, so the server answers 409.
    gym = { ...gym, revision: 9 };
    expect((await result.current.save(sent, { readAt: 9 })).status).toBe(409);
    expect(sent).toHaveBeenCalledTimes(2);
  });
});
