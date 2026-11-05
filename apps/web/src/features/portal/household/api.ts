// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { portalAccessContracts, portalContracts, type EndpointContract } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { useBootstrap } from '../../../app/context.js';
import { ApiError, createJsonTransport } from '../../../lib/api.js';
import { billingRequest } from '../../billing/catalog/api.js';

/** Calls one portal contract. The server resolves the household from the session; no request names one. */
export function portalCall<C extends EndpointContract>(contract: C, input?: unknown, params: Record<string, string> = {},
  query: Record<string, string | number | undefined> = {}, fetcher: typeof fetch = fetch) {
  return billingRequest(contract, input, params, query, fetcher);
}
/** What the portal caches for one login: its household lists, and one subtree per household it has opened. */
export const portalLoginKey = (gymId: string | undefined, userId: string | undefined) => ['portal', gymId, userId] as const;
/** Everything cached for one household. Another household's key shares none of it, so its pages can never reach these entries. */
export const portalHouseholdKey = (login: ReturnType<typeof portalLoginKey>, householdId: string | null | undefined) => [...login, 'household', householdId] as const;
export const portalHouseholdsKey = (login: ReturnType<typeof portalLoginKey>) => [...login, 'households'] as const;
export function usePortalLogin() {
  const bootstrap = useBootstrap();
  return portalLoginKey(bootstrap.data?.gym.id, bootstrap.data?.session?.userId);
}
/** The households the login may open and the one the server has open for its session. */
export function portalHouseholdsOptions(login: ReturnType<typeof portalLoginKey>, enabled: boolean) {
  return { queryKey: portalHouseholdsKey(login), enabled,
    queryFn: async () => portalAccessContracts.households.response.parse(await createJsonTransport()('/api/portal/households')).data, retry: false, staleTime: 0 } as const;
}
export type PortalKey = ReturnType<typeof portalHouseholdKey>;
/** Portal queries wait for the signed-in gym, user and open household, so their keys never change underneath them. */
export const portalReady = (key: PortalKey) => !!key[1] && !!key[2] && !!key[4];
/** The answer was for another household than the key it was asked under; the household lists are being read again. */
export class HouseholdMoved extends Error {}
/**
 * Passes an answer on only if it names the household its key does. Every portal answer says which household the server read it
 * for, the one the session has open; if that is another one, the server moved on since the lists were read (a revoked link fell
 * back to another household, or another tab switched). Such an answer is never stored or shown: this throws, so the query fails
 * or the action reports a failure, and the lists are read again (joining a load already under way). Once they name the other
 * household, every key is that household's.
 */
export function ownAnswer<T extends { householdId: string }>(cache: QueryClient, key: PortalKey, answer: T): T {
  if (answer.householdId === key[4]) return answer;
  // Fetched here rather than refetched, so the lists are read again even where nothing else is watching them.
  void cache.fetchQuery(portalHouseholdsOptions([key[0], key[1], key[2]], true)).catch(() => undefined);
  throw new HouseholdMoved();
}
/** The open household as a page sees it: the key its queries are built from, and the check every answer passes. */
export interface PortalScope { readonly key: PortalKey; readonly ready: boolean; own<T extends { householdId: string }>(answer: T): T }
/**
 * The one key every portal query is built from: the login plus the open household, read from the household lists. When the open
 * household changes, the key changes in the same render, so the previous household's entries are unreachable by construction.
 * Pages are only mounted once the lists name a household. A page reads it once and passes the scope to whatever needs it.
 */
export function usePortalScope(): PortalScope {
  const login = usePortalLogin(), cache = useQueryClient();
  // Reads the lists (and re-renders with them) without ever loading them; the shell owns the load.
  const households = useQuery({ ...portalHouseholdsOptions(login, false) });
  const key = portalHouseholdKey(login, households.data?.current);
  return { key, ready: portalReady(key), own: answer => ownAnswer(cache, key, answer) };
}
/** The open household's context (role and member), one query shared by every page; the shell keeps its own under `shell`. */
export function usePortalContext(scope: PortalScope, load: () => Promise<PortalContextAnswer> = () => portalCall(portalContracts.context)) {
  return useQuery({ queryKey: [...scope.key, 'context'], enabled: scope.ready, queryFn: async () => scope.own(await load()).data, staleTime: 0 });
}
export type PortalContextAnswer = ReturnType<typeof portalContracts.context.response.parse>;
/** Unavailable (Stripe or storage not set up) gets its own message; everything else is a generic failure. */
export const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503;
export const forbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
export const conflict = (error: unknown) => error instanceof ApiError && error.status === 409;
/** Today's calendar date in the gym's timezone, for age checks that match the server's guardian rule. */
export function gymToday(timezone: string, now = new Date()) { return localDate(now, timezone); }
/** Mirrors the waiver guardian rule to choose the signer kind; the server decides. An unknown birthday cannot establish adulthood. */
export function needsGuardian(dateOfBirth: string | null, today: string) {
  return !dateOfBirth || age(dateOfBirth, today) < 18;
}
/** Mirrors the server's `payerMayActFor`: a payer acts for children only with a recorded birth date under 18. */
export function knownMinor(dateOfBirth: string | null, today: string) {
  return !!dateOfBirth && age(dateOfBirth, today) < 18;
}
function age(dateOfBirth: string, today: string) {
  return Number(today.slice(0, 4)) - Number(dateOfBirth.slice(0, 4)) - Number(today.slice(5) < dateOfBirth.slice(5));
}
