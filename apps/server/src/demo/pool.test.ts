// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { gyms, gymDomains } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { demoCreationResponse } from '@plaingym/shared/contracts';
import { createGymDeleteService } from '../areas/settings/gym-delete.js';
import { TestClock } from '../core/clock.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { createDemoService } from './service.js';
import { createDemoPool } from './pool.js';
import { sandboxSettings } from './config.js';
import { registerDemoCleanup } from './demo.jobs.js';

const db = useTestDatabase();
beforeEach(async () => { await db.forSystem(tx => tx.delete(gyms)); });
function fixture() {
  const config = { enabled: true, domain: 'demo.example.test', maxSandboxes: 20, poolSize: 1, idleHours: 2 };
  const clock = new TestClock('2026-11-14T12:00:00Z'), key = Buffer.alloc(32, 17);
  const identities = { seed: vi.fn(async () => {}), login: vi.fn(async () => new Response(null, { headers: { 'set-cookie': 'session=demo; Secure; HttpOnly' } })) };
  const seed = vi.fn(async () => {});
  const service = createDemoService({ config, key, clock, identities, seed, scope: db.forGym, system: db.forSystem,
    deletion: createGymDeleteService({ clock, scope: db.forGym, system: db.forSystem, removeUploads: async () => {} }) });
  const makePool = () => createDemoPool({ config, key, clock, service, scope: db.forGym, system: db.forSystem });
  const pool = makePool();
  return { config, clock, service, pool, makePool, seed, identities };
}
const rows = () => db.forSystem(tx => tx.select().from(gyms));
const create = async (f: ReturnType<typeof fixture>, role = 'owner', page = '/admin') => {
  const result = await f.pool.request({ role, page });
  if ('pending' in result) throw new Error('Expected a ready copy');
  return result;
};

it('keeps one showcase and a ready pool inside the cap; two processes cannot claim the same ready gym', async () => {
  const f = fixture(); await f.pool.refill();
  expect(await f.pool.showcase()).toContain('https://showcase.demo.example.test/demo#kioskToken=');
  const results = await Promise.all([f.pool.request({}), f.makePool().request({})]);
  expect(results.filter(value => 'pending' in value)).toHaveLength(1);
  expect(results.filter(value => 'gymId' in value)).toHaveLength(1);
  for (const result of results) expect(demoCreationResponse.safeParse({ data: result }).success).toBe(true);
  const pending = results.find(value => 'pending' in value)!;
  if (!('pending' in pending)) throw new Error('Missing ticket');
  expect(pending.position).toBe(1);
  await f.pool.refill();
  const ready = await f.makePool().progress(pending.ticket);
  expect(ready).toHaveProperty('gymId');
  expect((await rows()).filter(gym => sandboxSettings(gym.settings)?.kind === 'private')).toHaveLength(2);
  expect((await rows()).filter(gym => sandboxSettings(gym.settings)?.kind === 'pool')).toHaveLength(1);
});

it('a copy handoff is single-use, gym-bound and preserves its seeded role and allowlisted page', async () => {
  const f = fixture(); await f.pool.refill();
  const first = await create(f, 'student', '/portal/bookings');
  await f.pool.refill(); const second = await create(f);
  await expect(f.pool.handoff(second.gymId, first.handoffToken, '192.0.2.1')).rejects.toMatchObject({ code: 'not_found' });
  const result = await f.pool.handoff(first.gymId, first.handoffToken, '192.0.2.1');
  expect(result.redirect).toBe('/portal/bookings');
  expect(result.response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(f.identities.login).toHaveBeenLastCalledWith(first.gymId, { role: 'student' }, first.origin, '192.0.2.1');
  await expect(f.makePool().handoff(first.gymId, first.handoffToken, '192.0.2.1')).rejects.toMatchObject({ code: 'not_found' });
  await expect(f.pool.request({ role: 'owner', page: '//elsewhere.test' })).rejects.toThrow();
  await expect(f.pool.request({ role: 'owner', page: 'https://elsewhere.test' })).rejects.toThrow();
});

it('handoffs expire after ten minutes and unknown or expired queue tickets disclose nothing', async () => {
  const f = fixture(); await f.pool.refill(); const first = await create(f);
  f.clock.advance(600_000);
  await expect(f.pool.handoff(first.gymId, first.handoffToken, '192.0.2.1')).rejects.toMatchObject({ code: 'not_found' });
  await expect(f.pool.progress('a'.repeat(43))).rejects.toMatchObject({ code: 'not_found' });
});

it('starts idle expiry at hand-out, throttles persisted activity and never extends beyond 24 hours', async () => {
  const f = fixture(); await f.pool.refill();
  f.clock.advance(3_600_000); const first = await create(f);
  expect(first.expiresAt).toBe('2026-11-14T15:00:00.000Z');
  f.clock.advance(299_999); await f.pool.touch(first.gymId);
  expect((await f.service.live(first.gymId)).expiresAt).toBe(first.expiresAt);
  f.clock.advance(1); await f.pool.touch(first.gymId);
  expect((await f.service.live(first.gymId)).expiresAt).toBe('2026-11-14T15:05:00.000Z');
  for (let hour = 0; hour < 23; hour++) { f.clock.advance(3_600_000); await f.pool.touch(first.gymId); }
  expect((await f.service.live(first.gymId)).expiresAt).toBe('2026-11-15T13:00:00.000Z');
  f.clock.advance(3_600_000);
  await f.service.expire(first.gymId);
  expect((await rows()).some(gym => gym.id === first.gymId)).toBe(false);
});

it('resumes a reservation after a seed failure and after readiness commits before allocation', async () => {
  const f = fixture(); const pending = await f.pool.request({ role: 'coach', page: '/admin/schedule' });
  if (!('pending' in pending)) throw new Error('Expected queue');
  f.seed.mockRejectedValueOnce(new Error('Interrupted seed'));
  await expect(f.pool.refill()).rejects.toThrow('Interrupted seed');
  const before = (await rows()).find(gym => sandboxSettings(gym.settings)?.kind === 'queued')!;
  await f.service.prepare(before.id);
  await f.makePool().refill();
  const complete = await f.pool.progress(pending.ticket);
  expect(complete).toMatchObject({ gymId: before.id });
  expect((await rows()).filter(gym => sandboxSettings(gym.settings)?.kind === 'private')).toHaveLength(1);
});

it('swaps the fixed one-level showcase hostname daily and excludes pooled and shared gyms from jobs', async () => {
  const f = fixture(); await f.pool.refill();
  const first = (await rows()).find(gym => sandboxSettings(gym.settings)?.kind === 'showcase')!;
  expect(await f.pool.eligible(first.id)).toBe(false);
  const poolGym = (await rows()).find(gym => sandboxSettings(gym.settings)?.kind === 'pool')!;
  expect(await f.pool.eligible(poolGym.id)).toBe(false);
  f.clock.advance(86_400_000); await f.pool.refill();
  const domains = await db.forSystem(tx => tx.select().from(gymDomains).where(eq(gymDomains.hostname, f.pool.showcaseHostname)));
  expect(domains).toHaveLength(1); expect(domains[0]!.gymId).not.toBe(first.id);
  expect((await rows()).some(gym => gym.id === first.id)).toBe(false);
});

it('the install job lane runs only one seed across workers and skips queued showcase jobs', async () => {
  const f = fixture(); const database = { forGym: db.forGym, forSystem: db.forSystem };
  const a = new PostgresJobs({ database, clock: f.clock, eligibleGym: f.pool.eligible });
  const b = new PostgresJobs({ database, clock: f.clock, eligibleGym: f.pool.eligible });
  registerDemoCleanup(a, { ...f, pool: f.pool, system: db.forSystem });
  registerDemoCleanup(b, { ...f, pool: f.makePool(), system: db.forSystem });
  let release!: () => void;
  const entered = new Promise<void>(resolve => f.seed.mockImplementationOnce(async () => { resolve(); await new Promise<void>(done => { release = done; }); }));
  await a.enqueueSystem('demo.pool', {}, { timezone: 'UTC' });
  const running = a.runNext();
  await entered;
  try { expect(await b.runNext()).toBe(false); } finally { release(); }
  await running;
  const shared = (await rows()).find(gym => sandboxSettings(gym.settings)?.kind === 'showcase')!;
  const handler = vi.fn(async () => {}); a.handle('sample.change', handler);
  await a.enqueue('sample.change', {}, { gymId: shared.id, timezone: 'UTC' });
  await a.runNext(); expect(handler).not.toHaveBeenCalled();
});
