// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { portalContracts, type EndpointContract } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { useBootstrap } from '../../../app/context.js';
import { ApiError } from '../../../lib/api.js';
import { billingRequest } from '../../billing/catalog/api.js';

/** Calls one portal contract. The server resolves the household from the session; no request names one. */
export function portalCall<C extends EndpointContract>(contract: C, input?: unknown, params: Record<string, string> = {},
  query: Record<string, string | number | undefined> = {}, fetcher: typeof fetch = fetch) {
  return billingRequest(contract, input, params, query, fetcher);
}
/** Portal queries live under `portal`, so switching household discards them with the rest of the portal cache. */
export function usePortalKey() {
  const bootstrap = useBootstrap();
  return ['portal', bootstrap.data?.gym.id, bootstrap.data?.session?.userId] as const;
}
/** Portal queries wait for the signed-in gym and user, so their keys never change underneath them. */
export const portalReady = (key: ReturnType<typeof usePortalKey>) => !!key[1] && !!key[2];
export function usePortalContext() {
  const key = usePortalKey();
  return useQuery({ queryKey: [...key, 'context', 'pages'], enabled: portalReady(key), queryFn: async () => (await portalCall(portalContracts.context)).data });
}
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
