// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from 'react';
import { QueryObserver, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { gymSettingsResponseSchema, type GymSettings } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';

export const gymSettingsKey = ['settings', 'gym'] as const;
/** `epoch` changes only when the settings are fetched from the server, never when a save on this page updates them. */
interface Loaded { settings: GymSettings; epoch: number }
/** `settings` are the ones the page holds after the save: the adopted response, or the reloaded settings after a 409. */
export interface SaveResult { status: number; data: unknown; settings: GymSettings }
export interface SaveOptions {
  /** Turns a successful response into the settings to cache; defaults to a settings response. */
  adopt?: (data: unknown, current: GymSettings) => GymSettings;
  /** The revision the caller's values were read at, when they were read apart from the shared settings. */
  readAt?: number;
}
type Sent = { response: { ok: boolean; status: number }; data?: unknown };

let fetches = 0;
async function fetchSettings(): Promise<Loaded> {
  const result = await api.GET('/api/settings');
  if (!result.response.ok) throw new Error('The settings request failed');
  return { settings: gymSettingsResponseSchema.parse(result.data).data, epoch: ++fetches };
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
   * A success updates the shared settings with `adopt(response data, settings now)`; a 409 reloads them first, so the
   * next save sees the reloaded revision (and answers 409 even when that reload fails, after which saves are refused
   * until a reload succeeds). A save asked for from settings older than the ones fetched last (another section's 409,
   * or a reload, came between) answers 409 without being sent: its values were read before the reload, and sending them
   * with the reloaded revision would overwrite the change that caused it. That age is the epoch the section rendered
   * with, since a click can land after the reload but before the section shows its values. A save whose values were
   * `readAt` a revision the shared settings have moved past (another section saved since) is refused the same way.
   * Throws on a network or parse failure, and when the shared settings are out of date because their last reload
   * failed (nothing is sent then); the caller maps any other status.
   */
  const rendered = query.data?.epoch;
  const save = useCallback((send: (revision: number) => Promise<Sent>, { adopt = fromResponse, readAt }: SaveOptions = {}): Promise<SaveResult> =>
    enqueue(cache, async () => {
      const current = cached(cache);
      if (!current || failedToLoad(cache)) throw new Error('The settings are not loaded');
      if (current.epoch !== rendered || (readAt !== undefined && current.settings.revision > readAt)) return { status: 409, data: undefined, settings: current.settings };
      const result = await send(current.settings.revision), { ok, status } = result.response;
      let settings = current.settings;
      if (status === 409) {
        await refetch(cache).catch(() => undefined);
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
