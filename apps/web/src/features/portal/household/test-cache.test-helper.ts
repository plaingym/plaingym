// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from '@tanstack/react-query';
import { portalHouseholdsKey, portalLoginKey } from './api.js';

/**
 * A cache for rendering one portal page on its own, outside the shell: the household lists the shell would have loaded are
 * already there, naming the open household, so the page's keys are ready the way they are under the shell.
 */
export function portalTestCache(gymId: string, userId: string, householdId: string, defaults: ConstructorParameters<typeof QueryClient>[0] = {}) {
  const cache = new QueryClient(defaults);
  cache.setQueryData(portalHouseholdsKey(portalLoginKey(gymId, userId)), { current: householdId, households: [{ householdId, name: 'Test household', role: 'payer' }] });
  return cache;
}
