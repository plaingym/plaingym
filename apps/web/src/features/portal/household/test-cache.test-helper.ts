// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { portalHouseholdKey, portalHouseholdsKey, portalLoginKey } from './api.js';

/** A portal answer from the open household (`household`, as `portalTestCache` names it) unless a test names another. */
export const answer = <T,>(data: T, householdId = 'household') => ({ data, householdId });
/** Answers the household lists, which a page reads again after an answer for another household, and records each read. */
export function stubHouseholdLists() {
  // The read fails, so the lists keep naming the open household and the page stays on its key.
  const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  return () => fetcher.mock.calls.filter(([path]) => path === '/api/portal/households').length;
}
/** The rest of each key under which the open household's entries hold data, sorted. */
export function storedFor(cache: QueryClient, gymId: string, userId: string, householdId: string) {
  return cache.getQueryCache().findAll({ queryKey: portalHouseholdKey(portalLoginKey(gymId, userId), householdId) })
    .filter(query => query.state.data !== undefined).map(query => query.queryKey.slice(5).join('/')).sort();
}

/**
 * A cache for rendering one portal page on its own, outside the shell: the household lists the shell would have loaded are
 * already there, naming the open household, so the page's keys are ready the way they are under the shell.
 */
export function portalTestCache(gymId: string, userId: string, householdId: string, defaults: ConstructorParameters<typeof QueryClient>[0] = {}) {
  const cache = new QueryClient(defaults);
  cache.setQueryData(portalHouseholdsKey(portalLoginKey(gymId, userId)), { current: householdId, households: [{ householdId, name: 'Test household', role: 'payer' }] });
  return cache;
}
