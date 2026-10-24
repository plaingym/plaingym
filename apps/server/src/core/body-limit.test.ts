// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { TestClock } from './clock.js';
import { defaultBodyLimits } from './body-limit.js';

function fixture() {
  let reached = 0;
  const app = createApp({ clock: new TestClock('2026-01-01T00:00:00Z'),
    resolveGym: async (context, next) => {
      context.set('context', { ...context.get('context'), gym: { gymId: 'gym', timezone: 'UTC', enabledModules: new Set() } });
      await next();
    },
    // Stands in for the auth dispatch, which parses the body itself.
    session: async (context, next) => {
      if (context.req.path.startsWith('/api/auth/')) { reached++; return context.json({ bytes: (await context.req.arrayBuffer()).byteLength }); }
      await next();
    },
    authorize: () => async (_context, next) => { await next(); },
    rateLimit: { peerAddress: () => '127.0.0.1' },
  });
  app.post('/api/imports/uploads', async (context) => context.json({ bytes: (await context.req.arrayBuffer()).byteLength }));
  app.post('/api/members', async (context) => context.json({ bytes: (await context.req.arrayBuffer()).byteLength }));
  return { app, reached: () => reached };
}
const post = (app: ReturnType<typeof fixture>['app'], path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
/** A chunked body that counts how much of it the server pulled. */
function chunked(chunks: number, size: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (pulled >= chunks) { controller.close(); return; }
    pulled++; controller.enqueue(new Uint8Array(size));
  } });
  return { body, pulled: () => pulled };
}

it('refuses an oversized login body before the auth handler reads it', async () => {
  const { app, reached } = fixture();
  const response = await post(app, '/api/auth/sign-in/email', 'x'.repeat(64 * 1024 + 1));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  expect(reached()).toBe(0);
  expect((await post(app, '/api/auth/sign-in/email', '{"email":"a@example.test"}')).status).toBe(200);
  expect(reached()).toBe(1);
});
it('stops reading a chunked body at the limit', async () => {
  const { app, reached } = fixture();
  const stream = chunked(1000, 16 * 1024);
  const response = await app.request('/api/auth/sign-in/email', { method: 'POST', body: stream.body, duplex: 'half' } as RequestInit);
  expect(response.status).toBe(400);
  expect(stream.pulled()).toBeLessThan(10);
  expect(reached()).toBe(0);
});
it('applies the default cap elsewhere and the CSV cap to uploads only', async () => {
  const { app } = fixture();
  const twoMegabytes = new Uint8Array(2 * 1024 * 1024);
  expect((await post(app, '/api/members', twoMegabytes)).status).toBe(400);
  expect((await post(app, '/api/members', new Uint8Array(defaultBodyLimits.default))).status).toBe(200);
  expect(await (await post(app, '/api/imports/uploads', twoMegabytes)).json()).toEqual({ bytes: twoMegabytes.length });
  expect((await post(app, '/api/imports/uploads', new Uint8Array(defaultBodyLimits.routes['/api/imports/uploads']! + 1))).status).toBe(400);
});
