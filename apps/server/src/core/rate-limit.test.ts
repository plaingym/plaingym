// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { TestClock } from './clock.js';
import { clientKey, RateBuckets, rateLimit, type RateLimitOptions } from './rate-limit.js';

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

it('keys IPv4 as it is, IPv4-mapped IPv6 as IPv4, and other IPv6 by its /64', () => {
  expect(clientKey('192.0.2.1')).toBe('192.0.2.1');
  for (const mapped of ['::ffff:192.0.2.1', '::FFFF:192.0.2.1', '::ffff:c000:201', '0:0:0:0:0:ffff:c000:0201'])
    expect(clientKey(mapped)).toBe('192.0.2.1');
  for (const address of ['2001:db8:a:b::1', '2001:DB8:A:B:ffff:ffff:ffff:ffff', '2001:0db8:000a:000b:0:0:0:9', '2001:db8:a:b::1%eth0'])
    expect(clientKey(address)).toBe('2001:db8:a:b::/64');
  expect(clientKey('2001:db8:a:c::1')).toBe('2001:db8:a:c::/64');
  expect(clientKey('::1')).toBe('0:0:0:0::/64');
  expect(clientKey('::')).toBe('0:0:0:0::/64');
  // Only the ::ffff:0:0/96 prefix is IPv4-mapped; other embedded IPv4 forms are ordinary IPv6.
  expect(clientKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
  expect(clientKey('unknown')).toBe('unknown');
});

it('shares one bucket across a /64, keeps other /64s apart, and counts IPv4-mapped addresses as IPv4', async () => {
  let peer = '';
  const { app } = fixture({ limit: 1, peerAddress: () => peer });
  const status = async (address: string) => { peer = address; return (await app.request('/api/action')).status; };
  expect(await status('2001:db8:a:b::1')).toBe(200);
  expect(await status('2001:db8:a:b:1234:5678:9abc:def0')).toBe(429);
  expect(await status('2001:db8:a:c::1')).toBe(200);
  expect(await status('192.0.2.1')).toBe(200);
  expect(await status('::ffff:192.0.2.1')).toBe(429);
  expect(await status('::ffff:192.0.2.2')).toBe(200);
});

it('limits 1,000 joins from one /64 to one budget and still admits a fresh visitor (the 2026-10-30 reproduction)', async () => {
  let peer = '';
  // The join routes' own limit, with the table sized to the flood.
  const { app } = fixture({ limit: 10, windowMs: 15 * 60_000, maxBuckets: 1000, peerAddress: () => peer });
  const statuses: number[] = [];
  for (let i = 0; i < 1000; i++) {
    peer = `2001:db8:a:b:${i.toString(16)}::1`;
    statuses.push((await app.request('/api/action')).status);
  }
  expect(statuses.filter((value) => value === 200)).toHaveLength(10);
  expect(statuses.filter((value) => value === 429)).toHaveLength(990);
  peer = '198.51.100.7';
  expect((await app.request('/api/action')).status).toBe(200);
});

it('evicts the oldest buckets when the table is full instead of refusing new clients', async () => {
  let peer = '';
  const { app, clock } = fixture({ limit: 1, maxBuckets: 3, peerAddress: () => peer });
  const request = (address: string) => { peer = address; return app.request('/api/action'); };
  expect((await request('192.0.2.1')).status).toBe(200);
  expect((await request('192.0.2.1')).status).toBe(429);
  clock.advance(500);
  for (const address of ['2001:db8:1::1', '2001:db8:2::1', '2001:db8:3::1']) expect((await request(address)).status).toBe(200);
  // Every bucket is over its limit, so the oldest made room for the third /64 and its client starts a new window.
  expect((await request('192.0.2.1')).status).toBe(200);
  // Newer buckets keep their windows, and a real refusal keeps its retry timing.
  const refused = await request('2001:db8:3::2');
  expect(refused.status).toBe(429);
  expect(refused.headers.get('retry-after')).toBe('2');
});

it('keeps a refused client refused while a flood of new clients fills the table', async () => {
  let peer = '';
  const { app } = fixture({ limit: 2, maxBuckets: 3, peerAddress: () => peer });
  const request = (address: string) => { peer = address; return app.request('/api/action'); };
  for (let i = 0; i < 3; i++) await request('192.0.2.1');
  for (let i = 0; i < 50; i++) expect((await request(`2001:db8:${i.toString(16)}::1`)).status).toBe(200);
  expect((await request('192.0.2.1')).status).toBe(429);
});

it('evicts ended windows and buckets within their limits first, and keeps the keys a request asks to keep', () => {
  const buckets = new RateBuckets(3, (bucket) => bucket.count >= 2);
  buckets.add('blocked', { count: 2, resetAt: 100 }, 0);
  buckets.add('ended', { count: 2, resetAt: 10 }, 0);
  buckets.add('open', { count: 1, resetAt: 100 }, 0);
  buckets.add('a', { count: 2, resetAt: 120 }, 20);
  expect(buckets.get('ended', 0)).toBeUndefined();
  buckets.add('b', { count: 2, resetAt: 120 }, 20);
  expect([buckets.get('blocked', 20), buckets.get('open', 20)]).toEqual([expect.anything(), undefined]);
  // All three are over their limits now: the oldest goes, unless the request keeps it.
  buckets.add('c', { count: 0, resetAt: 120 }, 20, ['blocked']);
  expect([buckets.get('blocked', 20), buckets.get('a', 20), buckets.get('b', 20)]).toEqual([expect.anything(), undefined, expect.anything()]);
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
