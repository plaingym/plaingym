// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { AppError } from '@plaingym/shared';
import type { MiddlewareHandler } from 'hono';
import { createApp } from './app.js';
import { cspNonce } from './csp.js';
import { app as defaultApp } from '../closed-app.js';
import type { RequestEnvironment } from './context.js';
import { TestClock } from './clock.js';
import { route, type PermissionMiddleware } from './registry.js';
import { areaContributions } from './registry-areas.js';

const clock = new TestClock('2026-01-01T00:00:00Z');
const resolveGym: MiddlewareHandler<RequestEnvironment> = async (context, next) => {
  context.set('context', { ...context.get('context'), gym: { gymId: 'gym-a', timezone: 'UTC', enabledModules: new Set() } });
  await next();
};
const session: MiddlewareHandler<RequestEnvironment> = async (_context, next) => { await next(); };
const allow: PermissionMiddleware = () => async (_context, next) => { await next(); };

describe('server application composition', () => {
  it('runs context, tenancy, limiter, session, CSRF, authorization, validation, and handler in order', async () => {
    const calls: string[] = [];
    const entry = route({ method: 'post', path: '/api/fixture', permission: { kind: 'public' },
      request: { body: { required: true, content: { 'application/json': { schema: z.object({ value: z.string() }) } } } },
      responses: { 200: { description: 'Fixture', content: { 'application/json': { schema: z.object({ value: z.string() }) } } } },
    }, (context) => {
      calls.push('handler');
      expect(context.get('context').clock).toBe(clock);
      return context.json(context.req.valid('json'), 200);
    });
    const app = createApp({ clock, contributions: { routes: [entry] },
      resolveGym: async (context, next) => {
        expect(context.get('context').requestId).toMatch(/^[a-f0-9-]{36}$/);
        expect(context.get('context').clock).toBe(clock);
        calls.push('gym'); return resolveGym(context, next);
      },
      session: async (context, next) => {
        expect(context.get('context').gym.gymId).toBe('gym-a'); calls.push('session');
        context.set('context', { ...context.get('context'), principal: { kind: 'staff', gymId: 'gym-a', userId: 'user', roles: ['owner'] } });
        await next();
      },
      origin: (context) => { expect(context.get('context').principal.kind).toBe('staff'); calls.push('csrf'); return 'http://localhost'; },
      // The client address is resolved once, with the request context, before tenancy.
      rateLimit: { limit: 2, peerAddress: (context) => { expect(context.get('context').requestId).toMatch(/^[a-f0-9-]{36}$/); calls.push('address'); return '127.0.0.1'; } },
      authorize: () => async (_context, next) => { calls.push('authorize'); await next(); },
    });
    const request = (body: string, origin = 'http://localhost') => app.request('/api/fixture', {
      method: 'POST', headers: { cookie: 'session=secret', origin, 'content-type': 'application/json' }, body,
    });
    expect((await request('{"value":"ok"}')).status).toBe(200);
    expect(calls).toEqual(['address', 'gym', 'session', 'csrf', 'authorize', 'handler']);
    calls.length = 0;
    expect((await request('{}', 'https://evil.example')).status).toBe(403);
    expect(calls).toEqual(['address', 'gym', 'session', 'csrf']);
    calls.length = 0;
    // The limiter answers before the session middleware, which handles auth requests itself.
    expect((await request('{}')).status).toBe(429);
    expect(calls).toEqual(['address', 'gym']);
  });

  it('forbids framing every response, keeping the policy a route sets', async () => {
    const app = createApp({ resolveGym, session: async (_context, next) => { await next(); }, authorize: () => async (_context, next) => { await next(); } });
    app.get('/api/plain', (context) => context.json({ ok: true }));
    app.get('/api/own-policy', (context) => context.body('file', 200, { 'Content-Security-Policy': "default-src 'none'; sandbox" }));
    for (const path of ['/api/plain', '/api/missing', '/healthz']) {
      const response = await app.request(path);
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      expect(response.headers.get('content-security-policy-report-only')).toBe("default-src 'self'; script-src 'self'; style-src 'self'; "
        + "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; "
        + 'report-uri /csp-report; report-to csp');
      expect(response.headers.get('reporting-endpoints')).toBe('csp="/csp-report"');
    }
    const own = await app.request('/api/own-policy');
    expect(own.headers.get('x-frame-options')).toBe('DENY');
    expect(own.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(own.headers.has('content-security-policy-report-only')).toBe(false);
    expect(own.headers.has('reporting-endpoints')).toBe(false);
  });
  it('sends HSTS only in production, for the canonical https: host', async () => {
    const paths = ['/api/plain', '/api/fails', '/api/own-policy', '/api/missing', '/healthz'];
    const hsts = async (options: Partial<Parameters<typeof createApp>[0]>, host = 'gym.example') => {
      const app = createApp({ resolveGym, session, authorize: allow, ...options });
      app.get('/api/plain', (context) => context.json({ ok: true }));
      app.get('/api/fails', () => { throw new AppError('conflict', 'Fixture conflict.'); });
      app.get('/api/own-policy', (context) => context.body('file', 200, { 'Content-Security-Policy': "default-src 'none'; sandbox" }));
      return Promise.all(paths.map(async (path) => (await app.request(`https://${host}${path}`)).headers.get('strict-transport-security')));
    };
    const sent = paths.map(() => 'max-age=31536000'), none = paths.map(() => null);
    expect(await hsts({ strictTransportSecurity: true, origin: 'https://gym.example' })).toEqual(sent);
    expect(await hsts({ strictTransportSecurity: true, installOrigin: 'https://gym.example' })).toEqual(sent);
    // Development, a plain HTTP origin, no canonical origin, and any other hostname send nothing.
    for (const options of [{ origin: 'https://gym.example' }, { strictTransportSecurity: false, origin: 'https://gym.example' },
      { strictTransportSecurity: true, origin: 'http://gym.example' }, { strictTransportSecurity: true }])
      expect(await hsts(options)).toEqual(none);
    expect(await hsts({ strictTransportSecurity: true, origin: 'https://gym.example' }, 'other.example')).toEqual(none);
    // A per-gym origin pins only a hostname that resolved to a gym; install endpoints use the install origin.
    const perGym = { strictTransportSecurity: true, installOrigin: 'https://install.example',
      origin: (context: Parameters<MiddlewareHandler<RequestEnvironment>>[0]) => 'https://' + new URL(context.req.url).host,
      resolveGym: (async (context, next) => {
        if (new URL(context.req.url).hostname !== 'gym.example') throw new AppError('not_found', 'Gym not found');
        await resolveGym(context, next);
      }) satisfies MiddlewareHandler<RequestEnvironment> };
    expect(await hsts(perGym)).toEqual([...sent.slice(0, 4), null]);
    expect(await hsts(perGym, 'unknown.example')).toEqual(none);
    expect(await hsts(perGym, 'install.example')).toEqual(sent);
  });
  it('reports, without blocking, inline scripts without the response nonce and images from unlisted origins', async () => {
    const app = createApp({ resolveGym, session, authorize: allow, contentSecurity: { imageOrigins: ['https://uploads.example.test'] } });
    app.get('/page', (context) => context.html(`<script nonce="${cspNonce(context)}">1</script>`));
    const pages = await Promise.all([app.request('/page'), app.request('/page')]);
    const nonces = await Promise.all(pages.map(async (page) => {
      const nonce = /nonce="([^"]+)"/.exec(await page.text())![1]!;
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(page.headers.get('content-security-policy-report-only')).toContain(`script-src 'self' 'nonce-${nonce}';`);
      expect(page.headers.get('content-security-policy-report-only')).toContain("img-src 'self' data: https://uploads.example.test;");
      return nonce;
    }));
    expect(nonces[0]).not.toBe(nonces[1]);
    for (const origin of ['https://uploads.example.test/', 'https://*.example.test', 'javascript:alert(1)'])
      expect(() => createApp({ resolveGym, session, authorize: allow, contentSecurity: { imageOrigins: [origin] } })).toThrow();
  });
  it('authorizes before input validation and formats validation and malformed JSON errors', async () => {
    const entry = route({ method: 'post', path: '/api/validate', permission: { kind: 'staff', capability: 'members.read' },
      request: { body: { required: true, content: { 'application/json': { schema: z.object({ name: z.string() }) } } } },
      responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } } },
    }, (context) => context.json({ ok: true }, 200));
    const app = createApp({ resolveGym, session, contributions: { routes: [entry] },
      authorize: () => async (context, next) => {
        if (context.req.header('x-allow') !== 'yes') throw new AppError('forbidden', 'Access denied.');
        await next();
      },
    });
    for (const body of ['{}', '{invalid']) {
      const request = (allowed: boolean) => app.request('/api/validate', {
        method: 'POST', body, headers: { 'content-type': 'application/json', ...(allowed ? { 'x-allow': 'yes' } : {}) },
      });
      expect((await request(false)).status).toBe(403);
      const result = await request(true);
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({ error: { code: 'invalid_request' }, requestId: result.headers.get('x-request-id') });
    }
  });

  it('keeps install health and source metadata ahead of tenancy and outside the limiter', async () => {
    const app = createApp({ resolveGym: () => { throw new Error('Must not resolve'); }, session, authorize: allow, sourceUrl: 'https://example.org/source/v1' });
    for (let i = 0; i < 3; i++) expect(await (await app.request('/healthz')).json()).toEqual({ status: 'ok' });
    const response = await app.request('/api/source');
    expect(await response.json()).toEqual({ data: { url: 'https://example.org/source/v1' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await app.request('/source')).headers.get('location')).toBe('https://example.org/source/v1');
    expect((await app.request('/api/missing')).status).toBe(500);
  });

  it('generates server request IDs and never echoes caller-supplied correlation values', async () => {
    const a = await defaultApp.request('/healthz', { headers: { 'x-request-id': 'caller-controlled' } });
    const b = await defaultApp.request('/healthz');
    expect(a.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(b.headers.get('x-request-id')).not.toBe(a.headers.get('x-request-id'));
  });

  it('leaves every gym surface closed in the default export', async () => {
    for (const path of ['/api/settings', '/api/auth/bootstrap', '/api/openapi.json', '/admin', '/portal', '/kiosk', '/join', '/webhooks/stripe']) {
      const response = await defaultApp.request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' }, requestId: response.headers.get('x-request-id') });
    }
  });

  it('generates OpenAPI from the same route registry it mounts', async () => {
    const app = createApp({ resolveGym, session, authorize: allow, contributions: areaContributions });
    const response = await app.request('/api/openapi.json');
    expect(response.status).toBe(200);
    const document = await response.json();
    expect(document.openapi).toBe('3.0.3');
    expect(document.paths['/api/auth/bootstrap'].get).toBeDefined();
    expect(document.paths['/api/settings'].get.responses['200']).toBeDefined();
    expect(document.paths['/api/settings'].patch.requestBody).toBeDefined();
    expect(document.paths['/healthz'].get).toBeDefined();
    expect(document.paths['/api/source'].get).toBeDefined();
    expect(document.paths['/source'].get.responses['302']).toBeDefined();
    expect(document.paths['/api/openapi.json'].get).toBeDefined();
  });

  it('uses the standard envelope for route misses', async () => {
    const app = createApp({ resolveGym, session, authorize: allow });
    const response = await app.request('/api/missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' }, requestId: response.headers.get('x-request-id') });
  });
});
