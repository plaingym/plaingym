// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { integrationsResponseSchema, type Integrations } from '@plaingym/shared/contracts';
import { api } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { useGymSettings } from '../gym-settings.js';

export const integrationsKey = ['settings', 'integrations'] as const;
export const text = (key: string, values?: Record<string, string | number>) => t('settings/integrations:' + key, values);
async function fetchIntegrations(): Promise<Integrations> {
  const result = await api.GET('/api/settings/integrations');
  if (!result.response.ok) throw new Error('The integrations request failed');
  return integrationsResponseSchema.parse(result.data).data;
}
/** The reply to one change: its HTTP status, the server's refusal reason (`details` codes, never its message) and the picked result. */
export interface ChangeResult<T> { status: number; reason: string | null; result: T | null }
type Reply = { response: { ok: boolean; status: number }; data?: unknown; error?: unknown };
const reasonOf = (body: unknown) => {
  const details = (body as { error?: { details?: Record<string, unknown> } } | undefined)?.error?.details;
  const first = details ? Object.values(details)[0] : undefined;
  return Array.isArray(first) && typeof first[0] === 'string' ? first[0] : null;
};

/**
 * The gym's email, payments and backups. Every change goes through the settings page's save queue with the page's one
 * gym revision, so it neither stales nor is staled by the other sections; its reply carries the new revision, which the
 * shared settings adopt, and the integrations it returns replace the ones shown. A 409 reloads both.
 */
export function useIntegrations() {
  const cache = useQueryClient(), gym = useGymSettings();
  const query = useQuery({ queryKey: integrationsKey, queryFn: fetchIntegrations, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const reload = useCallback(() => { gym.reload(); void query.refetch(); }, [gym.reload, query.refetch]);
  async function change<T>(send: (revision: number) => Promise<Reply>, pick: (data: unknown) => { integrations: Integrations; result: T }): Promise<ChangeResult<T>> {
    const saved = await gym.save(async (revision) => {
      const reply = await send(revision);
      return { response: reply.response, data: reply.response.ok ? reply.data : reply.error };
    }, { adopt: (data, current) => ({ ...current, revision: pick(data).integrations.revision }) });
    if (saved.status < 300) {
      const picked = pick(saved.data);
      cache.setQueryData(integrationsKey, picked.integrations);
      return { status: saved.status, reason: null, result: picked.result };
    }
    if (saved.status === 409) await query.refetch();
    return { status: saved.status, reason: reasonOf(saved.data), result: null };
  }
  return { integrations: query.data, ready: Boolean(query.data && gym.settings), failed: query.isError || gym.failed, reload, change };
}
/** Picks a reply whose data is the integrations themselves. */
export const integrationsOf = (data: unknown) => ({ integrations: integrationsResponseSchema.parse(data).data, result: null });
