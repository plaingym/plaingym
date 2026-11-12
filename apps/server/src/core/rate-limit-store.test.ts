// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { intakeRateLimits, uuidv7 } from '@plaingym/db';
import { eq } from 'drizzle-orm';
import { createApp } from './app.js';
import { TestClock } from './clock.js';
import { cacheRefusals, rateLimit, type SharedRateLimitStore } from './rate-limit.js';
import { createIntakeRateLimitStore, registerIntakeRateLimits, sweepIntakeRateLimits } from './rate-limit-store.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { createPublicRoutes } from '../public/pages/pages.routes.js';
import { documentReadBudget } from '../areas/waivers/document-read.js';
import { createJoinRoutes } from '../public/pages/join.routes.js';
import { createLinkRoutes } from '../public/links/links.routes.js';
import { createPortalInvitationRoutes } from '../areas/portal/access.routes.js';
import { createStaffInvitationRoutes } from '../areas/staff/profiles.routes.js';
import { createDemoRoutes } from '../demo/demo.routes.js';
import { demoLoginRateLimit } from '../demo/identities.js';
import type { DemoService } from '../demo/service.js';
import { demoContracts, portalAccessContracts, staffInvitationContracts } from '@plaingym/shared/contracts';
import type { RouteRegistration } from './registry.js';

const db = useTestDatabase(), factory = createFactories(db);
let reset: (() => void) | undefined;
afterEach(() => { reset?.(); reset = undefined; });
async function fixture() {
  const gymId = uuidv7(), otherGym = uuidv7(), clock = new TestClock('2026-11-05T12:00:00Z');
  await factory('gyms', gymId); await factory('gyms', otherGym);
  const make = (shared = true, routes: readonly RouteRegistration[] = [], store?: SharedRateLimitStore) => {
    const app = createApp({ clock, rateLimit: { limit: 1000 }, contributions: { routes },
      resolveGym: async (c, next) => {
        c.set('context', { ...c.get('context'), gym: { gymId: c.req.header('test-gym') ?? gymId, timezone: 'UTC', enabledModules: new Set() },
          clientIp: c.req.header('test-ip') ?? '192.0.2.1' });
        await next();
      },
      session: async (_c, next) => { await next(); }, authorize: () => async (_c, next) => { await next(); },
    });
    app.post('/api/intake', rateLimit({ sharedKey: 'test.intake', limit: 2, windowMs: 2000,
      ...(shared ? { sharedStore: store ?? createIntakeRateLimitStore(db.forSystem) } : {}) }), async c => {
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
  // Document reads have their own budget for a shared address. An exhausted intake
  // budget must not deny them; their own limiter still precedes validation.
  const buckets = () => db.forSystem(tx => tx.select().from(intakeRateLimits).where(eq(intakeRateLimits.gymId, f.gymId)));
  const before = await buckets();
  for (let attempt = 0; attempt < documentReadBudget; attempt++) {
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

it('fails closed on a rejected upsert and reports it, but propagates a database outage', async () => {
  // Nonexistent FK makes the upsert fail while the connectivity probe succeeds on real PostgreSQL.
  const input = { gymId: uuidv7(), routeKey: 'test', clientKey: 'unknown', now: 0, windowMs: 1000, limit: 1 };
  const report = vi.fn(), failing = createIntakeRateLimitStore(db.forSystem, report);
  expect(await failing.consume(input)).toEqual({ allowed: false, resetAt: 1000, failed: true });
  expect(report).toHaveBeenCalledTimes(1); expect(report.mock.calls[0]![0]).toBeInstanceOf(Error);
  // At most one report a minute per store, however often the write fails.
  await failing.consume({ ...input, now: 59_999 }); expect(report).toHaveBeenCalledTimes(1);
  await failing.consume({ ...input, now: 60_000 }); expect(report).toHaveBeenCalledTimes(2);
  report.mockClear();
  // A report that throws doesn't change the answer.
  expect((await createIntakeRateLimitStore(db.forSystem, () => { throw new Error('sink down'); }).consume(input)).allowed).toBe(false);
  const outage = new Error('database unavailable'), scope = vi.fn(async (): Promise<never> => { throw outage; });
  await expect(createIntakeRateLimitStore(scope, report).consume(input)).rejects.toBe(outage);
  expect(scope).toHaveBeenCalledTimes(2); expect(report).not.toHaveBeenCalled();
});

it('remembers a refused budget until its window ends instead of asking the store again', async () => {
  const f = await fixture(), real = createIntakeRateLimitStore(db.forSystem);
  const consume = vi.fn((input: Parameters<SharedRateLimitStore['consume']>[0]) => real.consume(input));
  const app = f.make(true, [], cacheRefusals({ consume }));
  expect((await f.request(app)).status).toBe(200); expect((await f.request(app)).status).toBe(200);
  expect((await f.request(app)).status).toBe(429);
  expect(consume).toHaveBeenCalledTimes(3);
  f.clock.advance(500);
  for (let i = 0; i < 5; i++) {
    const refused = await f.request(app, {}, '{invalid json');
    expect(refused.status).toBe(429); expect(refused.headers.get('retry-after')).toBe('2');
  }
  expect(consume).toHaveBeenCalledTimes(3);
  // Another client, gym or budget still asks the store.
  expect((await f.request(app, { 'test-ip': '192.0.2.9' })).status).toBe(200);
  expect((await f.request(app, { 'test-gym': f.otherGym })).status).toBe(200);
  expect(consume).toHaveBeenCalledTimes(5);
  f.clock.advance(1500); expect((await f.request(app)).status).toBe(200);
  expect(consume).toHaveBeenCalledTimes(6);
});

it('remembers a refusal from a failed counter write for a second only', async () => {
  const f = await fixture();
  const consume = vi.fn(async () => ({ allowed: false, resetAt: f.clock.now().getTime() + 2000, failed: true }));
  const app = f.make(true, [], cacheRefusals({ consume }));
  expect((await f.request(app)).status).toBe(429); expect((await f.request(app)).status).toBe(429);
  expect(consume).toHaveBeenCalledTimes(1);
  f.clock.advance(1000); expect((await f.request(app)).status).toBe(429);
  expect(consume).toHaveBeenCalledTimes(2);
});

it('keeps refusals per budget size and drops the oldest when full', async () => {
  const consume = vi.fn(async ({ limit, now }: { limit: number; now: number }) => ({ allowed: limit > 5, resetAt: now + 1000 }));
  const cached = cacheRefusals({ consume }, 2), base = { gymId: null, routeKey: 'r', windowMs: 1000, now: 0 };
  expect((await cached.consume({ ...base, clientKey: 'a', limit: 1 })).allowed).toBe(false);
  // The same key at another size isn't answered by the stricter refusal.
  expect((await cached.consume({ ...base, clientKey: 'a', limit: 10 })).allowed).toBe(true);
  await cached.consume({ ...base, clientKey: 'b', limit: 1 }); await cached.consume({ ...base, clientKey: 'c', limit: 1 });
  expect(consume).toHaveBeenCalledTimes(4);
  // 'a' was the oldest and was dropped for 'c'; 'b' and 'c' are still answered from memory.
  await cached.consume({ ...base, clientKey: 'b', limit: 1 }); await cached.consume({ ...base, clientKey: 'c', limit: 1 });
  expect(consume).toHaveBeenCalledTimes(4);
  await cached.consume({ ...base, clientKey: 'a', limit: 1 });
  expect(consume).toHaveBeenCalledTimes(5);
});

it('sweeps ended windows in short batches and keeps live ones', async () => {
  const now = new Date('2026-11-05T12:00:00Z'), routeKey = uuidv7(), at = (offset: number) => new Date(now.getTime() + offset);
  await db.forSystem(tx => tx.insert(intakeRateLimits).values([
    ...Array.from({ length: 5 }, (_, i) => ({ gymId: null, routeKey, clientKey: `ended-${i}`, windowStart: at(-2000), expiresAt: at(-i), count: 1 })),
    { gymId: null, routeKey, clientKey: 'live', windowStart: now, expiresAt: at(1), count: 1 },
  ]));
  expect(await sweepIntakeRateLimits(now, db.forSystem, 2)).toBeGreaterThanOrEqual(5);
  const left = await db.forSystem(tx => tx.select().from(intakeRateLimits).where(eq(intakeRateLimits.routeKey, routeKey)));
  expect(left.map(row => row.clientKey)).toEqual(['live']);
});

it('public token routes count in the registered shared store before their validators', async () => {
  const f = await fixture();
  reset = registerIntakeRateLimits(new PostgresJobs({ database: db, clock: f.clock }), f.clock, db.forSystem).reset;
  const store = createIntakeRateLimitStore(db.forSystem);
  const app = f.make(false, [...createPortalInvitationRoutes(),
    ...createStaffInvitationRoutes(() => { throw new Error('not reached'); }, () => 'http://localhost')]);
  for (const [routeKey, path] of [['portal.invitation_accept', portalAccessContracts.claim.path],
    ['portal.claim_complete', portalAccessContracts.completeClaim.path],
    ['staff.invitation_accept', staffInvitationContracts.acceptInvitation.path]] as const) {
    const send = () => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid json' });
    expect((await send()).status, routeKey).toBe(400);
    for (let i = 0; i < 9; i++) await store.consume({ gymId: f.gymId, routeKey, clientKey: '192.0.2.1', now: f.clock.now().getTime(), limit: 10, windowMs: 60_000 });
    expect((await send()).status, routeKey).toBe(429);
    const [row] = await db.forSystem(tx => tx.select().from(intakeRateLimits).where(eq(intakeRateLimits.routeKey, routeKey)));
    expect(row, routeKey).toMatchObject({ gymId: f.gymId, clientKey: '192.0.2.1', count: 11 });
  }
});

it('demo creation, demo login and the onboarding claim use the shared store through their real mounts', async () => {
  const f = await fixture(), now = () => f.clock.now().getTime();
  reset = registerIntakeRateLimits(new PostgresJobs({ database: db, clock: f.clock }), f.clock, db.forSystem).reset;
  const store = createIntakeRateLimitStore(db.forSystem), unreached = async () => { throw new Error('not reached'); };
  const service = { create: unreached, status: unreached, live: unreached, login: unreached, expire: unreached, setJoinReadiness() {} } as unknown as DemoService;
  const links = { resolve: async () => ({ status: 'active', principal: { kind: 'signed_link', gymId: f.gymId, linkId: uuidv7(), purpose: 'onboarding' } }) };
  const app = f.make(false, [...createDemoRoutes(service, { installOrigin: 'http://localhost', enabled: true, tenancy: 'multi' }),
    ...createLinkRoutes({ links } as unknown as Parameters<typeof createLinkRoutes>[0])]);
  const malformed = { 'content-type': 'application/json', 'content-length': '13' }, body = '{invalid json';
  // Creation is mounted before gym resolution, so its budget is the install's, keyed by the socket address.
  for (let i = 0; i < 3; i++) await store.consume({ gymId: null, routeKey: 'demo.create', clientKey: 'unknown', now: now(), limit: 3, windowMs: 3_600_000 });
  expect((await app.request('http://localhost' + demoContracts.create.path, { method: 'POST', headers: { ...malformed, origin: 'http://localhost' }, body })).status).toBe(429);
  const { max, window } = demoLoginRateLimit;
  for (let i = 0; i < max; i++) await store.consume({ gymId: f.gymId, routeKey: 'demo.login', clientKey: '192.0.2.1', now: now(), limit: max, windowMs: window * 1000 });
  expect((await app.request(demoContracts.login.path, { method: 'POST', headers: malformed, body })).status).toBe(429);
  for (let i = 0; i < 10; i++) await store.consume({ gymId: f.gymId, routeKey: 'links.claim', clientKey: '192.0.2.1', now: now(), limit: 10, windowMs: 60_000 });
  expect((await app.request(portalAccessContracts.claimOnboarding.path, { method: 'POST',
    headers: { ...malformed, authorization: 'Bearer ' + 'a'.repeat(43) }, body })).status).toBe(429);
});

it('registers shared counting and one hourly sweep for the install, retaining live windows', async () => {
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
  // The next hour schedules its own run.
  f.clock.advance(60 * 60 * 1000); await registered.scheduleDue();
  expect(await jobs.runNext()).toBe(true);
  expect(await jobs.runNext()).toBe(false);
});
