// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createInvoiceClient } from './api.js';

describe('invoice error reasons', () => {
  it('uses the shared structured reason reader', async () => {
    const client = createInvoiceClient(async () => Response.json({ error: { message: 'Private detail',
      details: { reason: ['invoice_not_draft'] } } }, { status: 409 }));
    await expect(client.invoices({})).rejects.toMatchObject({ reason: 'invoice_not_draft', message: 'invoice_not_draft' });
  });
  it.each([[503, 'payments_unavailable'], [403, 'forbidden'], [409, 'save_failed']] as const)(
    'keeps the status fallback for malformed reasons (%s)', async (status, reason) => {
      const client = createInvoiceClient(async () => Response.json({ error: { details: { reason: ['private detail', 1] } } }, { status }));
      await expect(client.invoices({})).rejects.toMatchObject({ reason });
    });
  it('keeps the unavailable fallback for a non-JSON proxy response', async () => {
    const client = createInvoiceClient(async () => new Response('Proxy error', { status: 503 }));
    await expect(client.invoices({})).rejects.toMatchObject({ reason: 'payments_unavailable' });
  });
});
