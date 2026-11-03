// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from 'react';
import { QueryObserver, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { gymSettingsResponseSchema, type GymSettings } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';

export const gymSettingsKey = ['settings', 'gym'] as const;
/** `epoch` changes only when the settings are fetched from the server, never when a save on this page updates them. */
interface Loaded { settings: GymSettings; epoch: number }
/**
 * `settings` are the ones the page holds after the save: the adopted response, or after a 409 the reloaded settings when
 * the gym moved (and the unchanged ones when it did not). `refused` is set when the save was not sent at all: another
 * section of this page saved since its values were read (`saved`), or the settings were reloaded since (`reloaded`).
 */
export interface SaveResult { status: number; data: unknown; settings: GymSettings; refused?: 'saved' | 'reloaded' }
export interface SaveOptions {
  /** Turns a successful response into the settings to cache; defaults to a settings response. */
  adopt?: (data: unknown, current: GymSettings) => GymSettings;
  /** The revision the caller's values were read at, when they were read apart from the shared settings. */
  readAt?: number;
}
type Sent = { response: { ok: boolean; status: number }; data?: unknown };

/** A save or a settings read that has not answered after this long is given up on, so it can't hold the queue behind it. */
export const saveTimeoutMs = 20_000;

/** The revision a reload after a 409 keeps the epoch for: a read that finds the gym still there leaves the sections' input alone. */
const unmovedAt = new WeakMap<QueryClient, number>();
let fetches = 0;
async function fetchSettings({ client }: { client: QueryClient }): Promise<Loaded> {
  const result = await api.GET('/api/settings', { signal: AbortSignal.timeout(saveTimeoutMs) });
  if (!result.response.ok) throw new Error('The settings request failed');
  const settings = gymSettingsResponseSchema.parse(result.data).data, before = client.getQueryData<Loaded>(gymSettingsKey);
  const unmoved = before && unmovedAt.get(client) === settings.revision && before.settings.revision === settings.revision;
  return { settings, epoch: unmoved ? before.epoch : ++fetches };
}
const fromResponse = (data: unknown) => gymSettingsResponseSchema.parse(data).data;
const settingsQuery = { queryKey: gymSettingsKey, queryFn: fetchSettings, staleTime: Infinity, gcTime: 0,
  refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

/** `reloadQueued` is set while a reload waits in the queue and has not started yet. */
interface Queue { tail: Promise<void>; waiting: number; unhold?: (() => void) | undefined; reloadQueued?: boolean }
const queues = new WeakMap<QueryClient, Queue>();
const queueFor = (cache: QueryClient) => {
  const queue = queues.get(cache) ?? { tail: Promise.resolve(), waiting: 0 };
  queues.set(cache, queue);
  return queue;
};
const cached = (cache: QueryClient) => cache.getQueryData<Loaded>(gymSettingsKey);
const failedToLoad = (cache: QueryClient) => cache.getQueryState(gymSettingsKey)?.status === 'error';
async function refetch(cache: QueryClient) {
  await cache.refetchQueries({ queryKey: gymSettingsKey, exact: true });
  if (failedToLoad(cache)) throw new Error('The settings could not be reloaded');
}
/**
 * Reads the gym again after a 409 or a save that timed out. The epoch, and so every section's input, changes only when the revision is not the
 * one that was sent: a 409 can come from something the gym revision doesn't cover, such as a go-live save refused for a
 * past-due membership's revision. When the read fails, saves are refused until a reload succeeds.
 */
async function reloadAfterConflict(cache: QueryClient, sentRevision: number) {
  unmovedAt.set(cache, sentRevision);
  try { await refetch(cache); } catch { /* recorded in the query's state */ } finally { unmovedAt.delete(cache); }
}
/**
 * Sends a save and waits at most `saveTimeoutMs` for its answer. Past that the request is aborted (when the caller passes
 * the signal on) and given up on whatever it does later, and the settings are reloaded, since the server may have applied
 * it: the queue moves on and the caller gets an error.
 */
async function sendWithin(send: (revision: number, signal: AbortSignal) => Promise<Sent>, revision: number, reload: () => Promise<unknown>): Promise<Sent> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('The save timed out')); }, saveTimeoutMs); });
  try { return await Promise.race([send(revision, controller.signal), stalled]); }
  catch (error) { if (controller.signal.aborted) await reload(); throw error; }
  finally { clearTimeout(timer); }
}
/**
 * Runs one task at a time, after the ones queued before it. While any task is queued or running, an observer keeps the
 * settings in the cache: with `gcTime: 0` they would otherwise be dropped when every section unmounts, and a task still
 * waiting would find nothing to save against.
 */
function enqueue<T>(cache: QueryClient, task: () => Promise<T>): Promise<T> {
  const queue = queueFor(cache);
  if (queue.waiting === 0) queue.unhold = new QueryObserver(cache, { ...settingsQuery, refetchOnMount: false, retryOnMount: false }).subscribe(() => undefined);
  queue.waiting++;
  const done = queue.tail.then(task);
  queue.tail = done.then(() => undefined, () => undefined);
  void queue.tail.then(() => { if (--queue.waiting === 0) { queue.unhold?.(); queue.unhold = undefined; } });
  return done;
}

/**
 * The gym settings every section of the settings page edits. All of them hold one revision: a save from any section
 * writes its response back here, so it never stales the next section's save, while a change made elsewhere (another
 * tab or user) still answers 409. Nothing refetches in the background, so the revision only moves with this page's own
 * saves or an explicit reload.
 */
export function useGymSettings() {
  const cache = useQueryClient();
  const query = useQuery(settingsQuery);
  /**
   * Reloads in the save queue, behind the saves already asked for, so the reply can't be older than their revisions. A
   * reload asked for while another still waits to start joins it: each completed reload resets every section's input.
   */
  const reload = useCallback(() => {
    const queue = queueFor(cache);
    if (queue.reloadQueued) return;
    queue.reloadQueued = true;
    void enqueue(cache, () => { queue.reloadQueued = false; return refetch(cache).catch(() => undefined); });
  }, [cache]);
  /**
   * Sends one save with the current revision, one at a time so each save sees the revision the one before it produced.
   * A success updates the shared settings with `adopt(response data, settings now)`; a 409 reads the gym again and
   * replaces the shared settings (and so every section's input) only when its revision moved, so the next save sees the
   * reloaded revision; when the read fails the answer is still 409, after which saves are refused until a reload
   * succeeds. A save that gets no answer within `saveTimeoutMs` is aborted, the settings are reloaded and the call throws,
   * so a stalled request can't hold the queue. A save asked for from settings older than the ones fetched last (another
   * section's 409, or a reload, came between) answers 409 without being sent (`refused`): its values were read before the reload, and sending them
   * with the reloaded revision would overwrite the change that caused it. That age is the epoch the section rendered
   * with, since a click can land after the reload but before the section shows its values. A save whose values were
   * `readAt` a revision the shared settings have moved past (another section saved since) is refused the same way.
   * Throws on a network or parse failure, and when the shared settings are out of date because their last reload
   * failed (nothing is sent then); the caller maps any other status.
   */
  const rendered = query.data?.epoch;
  const save = useCallback((send: (revision: number, signal: AbortSignal) => Promise<Sent>, { adopt = fromResponse, readAt }: SaveOptions = {}): Promise<SaveResult> =>
    enqueue(cache, async (): Promise<SaveResult> => {
      const current = cached(cache);
      if (!current || failedToLoad(cache)) throw new Error('The settings are not loaded');
      if (current.epoch !== rendered) return { status: 409, data: undefined, settings: current.settings, refused: 'reloaded' };
      if (readAt !== undefined && current.settings.revision > readAt) return { status: 409, data: undefined, settings: current.settings, refused: 'saved' };
      // A timed-out save reloads like a 409: the sections keep their input unless the server applied it after all.
      const result = await sendWithin(send, current.settings.revision, () => reloadAfterConflict(cache, current.settings.revision));
      const { ok, status } = result.response;
      let settings = current.settings;
      if (status === 409) {
        await reloadAfterConflict(cache, current.settings.revision);
        settings = cached(cache)?.settings ?? settings;
      } else if (ok) {
        // The server has accepted the save: a response that doesn't parse must not leave the cached revision behind it.
        try {
          settings = adopt(result.data, cached(cache)?.settings ?? current.settings);
          cache.setQueryData<Loaded>(gymSettingsKey, (old) => old && { epoch: old.epoch, settings });
        } catch (error) { await refetch(cache).catch(() => undefined); throw error; }
      }
      return { status, data: result.data, settings };
    }), [cache, rendered]);
  return { settings: query.data?.settings, epoch: query.data?.epoch ?? 0, loading: query.isPending, failed: query.isError, reload, save };
}
