// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { announcementsContracts as contracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestContext } from '../../core/context.js';
import { announcementService, type AnnouncementsService } from './send.js';

function actor(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
    throw new AppError('forbidden', 'Staff access required');
  return { gymId: context.gym.gymId, userId: context.principal.userId };
}
export function createAnnouncementRoutes(read: () => AnnouncementsService = announcementService) {
  return [
    route({ ...contracts.preview, request: { body: { required: true, content: { 'application/json': { schema: contracts.preview.body } } } },
      responses: { 200: { description: 'Eligible recipients', content: { 'application/json': { schema: contracts.preview.response } } } } }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await read().preview(c.get('context').gym.gymId, c.req.valid('json')) }, 200);
    }),
    route({ ...contracts.test, request: { body: { required: true, content: { 'application/json': { schema: contracts.test.body } } } },
      responses: { 200: { description: 'Test delivered to sender', content: { 'application/json': { schema: contracts.test.response } } } } }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await read().test(actor(c.get('context')), c.req.valid('json')) }, 200);
    }),
    route({ ...contracts.send, request: { body: { required: true, content: { 'application/json': { schema: contracts.send.body } } } },
      responses: { 200: { description: 'Announcement queued', content: { 'application/json': { schema: contracts.send.response } } } } }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await read().send(actor(c.get('context')), c.req.valid('json')) }, 200);
    }),
    route({ ...contracts.list, request: { query: contracts.list.query },
      responses: { 200: { description: 'Announcement history', content: { 'application/json': { schema: contracts.list.response } } } } }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json(await read().list(c.get('context').gym.gymId, c.req.valid('query')), 200);
    }),
    route({ ...contracts.get, request: { params: contracts.get.params },
      responses: { 200: { description: 'Announcement progress', content: { 'application/json': { schema: contracts.get.response } } } } }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await read().get(c.get('context').gym.gymId, c.req.valid('param').announcementId) }, 200);
    }),
  ];
}
export const routes = createAnnouncementRoutes();
