// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { intakeRateLimits, uuidv7 } from '@plaingym/db';
import { eq } from 'drizzle-orm';
import { createApp } from './app.js';
import { TestClock } from './clock.js';
import { rateLimit } from './rate-limit.js';
import { createIntakeRateLimitStore, registerIntakeRateLimits } from './rate-limit-store.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { createPublicRoutes } from '../public/pages/pages.routes.js';
import { createJoinRoutes } from '../public/pages/join.routes.js';
import type { RouteRegistration } from './registry.js';

const db = useTestDatabase(), factory = createFactories(db);
let reset: (() => void) | undefined;
afterEach(() => { reset?.(); reset = undefined; });
async function fixture() {
  const gymId = uuidv7(), otherGym = uuidv7(), clock = new TestClock('2026-11-05T12:00:00Z');
  await factory('gyms', gymId); await factory('gyms', otherGym);
  const make = (shared = true, routes: readonly RouteRegistration[] = []) => {
    const app = createApp({ clock, rateLimit: { limit: 1000 }, contributions: { routes },
      resolveGym: async (c, next) => {
        c.set('context', { ...c.get('context'), gym: { gymId: c.req.header('test-gym') ?? gymId, timezone: 'UTC', enabledModules: new Set() },
          clientIp: c.req.header('test-ip') ?? '192.0.2.1' });
        await next();
      },
      session: async (_c, next) => { await next(); }, authorize: () => async (_c, next) => { await next(); },
    });
    app.post('/api/intake', rateLimit({ sharedKey: 'test.intake', limit: 2, windowMs: 2000,
      ...(shared ? { sharedStore: createIntakeRateLimitStore(db.forSystem) } : {}) }), async c => {
      await c.req.json(); return c.json({ ok: true });
    });
    return app;
  };
  const request = (app: ReturnType<typeof make>, headers: Record<string, string> = {}, body = '{}') =>
    app.request('/api/intake', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { gymId, otherGym, clock, make, request };
}

it('two independent limiter instances atomically share one budget and reject before parsing', async () => {
  const f = await fixture(), first = f.make(), second = f.make();
  const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => f.request(i % 2 ? first : second)));
  expect(replies.filter(r => r.status === 200)).toHaveLength(2);
  expect(replies.filter(r => r.status === 429)).toHaveLength(10);
  const denied = await f.request(f.make(), {}, '{invalid json');
  expect(denied.status).toBe(429);
  expect(denied.headers.get('retry-after')).toBe('2');
  expect(await denied.json()).toMatchObject({ error: { code: 'rate_limited' } });
  const rows = await db.forSystem(tx => tx.select().from(intakeRateLimits).where(eq(intakeRateLimits.gymId, f.gymId)));
  expect(rows).toHaveLength(1); expect(rows[0]!.count).toBe(3);
});

it('isolates gyms, clients and route budgets and resets at the fixed window boundary', async () => {
  const f = await fixture(), app = f.make();
  await f.request(app); await f.request(app);
  expect((await f.request(app)).status).toBe(429);
  expect((await f.request(app, { 'test-gym': f.otherGym })).status).toBe(200);
  expect((await f.request(app, { 'test-ip': '192.0.2.2' })).status).toBe(200);
  expect(await createIntakeRateLimitStore(db.forSystem).consume({ gymId: f.gymId, routeKey: 'other', clientKey: '192.0.2.1',
    now: f.clock.now().getTime(), windowMs: 2000, limit: 2 })).toMatchObject({ allowed: true });
  f.clock.advance(1999); expect((await f.request(app)).status).toBe(429);
  f.clock.advance(1); expect((await f.request(app)).status).toBe(200);
});

it('groups IPv6 clients by /64 across limiter instances', async () => {
  const f = await fixture();
  expect((await f.request(f.make(), { 'test-ip': '2001:db8:a:b::1' })).status).toBe(200);
  expect((await f.request(f.make(), { 'test-ip': '2001:DB8:A:B::2' })).status).toBe(200);
  expect((await f.request(f.make(), { 'test-ip': '2001:db8:a:b:ffff::3' })).status).toBe(429);
  expect((await f.request(f.make(), { 'test-ip': '2001:db8:a:c::1' })).status).toBe(200);
});

it('public route factories use the registered shared store before their validators and body readers', async () => {
  const f = await fixture();
  reset = registerIntakeRateLimits(new PostgresJobs({ database: db, clock: f.clock }), f.clock, db.forSystem).reset;
  const store = createIntakeRateLimitStore(db.forSystem);
  for (const [routeKey, limit, windowMs] of [
    ['public.submissions', 10, 900_000], ['public.admissions', 10, 900_000],
    ['join.submissions', 10, 900_000], ['join.admissions', 10, 900_000], ['join.steps', 30, 900_000],
  ] as const) {
    for (let i = 0; i < limit; i++) await store.consume({ gymId: f.gymId, routeKey, clientKey: '192.0.2.1',
      now: f.clock.now().getTime(), limit, windowMs });
  }
  const allRoutes = [...createPublicRoutes(), ...createJoinRoutes()];
  const limited = allRoutes.filter(r => r.definition.middleware !== undefined);
  const documentPath = '/api/public/waivers/{templateId}/document';
  const intake = limited.filter(r => r.definition.path !== documentPath);
  expect(intake).toHaveLength(11);
  expect(limited.filter(r => r.definition.path === documentPath)).toHaveLength(1);
  const app = f.make(false, allRoutes);
  for (const route of intake) {
    const response = await app.request(route.definition.path.replace(/\{[^}]+\}/g, 'invalid'), {
      method: route.definition.method.toUpperCase(),
      ...(route.definition.method === 'get' ? {} : { headers: { 'content-type': 'application/json', 'content-length': '13' }, body: '{invalid json' }),
    });
    expect(response.status, route.id).toBe(429);
  }
  // Document reads have their own ten-per-client-per-minute download limit. An exhausted intake
  // budget must not deny them; after ten attempts their own limiter precedes validation.
  const buckets = () => db.forSystem(tx => tx.select().from(intakeRateLimits).where(eq(intakeRateLimits.gymId, f.gymId)));
  const before = await buckets();
  for (let attempt = 0; attempt < 10; attempt++) {
    expect((await app.request('/api/public/waivers/invalid/document')).status).toBe(400);
  }
  const denied = await app.request('/api/public/waivers/invalid/document');
  expect(denied.status).toBe(429);
  expect(denied.headers.get('retry-after')).toBe('60');
  expect((await app.request('/api/public/waivers/invalid/document', { headers: { 'test-ip': '192.0.2.2' } })).status).toBe(400);
  expect(await buckets()).toEqual(before);
});

it('shares install-level buckets when no gym exists', async () => {
  const input = { gymId: null, routeKey: uuidv7(), clientKey: 'unknown', now: 0, windowMs: 1000, limit: 1 };
  expect((await createIntakeRateLimitStore(db.forSystem).consume(input)).allowed).toBe(true);
  expect((await createIntakeRateLimitStore(db.forSystem).consume(input)).allowed).toBe(false);
});

it('fails closed on a rejected upsert but propagates a database outage', async () => {
  // Nonexistent FK makes the upsert fail while the connectivity probe succeeds on real PostgreSQL.
  const input = { gymId: uuidv7(), routeKey: 'test', clientKey: 'unknown', now: 0, windowMs: 1000, limit: 1 };
  expect((await createIntakeRateLimitStore(db.forSystem).consume(input)).allowed).toBe(false);
  const outage = new Error('database unavailable'), scope = vi.fn(async (): Promise<never> => { throw outage; });
  await expect(createIntakeRateLimitStore(scope).consume(input)).rejects.toBe(outage);
  expect(scope).toHaveBeenCalledTimes(2);
});

it('registers shared counting and one daily sweep for the install, retaining live windows', async () => {
  const f = await fixture(), jobs = new PostgresJobs({ database: db, clock: f.clock });
  const registered = registerIntakeRateLimits(jobs, f.clock, db.forSystem);
  reset = registered.reset;
  await f.request(f.make(false)); await f.request(f.make(false));
  expect((await f.request(f.make(false))).status).toBe(429);
  const installBudget = uuidv7();
  await createIntakeRateLimitStore(db.forSystem).consume({ gymId: null, routeKey: installBudget, clientKey: 'unknown',
    now: f.clock.now().getTime(), windowMs: 2000, limit: 1 });
  f.clock.advance(2001); await f.request(f.make(false));
  await registered.scheduleDue(); await registered.scheduleDue();
  expect(await jobs.runNext()).toBe(true);
  expect(await jobs.runNext()).toBe(false);
  const rows = await db.forSystem(tx => tx.select().from(intakeRateLimits).where(eq(intakeRateLimits.gymId, f.gymId)));
  expect(rows).toHaveLength(1); expect(rows[0]!.count).toBe(1);
  expect(await db.forSystem(tx => tx.select().from(intakeRateLimits).where(eq(intakeRateLimits.routeKey, installBudget)))).toEqual([]);
  expect(await db.forGym(f.gymId, tx => tx.select().from(intakeRateLimits))).toEqual([]);
  expect(await db.app.db.select().from(intakeRateLimits)).toEqual([]);
});
