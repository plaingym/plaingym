// SPDX-License-Identifier: AGPL-3.0-only
import { forGym, uuidv7, RevisionConflictError } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { staffContracts } from '@plaingym/shared/contracts';
import type { Uploads } from '../../infra/storage/index.js';
import { route } from '../../core/registry.js';
import { assertStaffManager, createStaffProfileService, type StaffActor } from './profiles.js';
import { validatePhoto } from '../members/photos.js';

export function createStaffPhotoService(uploadsFor: (gymId: string) => Promise<Uploads>, scope = forGym) {
  const profiles = createStaffProfileService(scope);
  return {
    async upload(actor: StaffActor, id: string, revision: number, bytes: Uint8Array, contentType: string) {
      await scope(actor.gymId, (tx) => assertStaffManager(tx, actor.actorUserId));
      const before = (await profiles.getProfile(actor.gymId, id)).data;
      if (before.revision !== revision) throw new RevisionConflictError();
      validatePhoto(bytes, contentType);
      const key = `${actor.gymId}/staff/${id}/${uuidv7()}`, store = await uploadsFor(actor.gymId);
      await store.put(key, bytes, contentType);
      let saved;
      try { saved = await profiles.attachPhoto(actor, id, revision, key); }
      catch (error) { await store.markDeleted(key); throw error; }
      if (before.photoKey) await store.markDeleted(before.photoKey);
      return saved;
    },
    async read(actor: StaffActor, id: string) {
      await scope(actor.gymId, (tx) => assertStaffManager(tx, actor.actorUserId));
      const profile = (await profiles.getProfile(actor.gymId, id)).data;
      if (!profile.photoKey) throw new AppError('not_found', 'Photo not found');
      const store = await uploadsFor(actor.gymId), info = await store.head(profile.photoKey);
      if (!info || info.deletedAt || !['image/png', 'image/jpeg', 'image/webp'].includes(info.contentType)) throw new AppError('not_found', 'Photo not found');
      const body = await store.get(profile.photoKey);
      if (!body) throw new AppError('not_found', 'Photo not found');
      return { body, contentType: info.contentType };
    },
    async update(actor: StaffActor, id: string, input: Parameters<typeof profiles.updateProfile>[2]) {
      const before = (await profiles.getProfile(actor.gymId, id)).data;
      const saved = await profiles.updateProfile(actor, id, input);
      if (before.photoKey && saved.data.photoKey === null) await (await uploadsFor(actor.gymId)).markDeleted(before.photoKey);
      return saved;
    },
  };
}
export type StaffPhotoService = ReturnType<typeof createStaffPhotoService>;
export function createStaffPhotoRoutes(service: StaffPhotoService | (() => StaffPhotoService)) {
  const current = () => typeof service === 'function' ? service() : service;
  const upload = staffContracts.uploadPhoto, { permission } = upload;
  return [route({ ...upload,
    middleware: bodyLimit({ maxSize: 720_000, onError: () => { throw new AppError('invalid_request', 'Request too large'); } }),
    request: { params: upload.params, body: { required: true, content: { 'application/json': { schema: upload.body } } } },
    responses: { 200: { description: 'Staff photo uploaded', content: { 'application/json': { schema: upload.response } } } },
  }, async (c) => {
    const { principal, gym, clock } = c.get('context');
    if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Gym not found');
    const input = c.req.valid('json');
    c.header('Cache-Control', 'no-store');
    return c.json(await current().upload({ gymId: gym.gymId, actorUserId: principal.userId, clock }, c.req.valid('param').staffProfileId,
      input.revision, Buffer.from(input.base64, 'base64'), input.contentType), 200);
  }), route({ method: 'get', path: '/api/staff/profiles/{staffProfileId}/photo', permission, request: { params: upload.params },
    responses: { 200: { description: 'Staff photo', content: { 'image/jpeg': { schema: z.string().openapi({ format: 'binary' }) } } } },
  }, async (c) => {
    const { principal, gym, clock } = c.get('context');
    if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Gym not found');
    const photo = await current().read({ gymId: gym.gymId, actorUserId: principal.userId, clock }, c.req.valid('param').staffProfileId);
    return c.body(photo.body, 200, { 'Content-Type': photo.contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  })];
}
