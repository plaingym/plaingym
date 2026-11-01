// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { gymSettingsResponseSchema, type GymSettings } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';

export const gymSettingsKey = ['settings', 'gym'] as const;
/** `epoch` changes only when the settings are fetched from the server, never when a save on this page updates them. */
interface Loaded { settings: GymSettings; epoch: number }
export interface SaveResult { status: number; data: unknown }
type Sent = { response: { ok: boolean; status: number }; data?: unknown };

let fetches = 0;
async function fetchSettings(): Promise<Loaded> {
  const result = await api.GET('/api/settings');
  if (!result.response.ok) throw new Error('The settings request failed');
  return { settings: gymSettingsResponseSchema.parse(result.data).data, epoch: ++fetches };
}
const fromResponse = (data: unknown) => gymSettingsResponseSchema.parse(data).data;
const queues = new WeakMap<QueryClient, Promise<unknown>>();

/**
 * The gym settings every section of the settings page edits. All of them hold one revision: a save from any section
 * writes its response back here, so it never stales the next section's save, while a change made elsewhere (another
 * tab or user) still answers 409. Nothing refetches in the background, so the revision only moves with this page's own
 * saves or an explicit reload.
 */
export function useGymSettings() {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: gymSettingsKey, queryFn: fetchSettings, staleTime: Infinity, gcTime: 0,
    refetchOnWindowFocus: false, refetchOnReconnect: false });
  const reload = useCallback(() => { void cache.refetchQueries({ queryKey: gymSettingsKey, exact: true }); }, [cache]);
  /**
   * Sends one save with the current revision, one at a time so each save sees the revision the one before it produced.
   * A success updates the shared settings with `adopt(response data, settings now)`; a 409 reloads them first, so the
   * next save sees the reloaded revision. Throws on a network or parse failure, and when the shared settings are out of
   * date because their last reload failed (nothing is sent then); the caller maps any other status.
   */
  const save = useCallback((send: (revision: number) => Promise<Sent>, adopt: (data: unknown, current: GymSettings) => GymSettings = fromResponse): Promise<SaveResult> => {
    const refetch = async () => {
      await cache.refetchQueries({ queryKey: gymSettingsKey, exact: true });
      if (cache.getQueryState(gymSettingsKey)?.status === 'error') throw new Error('The settings could not be reloaded');
    };
    const run = async () => {
      const current = cache.getQueryData<Loaded>(gymSettingsKey);
      if (!current || cache.getQueryState(gymSettingsKey)?.status === 'error') throw new Error('The settings are not loaded');
      const result = await send(current.settings.revision), { ok, status } = result.response;
      if (status === 409) await refetch();
      else if (ok) {
        // The server has accepted the save: a response that doesn't parse must not leave the cached revision behind it.
        try {
          const next = adopt(result.data, cache.getQueryData<Loaded>(gymSettingsKey)?.settings ?? current.settings);
          cache.setQueryData<Loaded>(gymSettingsKey, (old) => old && { epoch: old.epoch, settings: next });
        } catch (error) { await refetch().catch(() => undefined); throw error; }
      }
      return { status, data: result.data };
    };
    const done = (queues.get(cache) ?? Promise.resolve()).then(run);
    queues.set(cache, done.catch(() => undefined));
    return done;
  }, [cache]);
  return { settings: query.data?.settings, epoch: query.data?.epoch ?? 0, loading: query.isPending, failed: query.isError, reload, save };
}
