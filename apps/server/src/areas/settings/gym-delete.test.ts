// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse } from '@plaingym/shared';
import { createServerRegistry } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { routes } from './gym-delete.routes.js';
import { createGymDeleteService } from './gym-delete.js';
import { createGymJobPolicy } from '../../core/tenancy-jobs.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { FakeUploads } from '../../infra/storage/index.js';

const database = useTestDatabase(), factory = createFactories(database);
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const gymId = '00000000-0000-7000-8000-000000000001';
// Only demo mode configures deletion; every other install keeps the route closed.
it('fails closed for an owner until demo mode configures gym deletion', async () => {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, clock: new TestClock('2026-10-22T12:00:00Z'),
      principal: { kind: 'staff', gymId, userId: '00000000-0000-7000-8000-000000000002', roles: ['owner'] }, requestId: 'test' });
    await next();
  });
  app.onError((error, c) => c.json(errorResponse(error, 'test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes }).mount(app, () => async (_c, next) => { await next(); }, () => new Set());
  const response = await app.request('/api/settings/gym', { method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 1, confirmation: 'DELETE' }) });
  expect(response.status).toBe(404);
});

it('waits for a running gym job to store its upload before removing the prefix and gym', async () => {
  const gym = await factory('gyms', uuidv7());
  const clock = new TestClock('2026-01-01T00:00:00Z'), uploads = new FakeUploads(gym.id, clock);
  const started = latch(), store = latch(), draining = latch();
  const queue = new PostgresJobs({ database, clock, eligibleGym: createGymJobPolicy({ system: database.forSystem }) });
  queue.handle('deletion.upload', async () => {
    started.resolve(); await store.promise;
    await uploads.put(`${gym.id}/late.pdf`, new Uint8Array([1, 2, 3]), 'application/pdf');
  });
  await queue.enqueue('deletion.upload', {}, { gymId: gym.id, timezone: 'UTC' });
  const running = queue.runNext(); await started.promise;
  let scopes = 0;
  const scope: typeof database.forGym = async (gymId, fn) => {
    const result = await database.forGym(gymId, fn);
    if (++scopes === 2) draining.resolve();
    return result;
  };
  const removeUploads = vi.fn(async () => {
    const objects = await uploads.list();
    expect(objects.map(object => object.key)).toEqual([`${gym.id}/late.pdf`]);
    for (const object of objects) await uploads.markDeleted(object.key);
    await uploads.sweep({ before: clock.now() });
  });
  const deletion = createGymDeleteService({ clock, scope, system: database.forSystem, removeUploads });
  const deleting = deletion.remove(gym.id, gym.revision);
  try {
    await draining.promise;
    expect(removeUploads).not.toHaveBeenCalled();
    expect((await database.forGym(gym.id, tx => tx.select().from(gyms)))[0]!.status).toBe('suspended');
  } finally { store.resolve(); await running; await deleting; }
  expect(removeUploads).toHaveBeenCalledOnce();
  expect(await uploads.list()).toEqual([]);
  expect(await database.forGym(gym.id, tx => tx.select().from(gyms))).toEqual([]);
});
