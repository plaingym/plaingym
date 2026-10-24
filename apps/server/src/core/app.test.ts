// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { AppError } from '@plaingym/shared';
import type { MiddlewareHandler } from 'hono';
import { createApp } from './app.js';
import { app as defaultApp } from '../app.js';
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
