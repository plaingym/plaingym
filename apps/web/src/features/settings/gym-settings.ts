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
 * the gym moved (and the unchanged ones when it did not). `data` is the response body of a success and `error` the body
 * of a refusal (its `details` name the refused fields). `moved` is set when the settings were read again from the server
 * at another revision than the one the save was asked from, so every section now shows the latest values; after a 409
 * that left the gym where it was, or whose reload failed, it is false and the sections keep their input. `refused` is
 * set when the save was not sent at all: another section of this page saved since its values were read (`saved`), or
 * the settings were reloaded since (`reloaded`).
 */
export interface SaveResult {
  status: number; data: unknown; error: unknown; settings: GymSettings; moved: boolean; refused?: 'saved' | 'reloaded';
}
export interface SaveOptions {
  /** Turns a successful response into the settings to cache; defaults to a settings response. */
  adopt?: (data: unknown, current: GymSettings) => GymSettings;
  /** The revision the caller's values were read at, when they were read apart from the shared settings. */
  readAt?: number;
  /** How long this save may take before it is given up on; defaults to `saveTimeoutMs`. Saves queued behind it wait as long. */
  timeoutMs?: number;
}
export type Sent = { response: { ok: boolean; status: number }; data?: unknown; error?: unknown };

/** A save or a settings read that has not answered after this long is given up on, so it can't hold the queue behind it. */
export const saveTimeoutMs = 20_000;
/**
 * Thrown by a save that got no answer in time. The request is aborted, but the server may still have applied it: the
 * settings are reloaded before this is thrown, so a section tells the owner to check what is shown before saving again.
 */
export class SaveTimeoutError extends Error {
  constructor() { super('The save timed out'); this.name = 'SaveTimeoutError'; }
}

/** Aborts when `signal` does or `ms` have passed; browsers without `AbortSignal.any` combine the two by hand. */
export function abortWithin(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const sources = [signal, timeout];
  const stop = () => {
    controller.abort(sources.find((source) => source.aborted)?.reason);
    for (const source of sources) source.removeEventListener('abort', stop);
  };
  if (sources.some((source) => source.aborted)) stop();
  else for (const source of sources) source.addEventListener('abort', stop);
  return controller.signal;
}

/** The revision a reload after a 409 keeps the epoch for: a read that finds the gym still there leaves the sections' input alone. */
const unmovedAt = new WeakMap<QueryClient, number>();
let fetches = 0;
/** A read TanStack Query supersedes or no longer needs is aborted through its `signal`, and one that stalls through the timeout. */
async function fetchSettings({ client, signal }: { client: QueryClient; signal?: AbortSignal }): Promise<Loaded> {
  const result = await api.GET('/api/settings', { signal: abortWithin(signal, saveTimeoutMs) });
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
 * Sends a save and waits at most `timeoutMs` for its answer. Past that the request is aborted (when the caller passes
 * the signal on) and given up on whatever it does later, and the settings are reloaded, since the server may have applied
 * it: the queue moves on and the caller gets a `SaveTimeoutError`.
 */
async function sendWithin(send: (revision: number, signal: AbortSignal) => Promise<Sent>, revision: number, timeoutMs: number,
  reload: () => Promise<unknown>): Promise<Sent> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SaveTimeoutError()); }, timeoutMs); });
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
   * succeeds. A save that gets no answer within `saveTimeoutMs` (or its own `timeoutMs`) is aborted, the settings are
   * reloaded and the call throws a `SaveTimeoutError`, so a stalled request can't hold the queue. A save asked for from settings older than the ones fetched last (another
   * section's 409, or a reload, came between) answers 409 without being sent (`refused`): its values were read before the reload, and sending them
   * with the reloaded revision would overwrite the change that caused it. That age is the epoch the section rendered
   * with, since a click can land after the reload but before the section shows its values. A save whose values were
   * `readAt` a revision the shared settings have moved past (another section saved since) is refused the same way.
   * Throws on a network or parse failure, and when the shared settings are out of date because their last reload
   * failed (nothing is sent then); the caller maps any other status.
   */
  const rendered = query.data?.epoch;
  const save = useCallback((send: (revision: number, signal: AbortSignal) => Promise<Sent>,
    { adopt = fromResponse, readAt, timeoutMs = saveTimeoutMs }: SaveOptions = {}): Promise<SaveResult> =>
    enqueue(cache, async (): Promise<SaveResult> => {
      const current = cached(cache);
      if (!current || failedToLoad(cache)) throw new Error('The settings are not loaded');
      const unsent = { status: 409, data: undefined, error: undefined, settings: current.settings };
      if (current.epoch !== rendered) return { ...unsent, moved: true, refused: 'reloaded' };
      if (readAt !== undefined && current.settings.revision > readAt) return { ...unsent, moved: false, refused: 'saved' };
      // A timed-out save reloads like a 409: the sections keep their input unless the server applied it after all.
      const result = await sendWithin(send, current.settings.revision, timeoutMs, () => reloadAfterConflict(cache, current.settings.revision));
      const { ok, status } = result.response;
      let settings = current.settings, moved = false;
      if (status === 409) {
        await reloadAfterConflict(cache, current.settings.revision);
        const after = cached(cache);
        settings = after?.settings ?? settings;
        moved = !failedToLoad(cache) && !!after && after.epoch !== current.epoch;
      } else if (ok) {
        // The server has accepted the save: a response that doesn't parse must not leave the cached revision behind it.
        try {
          settings = adopt(result.data, cached(cache)?.settings ?? current.settings);
          cache.setQueryData<Loaded>(gymSettingsKey, (old) => old && { epoch: old.epoch, settings });
        } catch (error) { await refetch(cache).catch(() => undefined); throw error; }
      }
      return { status, data: result.data, error: result.error, settings, moved };
    }), [cache, rendered]);
  return { settings: query.data?.settings, epoch: query.data?.epoch ?? 0, loading: query.isPending, failed: query.isError, reload, save };
}
