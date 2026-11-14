// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { uuidv7 } from '@plaingym/db';
import { TestClock } from '../core/clock.js';
import { errorHandler } from '../core/errors.js';
import type { RequestEnvironment } from '../core/context.js';
import { demoRequestGuard, showcaseReason } from './guard.js';
import type { DemoPool } from './pool.js';

const db = useTestDatabase(), factory = createFactories(db);
const writes = [
  ['POST', '/api/members'], ['PATCH', '/api/members/any'], ['DELETE', '/api/settings/gym'],
  ['POST', '/api/kiosk/lookup'], ['POST', '/api/kiosk/checkin'], ['POST', '/api/kiosk/checkin/qr'],
  ['POST', '/api/portal/bookings'], ['POST', '/api/billing/charges'],
  ['POST', '/api/auth/sign-in/magic-link'],
  ['POST', '/join'], ['POST', '/trial'], ['POST', '/drop-in'], ['POST', '/api/public/join'],
  ['POST', '/join/signatures'], ['POST', '/drop-in/signatures'], ['POST', '/api/public/trial'], ['POST', '/api/public/drop-in'],
  ['POST', '/api/links/pay-invoice/token/complete'], ['GET', '/l/token'], ['GET', '/api/links/unsubscribe/token'],
];
it('refuses every write route family before its handler on a showcase, and preserves private and ordinary gym behavior', async () => {
  for (const kind of ['showcase', 'private', undefined] as const) {
    const gymId = uuidv7(); await factory('gyms', gymId, { settings: kind ? { demo: { sandbox: true, ready: true, kind, expiresAt: '2026-12-01T00:00:00Z' } } : {} });
    let mutations = 0;
    const app = new OpenAPIHono<RequestEnvironment>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, principal: { kind: 'anonymous' }, requestId: 'guard-test', clock: new TestClock('2026-11-14T12:00:00Z') }); await next();
    });
    app.use('*', demoRequestGuard({ touch: async () => {} } as unknown as DemoPool, db.forGym));
    app.all('*', c => { mutations++; return c.json({ ok: true }); });
    for (const [method, path] of writes) {
      const response = await app.request(path!, { method: method! });
      expect(response.status, String(kind) + ': ' + path).toBe(kind === 'showcase' ? 403 : 200);
      if (kind === 'showcase') expect(await response.json()).toMatchObject({ error: { code: 'forbidden', details: { reason: [showcaseReason] } } });
    }
    expect(mutations).toBe(kind === 'showcase' ? 0 : writes.length);
    for (const path of ['/api/demo/login', '/api/auth/sign-out'])
      expect((await app.request(path, { method: 'POST' })).status).toBe(200);
    expect((await app.request('/api/members')).status).toBe(200);
  }
});

it('keeps the showcase readable after its replacement deadline while still refusing writes', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId, { settings: { demo: { sandbox: true, ready: true, kind: 'showcase', expiresAt: '2026-11-13T00:00:00Z' } } });
  const app = new OpenAPIHono<RequestEnvironment>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, principal: { kind: 'anonymous' }, requestId: 'guard-test', clock: new TestClock('2026-11-14T12:00:00Z') }); await next();
  });
  app.use('*', demoRequestGuard({ touch: async () => {} } as unknown as DemoPool, db.forGym));
  app.all('*', c => c.json({ ok: true }));
  expect((await app.request('/api/members')).status).toBe(200);
  expect((await app.request('/api/members', { method: 'POST' })).status).toBe(403);
});
