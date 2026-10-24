// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { TestClock } from './clock.js';
import { rateLimit, type RateLimitOptions } from './rate-limit.js';

function fixture(options: RateLimitOptions = {}) {
  const clock = new TestClock('2026-01-01T00:00:00Z');
  const app = createApp({ clock,
    resolveGym: async (context, next) => {
      const gymId = new URL(context.req.url).hostname;
      context.set('context', { ...context.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } });
      await next();
    },
    session: async (_context, next) => { await next(); },
    authorize: () => async (_context, next) => { await next(); },
    rateLimit: { limit: 2, windowMs: 2000, peerAddress: () => '127.0.0.1', ...options },
  });
  app.get('/api/action', (context) => context.json({ ok: true }));
  return { app, clock };
}

it('enforces the exact threshold, supplies retry timing, and resets using the injected clock', async () => {
  const { app, clock } = fixture();
  const responses = await Promise.all(Array.from({ length: 5 }, () => app.request('/api/action')));
  expect(responses.map((response) => response.status)).toEqual([200, 200, 429, 429, 429]);
  const denied = responses[2]!;
  expect(denied.headers.get('retry-after')).toBe('2');
  expect(await denied.json()).toMatchObject({ error: { code: 'rate_limited' }, requestId: denied.headers.get('x-request-id') });
  clock.advance(1001);
  expect((await app.request('/api/action')).headers.get('retry-after')).toBe('1');
  clock.advance(999);
  expect((await app.request('/api/action')).status).toBe(200);
});

it('isolates rate-limit buckets by gym', async () => {
  const { app } = fixture({ limit: 1 });
  expect((await app.request('https://a.example/api/action')).status).toBe(200);
  expect((await app.request('https://a.example/api/action')).status).toBe(429);
  expect((await app.request('https://b.example/api/action')).status).toBe(200);
});

it('ignores spoofed forwarding headers when the socket peer is not trusted', async () => {
  const { app } = fixture({ limit: 1, trustedProxy: (address) => address === '192.0.2.5' });
  expect((await app.request('/api/action', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status).toBe(200);
  expect((await app.request('/api/action', { headers: { 'x-forwarded-for': '192.0.2.2', 'x-real-ip': '192.0.2.3' } })).status).toBe(429);
});

it('uses only the closest forwarded client behind a trusted socket peer', async () => {
  const { app } = fixture({ limit: 1, trustedProxy: (address) => address === '127.0.0.1' });
  const request = (value: string) => app.request('/api/action', { headers: { 'x-forwarded-for': value } });
  expect((await request('198.51.100.2, 192.0.2.1')).status).toBe(200);
  expect((await request('198.51.100.3, 192.0.2.1')).status).toBe(429);
  expect((await request('192.0.2.2')).status).toBe(200);
});

it('falls back to the socket bucket for invalid forwarded addresses', async () => {
  const { app } = fixture({ limit: 1, trustedProxy: () => true });
  expect((await app.request('/api/action', { headers: { 'x-forwarded-for': 'not-an-ip' } })).status).toBe(200);
  expect((await app.request('/api/action')).status).toBe(429);
});

it('bounds memory without evicting active buckets to bypass a limit', async () => {
  const { app, clock } = fixture({ limit: 1, maxBuckets: 1 });
  expect((await app.request('https://a.example/api/action')).status).toBe(200);
  expect((await app.request('https://b.example/api/action')).status).toBe(429);
  expect((await app.request('https://a.example/api/action')).status).toBe(429);
  clock.advance(2000);
  expect((await app.request('https://b.example/api/action')).status).toBe(200);
});

it('shares a conservative bucket when no socket address is available', async () => {
  const { app } = fixture({ limit: 1, peerAddress: () => undefined, trustedProxy: () => true });
  expect((await app.request('/api/action', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status).toBe(200);
  expect((await app.request('/api/action', { headers: { 'x-forwarded-for': '192.0.2.2' } })).status).toBe(429);
});

it.each([0, -1, NaN, Infinity, 0.5])('rejects invalid limiter settings: %s', (value) => {
  for (const key of ['limit', 'windowMs', 'maxBuckets']) expect(() => rateLimit({ [key]: value })).toThrow();
});

it('gives route-level limiters the trusted client address, not the proxy socket', async () => {
  const { app } = fixture({ limit: 100, trustedProxy: (address) => address === '127.0.0.1' });
  // Configured without proxy options, as a route's own limiter is.
  app.post('/api/invite', rateLimit({ limit: 1 }), (context) => context.json({ ok: true }));
  const invite = (client: string) => app.request('/api/invite', { method: 'POST', headers: { 'x-forwarded-for': client } });
  expect((await invite('198.51.100.2')).status).toBe(200);
  expect((await invite('198.51.100.3')).status).toBe(200);
  expect((await invite('198.51.100.2')).status).toBe(429);
});

it('limits requests before the session middleware answers them', async () => {
  const clock = new TestClock('2026-01-01T00:00:00Z');
  let answered = 0;
  const app = createApp({ clock,
    resolveGym: async (context, next) => {
      context.set('context', { ...context.get('context'), gym: { gymId: 'gym', timezone: 'UTC', enabledModules: new Set() } });
      await next();
    },
    // The session middleware answers auth requests without calling next, as Better Auth dispatch does.
    session: async (context) => { answered++; return context.json({ ok: true }); },
    authorize: () => async (_context, next) => { await next(); },
    rateLimit: { limit: 1, peerAddress: () => '127.0.0.1' },
  });
  expect((await app.request('/api/auth/sign-in/email', { method: 'POST' })).status).toBe(200);
  expect((await app.request('/api/auth/sign-in/email', { method: 'POST' })).status).toBe(429);
  expect(answered).toBe(1);
});
