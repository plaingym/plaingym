// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { createDiscountClient } from './api.js';

it('rejects a malformed discount before sending a request', async () => {
  const fetcher = vi.fn();
  await expect(createDiscountClient(fetcher).create({ name: 'Missing terms' })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('keeps structured staff refusal reasons', async () => {
  const fetcher = vi.fn(async () => Response.json({ error: { code: 'conflict', message: 'Refused', details: { reason: ['discount_used_up'] } } }, { status: 409 }));
  await expect(createDiscountClient(fetcher).list()).rejects.toMatchObject({ status: 409, reason: ['discount_used_up'] });
});
it('refuses malformed list responses', async () => {
  const fetcher = vi.fn(async () => Response.json({ data: [{ id: 'broken' }], pagination: { offset: 0, limit: 100, total: 1 } }));
  await expect(createDiscountClient(fetcher).list()).rejects.toThrow();
});
