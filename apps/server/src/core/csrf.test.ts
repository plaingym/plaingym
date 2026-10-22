// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import type { Principal } from './context.js';

function fixture(principal: Principal = { kind: 'anonymous' }) {
  const app = createApp({ origin: 'https://gym.example',
    resolveGym: async (context, next) => {
      context.set('context', { ...context.get('context'), gym: { gymId: 'a', timezone: 'UTC', enabledModules: new Set() } });
      await next();
    },
    session: async (context, next) => { context.set('context', { ...context.get('context'), principal }); await next(); },
    authorize: () => async (_context, next) => { await next(); },
  });
  app.all('*', (context) => context.json({ ok: true }));
  return app;
}

it.each([
  [{ cookie: 'session=x', origin: 'https://gym.example' }, 200],
  [{ cookie: 'session=x', origin: 'https://gym.example', 'sec-fetch-site': 'same-origin' }, 200],
  [{ cookie: 'session=x', origin: 'https://gym.example', 'sec-fetch-site': 'none' }, 200],
  [{ cookie: 'session=x' }, 403],
  [{ cookie: 'session=x', origin: 'null' }, 403],
  [{ cookie: 'session=x', origin: 'https://evil.example' }, 403],
  [{ cookie: 'session=x', origin: 'https://gym.example.evil.example' }, 403],
  [{ cookie: 'session=x', origin: 'https://gym.example', 'sec-fetch-site': 'cross-site' }, 403],
  [{ cookie: 'session=x', origin: 'https://gym.example', 'sec-fetch-site': 'same-site' }, 403],
  [{ cookie: 'session=x', origin: 'https://gym.example/path' }, 403],
  [{ cookie: 'session=x', origin: 'http://gym.example' }, 403],
  [{ origin: 'https://evil.example' }, 200],
] as const)('checks cookie-authenticated writes: %j', async (headers, status) => {
  expect((await fixture().request('https://gym.example/api/action', { method: 'POST', headers })).status).toBe(status);
});

it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('protects %s', async (method) => {
  expect((await fixture().request('/api/action', { method, headers: { cookie: 'session=x' } })).status).toBe(403);
});

it.each(['GET', 'HEAD', 'OPTIONS'])('permits safe method %s', async (method) => {
  expect((await fixture().request('/api/action', { method, headers: { cookie: 'session=x', origin: 'https://evil.example' } })).status).toBe(200);
});

it('exempts only the exact signature-verified webhook endpoint', async () => {
  const app = fixture();
  const request = (path: string) => app.request(path, { method: 'POST', headers: { cookie: 'session=x' } });
  expect((await request('/webhooks/stripe')).status).toBe(200);
  expect((await request('/webhooks/stripe/other')).status).toBe(403);
  expect((await request('/api/action')).status).toBe(403);
});

it('requires an authenticated same-gym kiosk principal and its bearer header for the kiosk exemption', async () => {
  const headers = { cookie: 'unrelated=value', authorization: 'Bearer device-token' };
  const kiosk = fixture({ kind: 'kiosk', gymId: 'a', deviceId: 'device' });
  expect((await kiosk.request('/api/kiosk/check-in', { method: 'POST', headers })).status).toBe(200);
  expect((await kiosk.request('/api/action', { method: 'POST', headers })).status).toBe(403);
  expect((await kiosk.request('/api/kiosk/check-in', { method: 'POST', headers: { cookie: 'session=x' } })).status).toBe(403);
  for (const principal of [{ kind: 'anonymous' }, { kind: 'staff', gymId: 'a', userId: 'user', roles: ['owner'] },
    { kind: 'kiosk', gymId: 'b', deviceId: 'device' }] satisfies Principal[]) {
    expect((await fixture(principal).request('/api/kiosk/check-in', { method: 'POST', headers })).status).toBe(403);
  }
});

it('ignores forwarded host and protocol headers when deciding the origin', async () => {
  expect((await fixture().request('http://internal/api/action', { method: 'POST', headers: {
    cookie: 'session=x', origin: 'https://evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https',
  } })).status).toBe(403);
});
