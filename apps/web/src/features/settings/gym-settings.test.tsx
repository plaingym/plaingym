// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { GymSettings } from '@plaingym/shared/contracts';
import { gymSettingsKey, saveTimeoutMs, useGymSettings } from './gym-settings.js';

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

  it('fetches once for reloads asked for while one is still waiting to start', async () => {
    const { result } = await mount();
    const sending = deferred(), started = deferred();
    const saving = result.current.save(async (revision) => { started.resolve(); await sending.promise; return save()(revision); });
    await started.promise;
    const epoch = result.current.epoch;
    for (let click = 0; click < 3; click++) result.current.reload();
    sending.resolve();
    await saving;
    await waitFor(() => expect(result.current.epoch).toBe(epoch + 1));
    await flushGc();
    expect(reads()).toBe(2);
    expect(result.current.epoch).toBe(epoch + 1);
    // Once that reload has run, the next one fetches again.
    result.current.reload();
    await waitFor(() => expect(reads()).toBe(3));
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

  it('keeps the cached settings, and so every section\'s input, on a 409 when the gym did not move', async () => {
    const { result } = await mount();
    const epoch = result.current.epoch;
    // The server refuses for a reason the gym revision doesn't cover.
    const outcome = await result.current.save(async () => reply(409));
    expect(outcome).toMatchObject({ status: 409, settings: { revision: 3 } });
    expect(reads()).toBe(2);
    expect(result.current.epoch).toBe(epoch);
    expect(result.current.failed).toBe(false);
    // The next save still runs against the same settings.
    expect((await result.current.save(save())).status).toBe(200);
  });

  it('replaces the cached settings on a 409 when the gym moved', async () => {
    const { result } = await mount();
    const epoch = result.current.epoch;
    gym = { ...gym, name: 'Renamed elsewhere', revision: 4 };
    const outcome = await result.current.save(async () => reply(409));
    expect(outcome).toMatchObject({ status: 409, settings: { revision: 4, name: 'Renamed elsewhere' } });
    await waitFor(() => expect(result.current.settings?.revision).toBe(4));
    expect(result.current.epoch).toBeGreaterThan(epoch);
  });

  it('gives up on a save that stalls, reloads, and lets the reload asked for behind it run', async () => {
    const { result } = await mount();
    const never = deferred<ReturnType<typeof reply>>(), started = deferred();
    let signal!: AbortSignal;
    // Only the save's own timeout is held back; every other timer runs, and the test fires this one itself.
    const real = globalThis.setTimeout, expire: Array<() => void> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, delay?: number) =>
      delay === saveTimeoutMs ? (expire.push(handler), 0) : real(handler, delay)) as unknown as typeof setTimeout);
    const stalled = result.current.save((_revision, aborted) => { signal = aborted; started.resolve(); return never.promise; });
    const failure = expect(stalled).rejects.toThrow('timed out');
    await started.promise;
    result.current.reload();
    const next = vi.fn(save());
    const queued = result.current.save(next);
    // Nothing behind the stalled save has run, and it has not been given up on yet.
    expect(reads()).toBe(1);
    expect(next).not.toHaveBeenCalled();
    expect(expire).toHaveLength(1);
    // The server applied the stalled save after all; the reload that follows the timeout sees it.
    gym = { ...gym, retryDays: [5], revision: 4 };
    expire[0]!();
    await failure;
    expect(signal.aborted).toBe(true);
    vi.restoreAllMocks();
    // The reload asked for behind the save has run by the time the save asked for after it does, from the reloaded settings.
    await waitFor(() => expect(result.current.settings).toMatchObject({ revision: 4, retryDays: [5] }));
    expect(reads()).toBeGreaterThanOrEqual(2);
    expect((await queued).refused).toBe('reloaded');
    expect(next).not.toHaveBeenCalled();
    // A late answer from the abandoned request changes nothing.
    never.resolve(reply(200, { data: { ...gym, revision: 99 } }));
    await flushGc();
    expect(result.current.settings?.revision).toBe(4);
  });

  it('keeps the epoch, and so every section\'s input, when the reload after a stalled save finds the gym unmoved', async () => {
    const { result } = await mount();
    const epoch = result.current.epoch, never = deferred<ReturnType<typeof reply>>(), started = deferred();
    const real = globalThis.setTimeout, expire: Array<() => void> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, delay?: number) =>
      delay === saveTimeoutMs ? (expire.push(handler), 0) : real(handler, delay)) as unknown as typeof setTimeout);
    const stalled = result.current.save(() => { started.resolve(); return never.promise; });
    const failure = expect(stalled).rejects.toThrow('timed out');
    await started.promise;
    const next = vi.fn(save({ retryDays: [2] }));
    const queued = result.current.save(next);
    // The server never applied the stalled save, so the reload after the timeout reads the same revision.
    expire[0]!();
    await failure;
    vi.restoreAllMocks();
    expect(reads()).toBe(2);
    expect(result.current.epoch).toBe(epoch);
    // The save asked for behind it is sent, not refused as if the settings had been reloaded.
    expect(await queued).toMatchObject({ status: 200, settings: { revision: 4, retryDays: [2] } });
    expect(next).toHaveBeenCalledOnce();
  });

  it('refuses a save whose values were read before another section saved with `saved`, and one asked for after a reload with `reloaded`', async () => {
    const { result } = await mount();
    const stale = result.current.save;
    await result.current.save(save({ retryDays: [1] }));
    expect(await result.current.save(vi.fn(), { readAt: 3 })).toMatchObject({ status: 409, refused: 'saved' });
    gym = { ...gym, revision: 9 };
    result.current.reload();
    await waitFor(() => expect(result.current.settings?.revision).toBe(9));
    expect(await stale(vi.fn())).toMatchObject({ status: 409, refused: 'reloaded' });
    expect((await result.current.save(save())).refused).toBeUndefined();
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
