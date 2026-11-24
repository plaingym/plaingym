// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { goLiveChecklistResponseSchema } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { parseResponse } from '../../lib/response.js';

type WireChecklist = ReturnType<typeof goLiveChecklistResponseSchema.parse>['data'];
export type Checklist = WireChecklist & { pastDueMemberships: NonNullable<WireChecklist['pastDueMemberships']> };
export function parseChecklist(response: unknown): Checklist {
  const data = parseResponse(goLiveChecklistResponseSchema, response).data;
  return { ...data, pastDueMemberships: data.pastDueMemberships ?? [] };
}
export const goLiveKey = (revision: number | undefined, epoch: number | undefined) => ['settings', 'go-live', revision, epoch] as const;
/** Payments and Go live share one read, including checks that don't change the gym revision. */
export function useGoLiveChecklist(revision: number | undefined, epoch: number | undefined, enabled = true) {
  return useQuery({ queryKey: goLiveKey(revision, epoch), enabled: enabled && revision !== undefined,
    staleTime: Infinity, retry: false, refetchOnWindowFocus: 'always',
    queryFn: async () => {
      const result = await api.GET('/api/settings/go-live');
      if (!result.response.ok) throw new Error('The checklist request failed');
      return parseChecklist(result.data);
    } });
}
