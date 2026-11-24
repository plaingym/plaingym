// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api.js';
import { createSetupClient } from './api.js';

describe('setup HTTP client magicLink', () => {
  it('posts to the magic-link endpoint and resolves on 200', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: true }));
    const client = createSetupClient(fetcher as typeof fetch);

    await expect(client.magicLink('owner@example.org')).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith('/api/auth/sign-in/magic-link', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      body: JSON.stringify({ email: 'owner@example.org', callbackURL: '/setup', errorCallbackURL: '/setup' }),
    }));
  });

  it('keeps the flat server EMAIL_UNAVAILABLE code on 503', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ code: 'EMAIL_UNAVAILABLE', message: 'SMTP down' }, { status: 503 }));
    const client = createSetupClient(fetcher as typeof fetch);

    const failure = await client.magicLink('owner@example.org').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 503, code: 'EMAIL_UNAVAILABLE' });
  });

  it('falls back to request_failed when EMAIL_UNAVAILABLE is nested in an error envelope', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: 'EMAIL_UNAVAILABLE' } }, { status: 503 }));
    const client = createSetupClient(fetcher as typeof fetch);

    const failure = await client.magicLink('owner@example.org').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 503, code: 'request_failed' });
  });
});
