// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import type { ClassPack } from '@plaingym/shared/contracts';
import { createPackClient } from './api.js';
import { ApiError } from '../../../lib/api.js';

const id = (n: number) => '019a0af0-9c00-7000-8000-' + String(n).padStart(12, '0');
const createdAt = '2026-11-10T00:00:00Z';
const pack: ClassPack = { id: id(1), name: 'Pack', currency: 'CAD', amountCents: 12000, credits: 10,
  expiryDays: null, active: false, taxRateIds: [], revision: 1, createdAt };
const page = (data: unknown[], offset: number, total: number) => Response.json({ data, pagination: { limit: 100, offset, total } });

it('loads every catalog page including archived packs and tolerates additive response fields', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page([{ ...pack, futureField: true }], 0, 2)).mockResolvedValueOnce(page([{ ...pack, id: id(2), active: true }], 1, 2));
  expect(await createPackClient(fetcher).packs()).toEqual([pack, { ...pack, id: id(2), active: true }]);
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/billing/class-packs?offset=0&limit=100', '/api/billing/class-packs?offset=1&limit=100']);
});
it('refuses an incomplete catalog page rather than looping forever', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page([], 0, 1));
  await expect(createPackClient(fetcher).packs()).rejects.toThrow('Incomplete catalog'); expect(fetcher).toHaveBeenCalledOnce();
});
it('uses the member parameter and paging for credit history', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { memberId: id(2), balance: 0, lots: [], entries: [] }, pagination: { offset: 25, limit: 25, total: 25 } }));
  await createPackClient(fetcher).ledger(id(2), 25);
  expect(fetcher).toHaveBeenCalledWith('/api/billing/members/' + id(2) + '/credits?offset=25&limit=25', expect.objectContaining({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' }));
});
it('preserves structured server refusal codes', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { details: { reason: ['insufficient_credits'] } } }, { status: 409 }));
  await expect(createPackClient(fetcher).call('adjustClassCredits', { memberId: id(2), credits: -3, reason: 'Correction', adjustmentId: id(3) })).rejects.toEqual(new ApiError(409, 'conflict', ['insufficient_credits']));
});
it('validates invalid adjustments before sending a request', async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(createPackClient(fetcher).call('adjustClassCredits', { memberId: id(2), credits: 0, reason: '', adjustmentId: id(3) })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
