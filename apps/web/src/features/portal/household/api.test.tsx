// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { portalContracts, type EndpointContract } from '@plaingym/shared/contracts';
import { ApiError } from '../../../lib/api.js';
import { portalClient } from '../schedule/client.js';
import { HouseholdMoved, ownAnswer, householdListsVersion, portalHouseholdKey, portalHouseholdsKey, portalLoginKey, usePortalScope } from './api.js';
import { portalTestCache } from './test-cache.test-helper.js';

vi.mock('../../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { id: 'gym' }, session: { userId: 'user' } } }) }));
const home = '00000000-0000-7000-8000-000000000001', other = '00000000-0000-7000-8000-000000000002';
const signed = { memberId: home, templateId: home, templateVersion: 1, signer: { kind: 'self', name: 'Member' },
  signatureImageKey: 'image.png', signatureImageHash: 'a'.repeat(64), consent: true };
const inputs: Record<string, unknown> = { updateMember: { revision: 1 }, updateHousehold: { revision: 1 }, regenerateCheckin: { revision: 1 },
  signWaiver: signed, signHouseholdWaiver: signed, uploadSignature: { memberId: home, pngBase64: 'YQ==' }, uploadHouseholdSignature: { memberId: home, pngBase64: 'YQ==' } };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture() {
  const cache = portalTestCache('gym', 'user', home);
  let release!: (response: Response) => void;
  const fetcher = vi.fn(async (path: RequestInfo | URL, _init?: RequestInit) => path === '/api/portal/households'
    ? new Promise<Response>(resolve => { release = resolve; })
    : Response.json({ error: { code: 'conflict' } }, { status: 409, headers: { 'X-Portal-Household': other } }));
  vi.stubGlobal('fetch', fetcher);
  const hook = renderHook(usePortalScope, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider> });
  const settle = async (current = other) => {
    await act(async () => { release(Response.json({ data: { current, households: [{ householdId: current, name: 'Household', role: 'payer' }] } })); });
    await waitFor(() => expect(hook.result.current.moving).toBe(false));
  };
  return { ...hook, cache, fetcher, settle };
}

describe('portal write household preconditions', () => {
  it.each(Object.entries(portalContracts).filter(([, contract]) => contract.method !== 'get'))('%s sends the page household and recovers from a 409', async (name, contract: EndpointContract) => {
    const f = fixture();
    const params = Object.fromEntries([...contract.path.matchAll(/\{(\w+)\}/g)].map(match => [match[1]!, home]));
    await act(async () => { await expect(f.result.current.call(contract, inputs[name], params)).rejects.toBeInstanceOf(HouseholdMoved); });
    expect(new Headers(f.fetcher.mock.calls[0]![1]?.headers).get('X-Portal-Household')).toBe(home);
    expect(f.result.current.moving).toBe(true);
    expect(f.fetcher.mock.calls.filter(([path]) => path === '/api/portal/households')).toHaveLength(1);
    await f.settle();
    expect(f.result.current.key[4]).toBe(other);
  });
  it.each(['payer', 'member'] as const)('recovers from stale %s booking and cancellation', async role => {
    const f = fixture(), context = { role, memberId: home };
    for (const operation of [() => portalClient.book(context, home, home, home), () => portalClient.cancel(context, home, home, home)]) {
      await act(async () => { await expect(f.result.current.run(operation)).rejects.toBeInstanceOf(HouseholdMoved); });
    }
    expect(f.result.current.moving).toBe(true);
    expect(f.fetcher.mock.calls.filter(([path]) => path === '/api/portal/households')).toHaveLength(1);
    await f.settle();
  });
  it.each<[string, () => Promise<unknown>]>([
    ['check-in code',() => portalClient.checkinCode(home, home)],
    ['regenerated check-in code', () => portalClient.regenerateCheckin(home, 1, home)],
    ['progress', () => portalClient.progress(home, home)],
    ['attendance', () => portalClient.attendance(home, 0, home)],
  ])('names the household on the member-scoped %s request and recovers from a 409', async (_name, operation) => {
    const f = fixture();
    await act(async () => { await expect(f.result.current.run(operation)).rejects.toBeInstanceOf(HouseholdMoved); });
    expect(new Headers(f.fetcher.mock.calls[0]![1]?.headers).get('X-Portal-Household')).toBe(home);
    expect(f.result.current.moving).toBe(true);
    await f.settle();
    expect(f.result.current.key[4]).toBe(other);
  });
  it('leaves revision conflicts with the form, without refreshing household lists', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'conflict' } }, { status: 409 }));
    await act(async () => { await expect(f.result.current.call(portalContracts.updateHousehold, { revision: 1 })).rejects.toBeInstanceOf(ApiError); });
    expect(f.result.current.moving).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('shares an in-flight and just-completed list read among mismatched answers', async () => {
    const f = fixture(), key = portalHouseholdKey(portalLoginKey('gym', 'user'), home);
    const version = householdListsVersion(f.cache, key);
    for (let n = 0; n < 3; n++) expect(() => ownAnswer(f.cache, key, { householdId: other }, version)).toThrow(HouseholdMoved);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await f.settle(home);
    expect(() => ownAnswer(f.cache, key, { householdId: other }, version)).toThrow(HouseholdMoved);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(() => ownAnswer(f.cache, key, { householdId: other }, householdListsVersion(f.cache, key))).toThrow(HouseholdMoved);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    await f.settle();
  });
  it('does not mistake an unrelated list result for recovery of a late response', async () => {
    const f = fixture(), login = portalLoginKey('gym', 'user'), key = portalHouseholdKey(login, home);
    const version = householdListsVersion(f.cache, key);
    f.cache.setQueryData(portalHouseholdsKey(login), { current: home, households: [] });
    expect(householdListsVersion(f.cache, key)).toBeGreaterThan(version);
    expect(() => ownAnswer(f.cache, key, { householdId: other }, version)).toThrow(HouseholdMoved);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await f.settle();
  });
  it('discards recovery history when sign-out clears the cache', async () => {
    const f = fixture(), login = portalLoginKey('gym', 'user'), key = portalHouseholdKey(login, home);
    expect(() => ownAnswer(f.cache, key, { householdId: other }, householdListsVersion(f.cache, key))).toThrow(HouseholdMoved);
    await f.settle(home);
    f.cache.clear();
    f.cache.setQueryData(portalHouseholdsKey(login), { current: home, households: [] });
    expect(() => ownAnswer(f.cache, key, { householdId: other }, householdListsVersion(f.cache, key))).toThrow(HouseholdMoved);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    await f.settle();
  });
});
