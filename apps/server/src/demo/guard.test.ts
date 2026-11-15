// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { uuidv7 } from '@plaingym/db';
import { TestClock } from '../core/clock.js';
import { errorHandler } from '../core/errors.js';
import type { RequestEnvironment } from '../core/context.js';
import { demoRequestGuard, showcaseReason } from './guard.js';
import type { DemoPool } from './pool.js';
import { createDemoPool } from './pool.js';
import { createDemoService } from './service.js';
import { createGymDeleteService } from '../areas/settings/gym-delete.js';

const db = useTestDatabase(), factory = createFactories(db);
it('reads the gym once for guard, throttled touch and repeated liveness checks in one request', async () => {
  const clock = new TestClock('2026-11-14T12:00:00Z'), gymId = uuidv7();
  await factory('gyms', gymId, { settings: { demo: { sandbox: true, ready: true, kind: 'private',
    allocatedAt: clock.now().toISOString(), lastActivityAt: clock.now().toISOString(), expiresAt: '2026-11-14T14:00:00Z' } } });
  const reads = vi.fn();
  const scope: typeof db.forGym = (id, fn) => { reads(id); return db.forGym(id, fn); };
  const config = { enabled: true, domain: 'demo.example.test', maxSandboxes: 20 };
  const service = createDemoService({ config, key: Buffer.alloc(32, 17), clock, scope, system: db.forSystem,
    deletion: createGymDeleteService({ clock, scope: db.forGym, system: db.forSystem, removeUploads: async () => {} }),
    seed: async () => {}, identities: { seed: async () => {}, login: async () => new Response() } });
  const pool = createDemoPool({ config, key: Buffer.alloc(32, 17), clock, scope, system: db.forSystem, service });
  const app = new OpenAPIHono<RequestEnvironment>(); app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, principal: { kind: 'anonymous' }, requestId: 'cached-guard', clock });
    await next();
  });
  app.use('*', demoRequestGuard(pool, scope));
  app.get('/', async c => { await service.live(gymId); return c.json(await service.live(gymId)); });
  expect((await app.request('/')).status).toBe(200); expect(reads).toHaveBeenCalledTimes(1);
  // The snapshot ends with the request; a later service/job call must reload the row.
  await service.live(gymId); expect(reads).toHaveBeenCalledTimes(2);
});
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
