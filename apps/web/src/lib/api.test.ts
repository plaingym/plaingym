// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiErrorReasons, checked, createApiClient, createJsonTransport, onApiError, readApiError, readRefusal, refusalError, reportApiRefusal } from './api.js';
import { t } from './i18n.js';
import { createBootstrapLoader, createShellServices, sessionDestination } from '../app/services.js';
import { createShellTranslator } from './i18n.js';
import { createBillingClient } from '../features/billing/catalog/api.js';
import { bookingClient } from '../features/bookings/client.js';
import { memberRequest } from '../features/members/api.js';
import { createRanksClient } from '../features/ranks/api.js';
import { createSetupClient } from '../features/setup/api.js';
import { portalClient } from '../features/portal/schedule/client.js';
import { createWaiversClient, WaiverRequestError } from '../features/waivers/api.js';
import { membersContracts } from '@plaingym/shared/contracts';

describe('API transport', () => {
  it('reports refusals from custom typed clients and preserves their structured error bodies', async () => {
    const body = { error: { code: 'forbidden', details: { reason: ['demo_showcase_read_only'] } } };
    const observe = vi.fn(), stop = onApiError(observe);
    try {
      const client = createApiClient({ baseUrl: 'https://example.test', fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: 403 })) });
      const result = await client.POST('/api/demo/login', { body: { role: 'owner' } });
      expect(result.error).toEqual(body); expect(observe).toHaveBeenCalledOnce();
      expect(() => checked(result)).toThrow(ApiError);
      expect(observe).toHaveBeenCalledOnce();
      const custom = Response.json(body, { status: 403 });
      await reportApiRefusal(custom);
      expect(await custom.json()).toEqual(body); expect(observe).toHaveBeenCalledTimes(2);
    } finally { stop(); }
  });
  it('reports JSON refusals once while error construction and mapping have no side effects', async () => {
    const body = { error: { code: 'forbidden', details: { reason: ['demo_showcase_read_only'] } } };
    const observe = vi.fn(), unsubscribe = onApiError(observe), original = globalThis.fetch;
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: 403 }));
      await expect(createJsonTransport(fetcher)('/api/demo/login', {})).rejects.toMatchObject({ status: 403, reason: ['demo_showcase_read_only'] });
      expect(observe).toHaveBeenCalledOnce();
      expect(() => checked({ response: new Response(null, { status: 403 }), error: body })).toThrow(ApiError);
      new ApiError(403, 'forbidden', ['demo_showcase_read_only']);
      expect(observe).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toBe(original);
    } finally { unsubscribe(); }
    new ApiError(403, 'forbidden', ['demo_showcase_read_only']);
    expect(observe).toHaveBeenCalledOnce();
  });
  it.each([
    ['catalog', (fetcher: typeof fetch) => createBillingClient(fetcher).plans()],
    ['bookings', () => bookingClient.members('')],
    ['members', () => memberRequest(membersContracts.listMembers.response, '/api/members')],
    ['ranks', (fetcher: typeof fetch) => createRanksClient(fetcher).systems()],
    ['rank members', (fetcher: typeof fetch) => createRanksClient(fetcher).members()],
    ['setup catalog', (fetcher: typeof fetch) => createSetupClient(fetcher).catalog()],
    ['setup magic link', (fetcher: typeof fetch) => createSetupClient(fetcher).magicLink('owner@example.test')],
    ['portal filtered read', () => portalClient.attendance('019a0000-0000-7000-8000-000000000001', 0, '019a0000-0000-7000-8000-000000000002')],
  ] as const)('reports one refusal when the %s client also throws an ApiError', async (_name, call) => {
    const reason = ['demo_showcase_read_only'];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { details: { reason } } }, { status: 403 }));
    const observe = vi.fn(), stop = onApiError(observe);
    vi.stubGlobal('fetch', fetcher);
    try {
      await expect(call(fetcher)).rejects.toMatchObject({ status: 403, reason });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 403, reason }));
    } finally { stop(); vi.unstubAllGlobals(); }
  });
  it.each([200, 400, 409, 429, 503])('does not notify refusal listeners for HTTP %s', async status => {
    const observe = vi.fn(), stop = onApiError(observe);
    try {
      await reportApiRefusal(Response.json({ error: { details: { reason: ['demo_showcase_read_only'] } } }, { status }));
      expect(observe).not.toHaveBeenCalled();
    } finally { stop(); }
  });
  it.each([undefined, 'Uploads are disabled in the demo'])('reports one refusal through the nested waiver transport (message: %s)', async message => {
    const reason = ['demo_showcase_read_only'], observe = vi.fn(), stop = onApiError(observe);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code: 'forbidden', message, details: { reason } } }, { status: 403 }));
    try {
      await expect(createWaiversClient(fetcher).call('listTemplates')).rejects.toBeInstanceOf(Error);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 403, reason }));
    } finally { stop(); }
  });
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
  it('reads a refusal once, notifies a 403 once per response and leaves the body readable', async () => {
    const body = { error: { code: 'forbidden', details: { reason: ['demo_showcase_read_only'] } } };
    const observe = vi.fn(), stop = onApiError(observe);
    try {
      const response = Response.json(body, { status: 403 });
      const refusal = await readRefusal(response);
      expect(refusal.reasons).toEqual(['demo_showcase_read_only']);
      expect(observe).toHaveBeenCalledOnce();
      await readRefusal(response); await reportApiRefusal(response);
      expect(await refusalError(response, 'x')).toMatchObject({ status: 403, code: 'x', reason: ['demo_showcase_read_only'] });
      expect(observe).toHaveBeenCalledOnce();
      expect(await response.json()).toEqual(body);
    } finally { stop(); }
  });
  it('still builds the error when a fetcher already read the refused body', async () => {
    const response = Response.json({ error: { details: { reason: ['a'] } } }, { status: 409 });
    await response.json();
    await expect(refusalError(response, 'request_failed')).resolves.toMatchObject({ status: 409, code: 'request_failed', reason: [] });
  });
  it.each([
    [403, {}], [403, { error: { details: { reason: [] } } }],
    [409, { error: { details: { reason: ['a'] } } }], [429, { error: { details: { reason: ['a'] } } }],
  ])('notifies nobody for HTTP %s with %j', async (status, body) => {
    const observe = vi.fn(), stop = onApiError(observe);
    try { await readRefusal(Response.json(body, { status })); expect(observe).not.toHaveBeenCalled(); } finally { stop(); }
  });
  it('builds the JSON transport error through the helper', async () => {
    const reason = ['demo_showcase_read_only'], observe = vi.fn(), stop = onApiError(observe);
    try {
      const forbidden = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { details: { reason } } }, { status: 403 }));
      await expect(createJsonTransport(forbidden)('/api/x')).rejects.toMatchObject({ status: 403, code: 'request_failed', reason });
      expect(observe).toHaveBeenCalledOnce();
      const limited = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 429 }));
      await expect(createJsonTransport(limited)('/api/x')).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    } finally { stop(); }
  });
  it('carries only a short upper-case code from an error body into the transport error', async () => {
    const answer = (body: unknown) => createJsonTransport(vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: 503 })))('/api/x').catch((value: unknown) => value as ApiError);
    expect(await answer({ code: 'EMAIL_UNAVAILABLE', message: 'secret detail' })).toMatchObject({ status: 503, code: 'EMAIL_UNAVAILABLE' });
    for (const code of ['x'.repeat(65).toUpperCase(), 'lower_case', 'HAS SPACE', 42]) {
      expect(await answer({ code, message: 'secret detail' })).toMatchObject({ status: 503, code: 'request_failed' });
    }
    expect(JSON.stringify(await answer({ code: 'A', message: 'secret detail' }))).not.toContain('secret detail');
  });
  it('overrides error reasons and returns allowed messages only for a matching status and code', async () => {
    const body = { error: { code: 'forbidden', message: 'Allowed', details: { reason: ['r'] } } };
    const refusal = await readRefusal(Response.json(body, { status: 409 }), [{ status: 409, code: 'forbidden' }]);
    expect(refusal.error('x', ['a'])).toMatchObject({ status: 409, code: 'x', reason: ['a'] });
    expect(refusal.message).toBe('Allowed');
    expect((await readRefusal(Response.json(body, { status: 409 }), [{ status: 400, code: 'forbidden' }])).message).toBeUndefined();
    expect((await readRefusal(Response.json(body, { status: 409 }), [{ status: 409, code: 'other' }])).message).toBeUndefined();
  });
  it('keeps each custom client to the same thrown error and one notification', async () => {
    const reason = ['demo_showcase_read_only'], observe = vi.fn(), stop = onApiError(observe);
    const refuse = (status: number, error: Record<string, unknown> = {}) => vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: { details: { reason }, ...error } }, { status }));
    try {
      // The setup client reads its token from the page fragment and session storage.
      vi.stubGlobal('window', { location: { hash: '', pathname: '/setup', search: '' }, history: { state: null, replaceState: vi.fn() } });
      vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
      vi.stubGlobal('fetch', refuse(409));
      await expect(memberRequest(membersContracts.listMembers.response, '/api/members')).rejects.toMatchObject({ status: 409, code: 'conflict', reason });
      await expect(createSetupClient(refuse(400, { details: { field: ['bad'] } })).call('status')).rejects.toMatchObject({ status: 400, code: 'request_failed', reason: ['bad'] });
      await expect(createBillingClient(refuse(409)).plans()).rejects.toMatchObject({ status: 409, code: 'conflict', reason });
      expect(observe).not.toHaveBeenCalled();
      vi.stubGlobal('fetch', refuse(403));
      await expect(memberRequest(membersContracts.listMembers.response, '/api/members')).rejects.toMatchObject({ status: 403, reason });
      await expect(createBillingClient(refuse(403)).plans()).rejects.toMatchObject({ status: 403, reason });
      await expect(createSetupClient(refuse(403)).call('status')).rejects.toMatchObject({ status: 403 });
      expect(observe).toHaveBeenCalledTimes(3);
    } finally { stop(); vi.unstubAllGlobals(); }
  });
  it('turns the demo uploads-disabled 403 into a waiver error after one notification', async () => {
    const observe = vi.fn(), stop = onApiError(observe);
    try {
      const message = t('demo/demo:uploadsDisabled');
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code: 'forbidden', message, details: { reason: ['demo'] } } }, { status: 403 }));
      const error = await createWaiversClient(fetcher).call('listTemplates').catch((value: unknown) => value);
      expect(error).toBeInstanceOf(WaiverRequestError);
      expect(error).toMatchObject({ message });
      expect(observe).toHaveBeenCalledOnce();
    } finally { stop(); }
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
