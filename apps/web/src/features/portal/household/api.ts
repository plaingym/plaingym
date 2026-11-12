// SPDX-License-Identifier: AGPL-3.0-only
import { useIsFetching, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { portalAccessContracts, portalContracts, portalHouseholdHeader, type EndpointContract } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { useBootstrap } from '../../../app/context.js';
import { ApiError, createJsonTransport } from '../../../lib/api.js';
import { billingRequest } from '../../billing/catalog/api.js';
import { parseResponse } from '../../../lib/response.js';

/** Calls a portal contract; pages use their scope's call to name the expected household. */
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
    queryFn: async () => parseResponse(portalAccessContracts.households.response, await createJsonTransport()('/api/portal/households')).data, retry: false, staleTime: 0 } as const;
}
export type PortalKey = ReturnType<typeof portalHouseholdKey>;
/** Portal queries wait for the signed-in gym, user and open household, so their keys never change underneath them. */
export const portalReady = (key: PortalKey) => !!key[1] && !!key[2] && !!key[4];
/** The answer was for another household than the key it was asked under; the household lists are being read again. */
export class HouseholdMoved extends Error {
  constructor(readonly householdId?: string) { super('Portal household changed'); }
}
/** The household is a precondition, never an authorization grant. A revision conflict has no such response header. */
export function householdTransport(householdId: string, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(portalHouseholdHeader, householdId);
    const response = await fetcher(input, { ...init, headers });
    if (response.status === 409 && response.headers.has(portalHouseholdHeader)) throw new HouseholdMoved(response.headers.get(portalHouseholdHeader)!);
    return response;
  };
}
/** The list result (success or failure) a request started under. No timing window is needed to share recovery. */
export function householdListsVersion(cache: QueryClient, key: PortalKey): number {
  const state = cache.getQueryState(portalHouseholdsKey([key[0], key[1], key[2]]));
  return (state?.dataUpdateCount ?? 0) + (state?.errorUpdateCount ?? 0);
}
// Reads in flight, keyed by the cached list query itself, so clearing the login's cache also discards them.
const recoveries = new WeakMap<object, { householdId: PortalKey[4]; expected: string | undefined; version: number; promise: Promise<void> }>();
export const portalRecoveryNoticeKey = (login: ReturnType<typeof portalLoginKey>) => [...login, 'recovery-notice'] as const;
export function clearPortalRecoveryNotice(cache: QueryClient, login: ReturnType<typeof portalLoginKey>) {
  cache.setQueryData(portalRecoveryNoticeKey(login), false);
}
export function usePortalRecoveryNotice() {
  const login = usePortalLogin();
  return useQuery({ queryKey: portalRecoveryNoticeKey(login), queryFn: () => false, enabled: false }).data;
}
/** Only a recovery for this snapshot (or a later one) can satisfy its late answers. Ordinary list loads do not. */
export function refreshHouseholds(cache: QueryClient, key: PortalKey, version: number, named?: string): Promise<unknown> {
  const login = [key[0], key[1], key[2]] as const;
  // A schedule that moved mid-read names no household (''): any other household than the key's then counts as the move.
  const expected = named || undefined;
  const current = cache.getQueryData<{ current: string | null }>(portalHouseholdsKey(login));
  const list = cache.getQueryCache().find({ queryKey: portalHouseholdsKey(login), exact: true });
  const recovered = (current: string | null) => expected === undefined ? current !== key[4] : current === expected;
  if (named !== undefined && current && recovered(current.current)) return Promise.resolve();
  const findList = () => cache.getQueryCache().find({ queryKey: portalHouseholdsKey(login), exact: true });
  const previous = list && recoveries.get(list);
  if (previous && previous.householdId === key[4] && previous.expected === expected && previous.version >= version) return previous.promise;
  const options = portalHouseholdsOptions(login, true);
  const alreadyFetching = list?.state.fetchStatus === 'fetching';
  const promise = (async () => {
    let result = await cache.fetchQuery(options);
    // A joined read may predate the move. Never finish that recovery on its old snapshot.
    if (!recovered(result.current) && (alreadyFetching || expected !== undefined)) result = await cache.fetchQuery(options);
    if (expected !== undefined && !recovered(result.current)) throw new Error('Household recovery did not reach the expected household');
  })().finally(() => {
    const entry = findList();
    if (entry && recoveries.get(entry)?.promise === promise) recoveries.delete(entry);
  });
  recoveries.set(findList()!, { householdId: key[4], expected, version, promise });
  return promise;
}
/** A missing resource alone does not establish a move: refresh lists without hiding the page. */
export async function runPortalOperation<T>(operation: () => Promise<T>, recover: (expected?: string) => void): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof HouseholdMoved) recover(error.householdId);
    else if (notFound(error)) recover();
    throw error;
  }
}
/**
 * Passes an answer on only if it names the household its key does. Every portal answer says which household the server read it
 * for, the one the session has open; if that is another one, the server moved on since the lists were read (a revoked link fell
 * back to another household, or another tab switched). Such an answer is never stored or shown: this throws, so the query fails
 * or the action reports a failure, and the lists are read again (joining a load already under way). Once they name the other
 * household, every key is that household's.
 */
export function ownAnswer<T extends { householdId: string }>(cache: QueryClient, key: PortalKey, answer: T, version: number): T {
  if (answer.householdId === key[4]) return answer;
  // Fetched here rather than refetched, so the lists are read again even where nothing else is watching them.
  void refreshHouseholds(cache, key, version, answer.householdId).catch(() => undefined);
  throw new HouseholdMoved(answer.householdId);
}
/** The open household as a page sees it: the key its queries are built from, and the check every answer passes. */
export interface PortalScope {
  readonly key: PortalKey; readonly ready: boolean; readonly moving: boolean; readonly refreshing: boolean;
  own<T extends { householdId: string }>(answer: T): T;
  run<T>(operation: () => Promise<T>): Promise<T>;
  call<C extends EndpointContract>(contract: C, input?: unknown, params?: Record<string, string>, query?: Record<string, string | number | undefined>): Promise<ReturnType<C['response']['parse']>>;
}
/** The open household's key. Reads the lists (and re-renders with them) without ever loading them; the shell owns the load. */
export function usePortalHouseholdKey(): PortalKey {
  const login = usePortalLogin();
  const households = useQuery({ ...portalHouseholdsOptions(login, false) });
  return portalHouseholdKey(login, households.data?.current);
}
/**
 * The one key every portal query is built from: the login plus the open household, read from the household lists. When the open
 * household changes, the key changes in the same render, so the previous household's entries are unreachable by construction.
 * Pages are only mounted once the lists name a household. A page reads it once and passes the scope to whatever needs it.
 */
export function usePortalScope(): PortalScope {
  const cache = useQueryClient(), key = usePortalHouseholdKey();
  const refreshing = useIsFetching({ queryKey: portalHouseholdsKey([key[0], key[1], key[2]]), exact: true }) > 0;
  const [moving, setMoving] = useState(false);
  const pending = useRef(0);
  const recover = (version: number, expected?: string) => {
    if (expected === undefined) {
      void refreshHouseholds(cache, key, version).catch(() => undefined);
      return;
    }
    pending.current++;
    setMoving(true);
    void refreshHouseholds(cache, key, version, expected).catch(() => undefined).finally(() => { if (--pending.current === 0) setMoving(false); });
  };
  const run: PortalScope['run'] = async operation => {
    const version = householdListsVersion(cache, key);
    return runPortalOperation(operation, expected => recover(version, expected));
  };
  return { key, ready: portalReady(key), moving, refreshing,
    own: answer => { if (answer.householdId === key[4]) return answer; recover(householdListsVersion(cache, key), answer.householdId); throw new HouseholdMoved(answer.householdId); }, run,
    call: (contract, input, params, query) => run(() => portalCall(contract, input, params, query, householdTransport(key[4] ?? ''))),
  };
}
/** The open household's context (role and member), one query shared by every page; the shell keeps its own under `shell`. */
export function usePortalContext(scope: PortalScope, load: () => Promise<PortalContextAnswer> = () => scope.call(portalContracts.context)) {
  return useQuery({ queryKey: [...scope.key, 'context'], enabled: scope.ready, queryFn: async () => scope.own(await load()).data, staleTime: 0 });
}
export type PortalContextAnswer = ReturnType<typeof portalContracts.context.response.parse>;
/** Unavailable (Stripe or storage not set up) gets its own message; everything else is a generic failure. */
export const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503;
export const forbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
export const conflict = (error: unknown) => error instanceof ApiError && error.status === 409;
export const notFound = (error: unknown) => error instanceof ApiError && error.status === 404;
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
