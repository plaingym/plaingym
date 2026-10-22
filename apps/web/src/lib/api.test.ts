// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, createJsonTransport } from './api.js';
import { createShellServices, sessionDestination } from '../app/services.js';
import { createShellTranslator } from './i18n.js';

describe('API transport', () => {
  it('preserves the generated typed client export', () => {
    const client = createApiClient({ baseUrl: 'https://example.org' });
    expect(client.GET).toBeTypeOf('function'); expect(client.POST).toBeTypeOf('function');
  });
  it('sends local JSON with same-origin credentials, a signal, and no redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const signal = new AbortController().signal;
    expect(await createJsonTransport(fetcher)('/api/auth/sign-out', {}, signal)).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith('/api/auth/sign-out', {
      method: 'POST', credentials: 'same-origin', redirect: 'error', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}',
    });
  });
  it.each(['https://evil.example/api/auth', '//evil.example/api/auth', '/portal', '/api/auth?redirect=evil', '/api/auth#hash', '/api/\\evil'])('rejects a non-local API path %s', async (path) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createJsonTransport(fetcher)(path)).rejects.toThrow('Expected a local API path');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sanitizes server errors while retaining the status for UI handling', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private SQL detail', { status: 429 }));
    const error = await createJsonTransport(fetcher)('/api/auth/get-session').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', message: 'Request failed' });
    expect(String(error)).not.toContain('SQL');
  });
  it('normalizes email, keeps passwords exact, and fixes callbacks to the local login page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
    const bootstrap = vi.fn();
    const service = createShellServices(bootstrap, fetcher);
    await service.signInWithPassword(' Owner@Example.org ', '  exact password  ');
    await service.requestMagicLink(' Member@Example.org ');
    await service.signOut();
    expect(fetcher.mock.calls.map(([path, init]) => [path, JSON.parse(String(init?.body))])).toEqual([
      ['/api/auth/sign-in/email', { email: 'owner@example.org', password: '  exact password  ' }],
      ['/api/auth/sign-in/magic-link', { email: 'member@example.org', callbackURL: '/login', errorCallbackURL: '/login' }],
      ['/api/auth/sign-out', {}],
    ]);
    expect(bootstrap).not.toHaveBeenCalled();
  });
});
describe('shell projections', () => {
  it('prioritizes staff access for a user who is also a member', () => {
    expect(sessionDestination({ userId: 'a', roles: ['coach'], member: true })).toBe('/admin');
    expect(sessionDestination({ userId: 'a', roles: [], member: true })).toBe('/portal');
    expect(sessionDestination({ userId: 'a', roles: [], member: false })).toBeNull();
  });
  it('uses loaded locale namespaces and supports overrides, placeholders and missing keys', () => {
    const translate = createShellTranslator({ 'shell/shell': { title: 'Hello {name}' }, 'gym/name': { title: 'Academy' } });
    expect(translate('shell/shell:title', { name: 'Alex' })).toBe('Hello Alex');
    expect(translate('shell/shell:email')).toBe('Email address');
    expect(translate('gym/name:title')).toBe('Academy');
    expect(translate('unknown:key')).toBe('unknown:key');
  });
});
