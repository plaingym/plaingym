// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import type { Household } from '@plaingym/shared/contracts';
import { campaignClient, householdsNeedingCard } from './api.js';
import { api, ApiError } from '../../lib/api.js';

const households: Household[] = ['empty', 'active', 'revoked-only'].map(id => ({ id, name: id, email: null,
  phone: null, address: {}, revision: 1, createdAt: '2026-10-26T12:00:00Z' }));

it('pages the server filter and keeps only the editor households, in their order', async () => {
  // The server answers for the whole gym, so it can name a household the editor doesn't list.
  const pages = [['revoked-only', 'other'], ['empty']];
  const load = vi.fn(async (offset: number) => ({ data: pages[offset / 2]!.map(householdId => ({ householdId })),
    pagination: { total: 3, limit: 2, offset } }));
  expect(await householdsNeedingCard(households, load)).toEqual(['empty', 'revoked-only']);
  expect(load.mock.calls).toEqual([[0], [2]]);
});

it('sends one request for the whole gym instead of one per household', async () => {
  const householdId = '01900000-0000-7000-8000-000000000001';
  const get = vi.spyOn(api, 'GET').mockResolvedValue({ response: new Response('{}'),
    data: { data: [{ householdId }], pagination: { total: 1, limit: 100, offset: 0 } } });
  try {
    expect(await campaignClient.needsCard([...households, { ...households[0]!, id: householdId }])).toEqual([householdId]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/link-campaign-households/needing-card', { params: { query: { limit: 100, offset: 0 } } });
  } finally { get.mockRestore(); }
});

it('does not classify households as missing a card after an incomplete or failed response', async () => {
  await expect(householdsNeedingCard(households, async () => ({ data: [], pagination: { total: 1, limit: 100, offset: 0 } })))
    .rejects.toThrow('Incomplete household list');
  await expect(householdsNeedingCard(households, async () => { throw new Error('Unavailable'); })).rejects.toThrow('Unavailable');
});

it('preserves only the safe invalid-request code for campaign limit feedback', async () => {
  const post = vi.spyOn(api, 'POST').mockResolvedValue({ response: new Response('{}', { status: 400 }),
    error: { error: { code: 'invalid_request', message: 'Private server detail', requestId: 'test' } } });
  try {
    await expect(campaignClient.create({ name: 'Cards', purpose: 'update_card', reminderSchedule: [],
      expiresAt: '2026-11-26T12:00:00Z', recipients: [{ householdId: '01900000-0000-7000-8000-000000000002' }] }))
      .rejects.toEqual(new ApiError(400, 'invalid_request'));
  } finally { post.mockRestore(); }
});
