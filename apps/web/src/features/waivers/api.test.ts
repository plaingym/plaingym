// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { onApiError } from '../../lib/api.js';
import { createWaiversClient } from './api.js';

describe('waivers HTTP client', () => {
  it('notifies refusal listeners once on a 403 uploadDocument response and throws Error', async () => {
    const listener = vi.fn();
    const unsubscribe = onApiError(listener);
    try {
      const fetcher = vi.fn().mockResolvedValue(Response.json(
        { error: { details: { reason: ['role_required'] } } },
        { status: 403 },
      ));
      const client = createWaiversClient(fetcher as typeof fetch);
      const file = new File(['%PDF-1.4'], 'waiver.pdf', { type: 'application/pdf' });

      const failure = await client.uploadDocument(file).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).constructor).toBe(Error);
      expect((failure as Error).message).toBe('Document upload failed');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 403, reason: ['role_required'] }));
    } finally {
      unsubscribe();
    }
  });
});
