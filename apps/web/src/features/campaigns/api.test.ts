// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import type { Household, MaskedPaymentMethod } from '@plaingym/shared/contracts';
import { campaignClient, householdsNeedingCard } from './api.js';
import { api, ApiError } from '../../lib/api.js';

const households: Household[] = ['empty', 'active', 'revoked-only'].map(id => ({ id, name: id, email: null,
  phone: null, address: {}, revision: 1, createdAt: '2026-10-26T12:00:00Z' }));
const card: MaskedPaymentMethod = { id: 'card', householdId: 'active', brand: 'visa', last4: '4242',
  expiryMonth: 12, expiryYear: 2028, isDefault: true, revokedAt: null, createdAt: '2026-10-26T12:00:00Z' };

it('selects only households without an active card using the existing billing list contract', async () => {
  const revoked = { ...card, isDefault: false, revokedAt: '2026-10-26T12:00:00Z' };
  const load = vi.fn(async (id: string, offset: number) => ({
    data: id === 'empty' ? [] : id === 'active' && offset === 1 ? [card] : [revoked],
    pagination: { total: id === 'active' ? 2 : id === 'empty' ? 0 : 1, limit: 1, offset } }));
  expect(await householdsNeedingCard(households, load)).toEqual(['empty', 'revoked-only']);
  expect(load).toHaveBeenCalledTimes(4);
  expect(load).toHaveBeenCalledWith('active', 1);
});

it('does not classify households as missing a card after an incomplete or failed response', async () => {
  await expect(householdsNeedingCard(households, async () => ({ data: [], pagination: { total: 1, limit: 100, offset: 0 } })))
    .rejects.toThrow('Incomplete payment method list');
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
