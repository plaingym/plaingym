// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiErrorReasons, createApiClient, createJsonTransport, readApiError } from './api.js';
import { createBootstrapLoader, createShellServices, sessionDestination } from '../app/services.js';
import { createShellTranslator } from './i18n.js';

describe('API transport', () => {
  it('only exposes bounded messages allowed by status, code and optional exact text', async () => {
    const body = { error: { code: 'forbidden', message: 'Uploads are disabled in the demo', details: { reason: ['demo'] } } };
    const response = Response.json(body, { status: 403 });
    expect(await readApiError(response)).toEqual({ reasons: ['demo'] });
    expect(await readApiError(response, [{ status: 403, code: 'forbidden', message: body.error.message }]))
      .toEqual({ reasons: ['demo'], message: body.error.message });
    expect(await readApiError(response, [{ status: 403, code: 'forbidden', message: 'Different message' }])).toEqual({ reasons: ['demo'] });
    expect(await readApiError(response, [{ status: 409, code: 'forbidden' }])).toEqual({ reasons: ['demo'] });
    expect(await readApiError(response, [{ status: 403, code: 'conflict' }])).toEqual({ reasons: ['demo'] });
    expect(await response.json()).toEqual(body);
  });
  it.each(['', '  ', 'x'.repeat(2001)])('rejects an empty or oversized error message (%#)', async message => {
    expect(await readApiError(Response.json({ error: { code: 'unavailable', message } }, { status: 503 }),
      [{ status: 503, code: 'unavailable' }])).toEqual({ reasons: [] });
  });
  it('reads structured reason codes without consuming the response body', async () => {
    const body = { error: { message: 'Private server detail', details: { reason: ['tax_rate_attached', 'conflict'] } } };
    const response = Response.json(body, { status: 409 });
    expect(await apiErrorReasons(response)).toEqual(['tax_rate_attached', 'conflict']);
    expect(await response.json()).toEqual(body);
  });
  it.each([null, [], {}, { error: null }, { error: { details: null } }, { error: { details: { reason: 'conflict' } } },
    { error: { details: { reason: ['conflict', 1] } } }])('ignores malformed reason bodies: %j', async body => {
    expect(await apiErrorReasons(Response.json(body))).toEqual([]);
  });
  it('ignores non-JSON proxy errors', async () => {
    expect(await apiErrorReasons(new Response('Proxy error', { status: 503 }))).toEqual([]);
  });
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
  it('loads the shared bootstrap contract and rejects malformed server access', async () => {
    const bootstrap = { gym: { id: '00000000-0000-7000-8000-000000000001', name: 'Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: null, login: { password: true, magicLink: false } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: bootstrap })).mockResolvedValueOnce(Response.json({ data: { ...bootstrap, session: { roles: ['owner'] } } }));
    const signal = new AbortController().signal;
    expect(await createBootstrapLoader(fetcher)(signal)).toEqual(bootstrap);
    expect(fetcher).toHaveBeenCalledWith('/api/auth/bootstrap', expect.objectContaining({ signal, credentials: 'same-origin' }));
    await expect(createBootstrapLoader(fetcher)()).rejects.toThrow();
  });
  it('prioritizes staff access for a user who is also a member', () => {
    expect(sessionDestination({ userId: 'a', displayName: 'Test User', roles: ['coach'], member: true })).toBe('/admin');
    expect(sessionDestination({ userId: 'a', displayName: 'Test User', roles: [], member: true })).toBe('/portal');
    expect(sessionDestination({ userId: 'a', displayName: 'Test User', roles: [], member: false })).toBeNull();
  });
  it('uses loaded locale namespaces and supports overrides, placeholders and missing keys', () => {
    const translate = createShellTranslator({ 'shell/shell': { title: 'Hello {name}' }, 'gym/name': { title: 'Academy' } });
    expect(translate('shell/shell:title', { name: 'Alex' })).toBe('Hello Alex');
    expect(translate('shell/shell:email')).toBe('Email address');
    expect(translate('gym/name:title')).toBe('Academy');
    expect(translate('unknown:key')).toBe('unknown:key');
  });
});
