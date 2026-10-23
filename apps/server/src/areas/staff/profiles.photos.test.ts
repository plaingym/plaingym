// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { FakeUploads } from '../../infra/storage/index.js';
import { createStaffPhotoService, createStaffPhotoRoutes } from './profiles.photos.js';
import { createStaffProfileService } from './profiles.js';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import { authorize } from './auth.permissions.js';
import type { RequestEnvironment } from '../../core/context.js';
const db = useTestDatabase(), factory = createFactories(db), gymA = uuidv7(), gymB = uuidv7(), clock = new TestClock('2026-10-22Z');
const stores = new Map([[gymA, new FakeUploads(gymA, clock)], [gymB, new FakeUploads(gymB, clock)]]), users = new Map<StaffRole, string>();
const service = createStaffPhotoService(async (id) => stores.get(id)!, db.forGym), profiles = createStaffProfileService(db.forGym);
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 1]);
const actor = (role: StaffRole = 'owner') => ({ gymId: gymA, actorUserId: users.get(role)!, clock });
const body = (revision = 1) => ({ revision, base64: Buffer.from(jpeg).toString('base64'), contentType: 'image/jpeg' });
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); for (const role of staffRoles) users.set(role, (await factory('staffRoles', gymA, { role })).userId); });
function server(role: StaffRole = 'owner') {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => { c.set('context', { principal: { kind: 'staff', gymId: gymA, userId: users.get(role)!, roles: [role] }, gym: { gymId: gymA, timezone: 'UTC', enabledModules: new Set() }, clock, requestId: 'photo-test' }); await next(); });
  app.onError(errorHandler); createServerRegistry({ routes: createStaffPhotoRoutes(service) }).mount(app, authorize, new Set()); return app;
}
const post = (app: ReturnType<typeof server>, id: string, input: unknown) => app.request(`/api/staff/profiles/${id}/photo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
it.each(staffRoles)('allows only owners/admins to upload/read staff photos: %s', async (role) => {
  const profile = (await profiles.createProfile(actor(), { displayName: 'Photo ' + role })).data;
  await service.upload(actor(), profile.id, profile.revision, jpeg, 'image/jpeg');
  expect((await post(server(role), profile.id, body(2))).status).toBe(['owner', 'admin'].includes(role) ? 200 : 403);
  expect((await server(role).request(`/api/staff/profiles/${profile.id}/photo`)).status).toBe(['owner', 'admin'].includes(role) ? 200 : 403);
});
it('attaches immutable photo bytes to the profile, audits, and marks replaced/cleared objects deleted', async () => {
  const profile = (await profiles.createProfile(actor(), { displayName: 'Photo lifecycle' })).data;
  const first = (await service.upload(actor(), profile.id, 1, jpeg, 'image/jpeg')).data;
  expect(first.photoKey!.startsWith(`${gymA}/staff/${profile.id}/`)).toBe(true);
  const image = await service.read(actor(), profile.id);
  expect([...new Uint8Array(await new Response(image.body).arrayBuffer())]).toEqual([...jpeg]);
  const response = await server().request(`/api/staff/profiles/${profile.id}/photo`);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const second = (await service.upload(actor(), profile.id, 2, jpeg, 'image/jpeg')).data;
  expect(second.photoKey).not.toBe(first.photoKey);
  expect((await stores.get(gymA)!.head(first.photoKey!))!.deletedAt).not.toBeNull();
  await service.update(actor(), profile.id, { revision: 3, photoKey: null });
  expect((await stores.get(gymA)!.head(second.photoKey!))!.deletedAt).not.toBeNull();
  await expect(service.read(actor(), profile.id)).rejects.toMatchObject({ code: 'not_found' });
  const events = await db.forGym(gymA, (tx) => tx.select().from(auditEvents));
  expect(events.filter((row) => row.targetId === profile.id && row.action === 'staff.photo_uploaded')).toHaveLength(2);
});
it('rejects other gyms and unknown profile IDs before accessing storage', async () => {
  const foreign = await factory('staffProfiles', gymB), app = server();
  const getStore = vi.fn(async (id: string) => stores.get(id)!);
  const isolated = createStaffPhotoService(getStore, db.forGym);
  for (const id of [foreign.id, uuidv7()]) {
    expect((await post(app, id, body())).status).toBe(404);
    expect((await app.request(`/api/staff/profiles/${id}/photo`)).status).toBe(404);
    await expect(isolated.upload(actor(), id, 1, jpeg, 'image/jpeg')).rejects.toMatchObject({ code: 'not_found' });
    await expect(isolated.read(actor(), id)).rejects.toMatchObject({ code: 'not_found' });
  }
  expect(getStore).not.toHaveBeenCalled();
});
it('bounds and validates raster bytes, refuses stale revisions, and rejects arbitrary photo keys', async () => {
  const profile = (await profiles.createProfile(actor(), { displayName: 'Photo validation' })).data;
  await expect(service.upload(actor(), profile.id, 2, jpeg, 'image/jpeg')).rejects.toBeInstanceOf(Error);
  expect((await post(server(), profile.id, body(2))).status).toBe(409);
  for (const [bytes, type] of [[new TextEncoder().encode('<svg/>'), 'image/jpeg'], [jpeg, 'image/png'], [new Uint8Array(512 * 1024 + 1), 'image/jpeg']] as const)
    await expect(service.upload(actor(), profile.id, 1, bytes, type)).rejects.toMatchObject({ code: 'invalid_request' });
  expect((await post(server(), profile.id, { ...body(), base64: '!!!!' })).status).toBe(400);
  expect((await post(server(), profile.id, { ...body(), base64: 'A'.repeat(720_001) })).status).toBe(400);
  await expect(profiles.updateProfile(actor(), profile.id, { revision: 1, photoKey: gymA + '/staff/arbitrary' })).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(profiles.createProfile(actor(), { displayName: 'Bad', photoKey: gymA + '/members/stolen' })).rejects.toMatchObject({ code: 'invalid_request' });
});
it('marks the new upload deleted if a concurrent edit wins before attachment', async () => {
  const profile = (await profiles.createProfile(actor(), { displayName: 'Concurrent photo' })).data;
  const store = stores.get(gymA)!, put = store.put.bind(store);
  const putSpy = vi.spyOn(store, 'put').mockImplementationOnce(async (...args) => {
    const result = await put(...args);
    await profiles.updateProfile(actor(), profile.id, { revision: 1, bio: 'Won the race' });
    return result;
  });
  const interrupted = createStaffPhotoService(async () => store, db.forGym);
  await expect(interrupted.upload(actor(), profile.id, 1, jpeg, 'image/jpeg')).rejects.toBeInstanceOf(Error);
  putSpy.mockRestore();
  expect((await profiles.getProfile(gymA, profile.id)).data).toMatchObject({ revision: 2, photoKey: null, bio: 'Won the race' });
  const objects = await store.list(`${gymA}/staff/${profile.id}/`);
  expect(objects).toHaveLength(1); expect(objects[0]!.deletedAt).not.toBeNull();
});
