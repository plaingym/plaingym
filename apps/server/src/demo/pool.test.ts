// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { gyms, gymDomains, kioskDevices } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { demoCreationResponse } from '@plaingym/shared/contracts';
import { createGymDeleteService } from '../areas/settings/gym-delete.js';
import { TestClock } from '../core/clock.js';
import type { GymContext } from '../core/context.js';
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
  const seed = vi.fn(async (_context: GymContext) => {});
  const removeUploads = vi.fn(async (_gymId: string) => {});
  const service = createDemoService({ config, key, clock, identities, seed, scope: db.forGym, system: db.forSystem,
    deletion: createGymDeleteService({ clock, scope: db.forGym, system: db.forSystem, removeUploads }) });
  const makePool = () => createDemoPool({ config, key, clock, service, scope: db.forGym, system: db.forSystem });
  const pool = makePool();
  return { config, clock, service, pool, makePool, seed, identities, removeUploads };
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
  const first = await create(f, 'student', '/portal/schedule');
  await f.pool.refill(); const second = await create(f);
  await expect(f.pool.handoff(second.gymId, first.handoffToken, '192.0.2.1')).rejects.toMatchObject({ code: 'not_found' });
  const result = await f.pool.handoff(first.gymId, first.handoffToken, '192.0.2.1');
  expect(result.redirect).toBe('/portal/schedule');
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

it('discards a seed that committed partial rows and moves the waiting ticket to a fresh gym', async () => {
  const f = fixture(); const pending = await f.pool.request({ role: 'coach', page: '/admin/schedule' });
  if (!('pending' in pending)) throw new Error('Expected queue');
  let failedId = '';
  f.seed.mockImplementationOnce(async context => {
    failedId = context.gymId;
    await db.forGym(context.gymId, tx => tx.insert(kioskDevices).values({ gymId: context.gymId, name: 'Partial seed', tokenHash: 'seed-test-partial' }));
    throw new Error('Interrupted seed');
  });
  await expect(f.pool.refill()).rejects.toThrow('Interrupted seed');
  expect(await db.forGym(failedId, tx => tx.select().from(kioskDevices).where(eq(kioskDevices.name, 'Partial seed')))).toHaveLength(1);
  await f.makePool().refill();
  const complete = await f.pool.progress(pending.ticket);
  expect(complete).toHaveProperty('gymId');
  expect(complete).not.toMatchObject({ gymId: failedId });
  expect((await rows()).some(gym => gym.id === failedId)).toBe(false);
  expect(f.seed.mock.calls.filter(([context]) => context.gymId === failedId)).toHaveLength(1);
});

it('recovers readiness committed before allocation', async () => {
  const f = fixture(); const pending = await f.pool.request({ role: 'coach', page: '/admin/schedule' });
  if (!('pending' in pending)) throw new Error('Expected queue');
  const before = (await rows()).find(gym => sandboxSettings(gym.settings)?.kind === 'queued')!;
  await f.service.prepare(before.id);
  await f.makePool().refill();
  const complete = await f.pool.progress(pending.ticket);
  expect(complete).toMatchObject({ gymId: before.id });
  expect((await rows()).filter(gym => sandboxSettings(gym.settings)?.kind === 'private')).toHaveLength(1);
});

it('does not retry a seed whose lease ended without a readiness commit', async () => {
  const f = fixture();
  const reservation = await f.service.reserve('pool');
  await db.forGym(reservation.gymId, tx => tx.update(gyms).set({ settings: { demo: { sandbox: true, ready: false, kind: 'pool', seedStartedAt: f.clock.now().toISOString(), expiresAt: reservation.expiresAt } } }).where(eq(gyms.id, reservation.gymId)));
  await f.makePool().refill();
  expect((await rows()).some(gym => gym.id === reservation.gymId)).toBe(false);
  expect(f.seed.mock.calls.some(([context]) => context.gymId === reservation.gymId)).toBe(false);
  expect(await f.pool.showcase()).toContain('https://showcase.');
});

it('keeps a queued ticket in a durable recovery job if replacement fails after deleting partial data', async () => {
  const f = fixture(), pending = await f.pool.request({ role: 'student', page: '/portal/schedule' });
  if (!('pending' in pending)) throw new Error('Expected queue');
  f.seed.mockRejectedValueOnce(new Error('Partial seed failure'));
  await expect(f.pool.refill()).rejects.toThrow('Partial seed failure');
  const failed = (await rows()).find(gym => sandboxSettings(gym.settings)?.kind === 'queued')!;
  const queue = new PostgresJobs({ database: { forGym: db.forGym, forSystem: db.forSystem }, clock: f.clock });
  registerDemoCleanup(queue, { ...f, system: db.forSystem });
  vi.spyOn(f.service, 'reserve').mockRejectedValueOnce(new Error('Interrupted after deletion'));
  await f.pool.refill();
  expect((await rows()).some(gym => gym.id === failed.id)).toBe(false);
  // A new worker still has the recovery payload even though the original reservation is gone.
  const restarted = new PostgresJobs({ database: { forGym: db.forGym, forSystem: db.forSystem }, clock: f.clock });
  registerDemoCleanup(restarted, { ...f, pool: f.makePool(), system: db.forSystem });
  expect(await restarted.runNext()).toBe(true);
  const replacement = (await rows()).find(gym => sandboxSettings(gym.settings)?.replacementFor === failed.id)!;
  // Simulate losing the process after bootstrap, before the ticket/kiosk initialization transaction.
  await db.forGym(replacement.id, tx => tx.update(gyms).set({ settings: { bootstrapOwnerEmail: `demo-replacement.${failed.id}@example.invalid` } }).where(eq(gyms.id, replacement.id)));
  await f.pool.recoverSeed({ gymId: failed.id, demo: sandboxSettings(failed.settings)! });
  await f.pool.refill();
  const complete = await f.pool.progress(pending.ticket);
  expect(complete).toMatchObject({ gymId: replacement.id });
  await f.pool.recoverSeed({ gymId: failed.id, demo: sandboxSettings(failed.settings)! });
  expect((await rows()).filter(gym => sandboxSettings(gym.settings)?.ticketHash === sandboxSettings(failed.settings)?.ticketHash)).toHaveLength(1);
});

it('continues refill and expiry cleanup past an undeletable stale gym', async () => {
  const f = fixture();
  const stale = await f.service.reserve('pool');
  f.removeUploads.mockImplementation(async gymId => { if (gymId === stale.gymId) throw new Error('Storage unavailable'); });
  f.clock.advance(86_400_000);
  await f.pool.refill();
  expect((await rows()).find(gym => gym.id === stale.gymId)?.status).toBe('suspended');
  const copy = await create(f);
  f.clock.advance(7_200_000);
  const queue = new PostgresJobs({ database: { forGym: db.forGym, forSystem: db.forSystem }, clock: f.clock });
  registerDemoCleanup(queue, { ...f, system: db.forSystem });
  await queue.enqueueSystem('demo.expire', {}, { timezone: 'UTC' });
  await queue.runNext();
  expect((await rows()).some(gym => gym.id === copy.gymId)).toBe(false);
  await f.pool.refill();
  expect(await create(f)).toHaveProperty('gymId');
});

it('keeps an overdue showcase serving when private copies fill the cap', async () => {
  const f = fixture(); f.config.maxSandboxes = 2;
  await f.pool.refill();
  const shared = (await rows()).find(gym => sandboxSettings(gym.settings)?.kind === 'showcase')!;
  await create(f);
  // Keep the private allocation within its own 24-hour lifetime at the showcase deadline.
  f.clock.advance(1);
  const copy = (await rows()).find(gym => sandboxSettings(gym.settings)?.kind === 'private')!;
  await db.forGym(copy.id, tx => tx.update(gyms).set({ settings: { demo: { ...sandboxSettings(copy.settings)!, expiresAt: '2026-11-15T12:00:00.001Z' } } }).where(eq(gyms.id, copy.id)));
  f.clock.advance(86_399_999);
  await f.pool.refill();
  expect(await f.pool.showcase()).toContain(f.service.kioskTokenFor(shared.id));
  await expect(f.service.live(shared.id)).resolves.toHaveProperty('expiresAt');
  await expect(f.service.login(shared.id, { role: 'owner' }, '192.0.2.1')).resolves.toBeInstanceOf(Response);
  expect(await rows()).toHaveLength(2);
  f.clock.advance(1); await f.pool.refill();
  expect(await f.pool.showcase()).not.toContain(f.service.kioskTokenFor(shared.id));
});

it('measures the daily replacement from promotion rather than the pool seed time', async () => {
  const f = fixture(); await f.pool.refill();
  f.clock.advance(20 * 3_600_000);
  const old = (await rows()).find(gym => sandboxSettings(gym.settings)?.kind === 'showcase')!;
  await db.forGym(old.id, tx => tx.delete(gyms).where(eq(gyms.id, old.id)));
  await f.pool.refill();
  const promoted = (await rows()).find(gym => sandboxSettings(gym.settings)?.kind === 'showcase')!;
  expect(sandboxSettings(promoted.settings)?.promotedAt).toBe(f.clock.now().toISOString());
  f.clock.advance(4 * 3_600_000); await f.pool.refill();
  expect(await f.pool.showcase()).toContain(f.service.kioskTokenFor(promoted.id));
  f.clock.advance(20 * 3_600_000); await f.pool.refill();
  expect(await f.pool.showcase()).not.toContain(f.service.kioskTokenFor(promoted.id));
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
