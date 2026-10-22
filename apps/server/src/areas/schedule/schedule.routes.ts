// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import { z } from '@hono/zod-openapi';
import { AppError } from '@plaingym/shared';
import { scheduleContracts as contracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { createScheduleService } from './schedule.js';

function mutation(c: Context<RequestEnvironment>) {
  const { gym, principal } = c.get('context');
  if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Schedule not found');
  return { gymId: gym.gymId, actor: { kind: 'user' as const, userId: principal.userId } };
}
const response = <S extends z.ZodType>(schema: S) => ({ 200: { description: 'Schedule', content: { 'application/json': { schema } } } });
const body = <S extends z.ZodType>(schema: S) => ({ required: true as const, content: { 'application/json': { schema } } });
// TODO(CCR): move the calendar picker response into the shared schedule contracts.
export const scheduleOptionsSchema = z.strictObject({ data: z.strictObject({
  timezone: z.string(), programs: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
  coaches: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
}) });
export function createScheduleRoutes(service = createScheduleService()) {
  return [
    route({ method: 'get', path: '/api/schedule/options', permission: contracts.listSessions.permission, responses: response(scheduleOptionsSchema) },
      async (c) => c.json({ data: await service.options(c.get('context').gym.gymId) }, 200)),
    route({ ...contracts.listTags, request: { query: contracts.listTags.query }, responses: response(contracts.listTags.response) },
      async (c) => c.json(await service.listTags(c.get('context').gym.gymId, c.req.valid('query')), 200)),
    route({ ...contracts.createTag, request: { body: body(contracts.createTag.body) }, responses: response(contracts.createTag.response) },
      async (c) => c.json({ data: await service.createTag(mutation(c), c.req.valid('json')) }, 200)),
    route({ ...contracts.updateTag, request: { params: contracts.updateTag.params, body: body(contracts.updateTag.body) }, responses: response(contracts.updateTag.response) },
      async (c) => c.json({ data: await service.updateTag(mutation(c), c.req.valid('param').id, c.req.valid('json')) }, 200)),
    route({ ...contracts.deleteTag, request: { params: contracts.deleteTag.params, body: body(contracts.deleteTag.body) }, responses: response(contracts.deleteTag.response) },
      async (c) => c.json({ data: await service.deleteTag(mutation(c), c.req.valid('param').id, c.req.valid('json')) }, 200)),
    route({ ...contracts.listTemplates, request: { query: contracts.listTemplates.query }, responses: response(contracts.listTemplates.response) },
      async (c) => c.json(await service.listTemplates(c.get('context').gym.gymId, c.req.valid('query')), 200)),
    route({ ...contracts.getTemplate, request: { params: contracts.getTemplate.params }, responses: response(contracts.getTemplate.response) },
      async (c) => c.json({ data: await service.getTemplate(c.get('context').gym.gymId, c.req.valid('param').id) }, 200)),
    route({ ...contracts.createTemplate, request: { body: body(contracts.createTemplate.body) }, responses: response(contracts.createTemplate.response) },
      async (c) => c.json({ data: await service.createTemplate(mutation(c), c.req.valid('json')) }, 200)),
    route({ ...contracts.updateTemplate, request: { params: contracts.updateTemplate.params, body: body(contracts.updateTemplate.body) }, responses: response(contracts.updateTemplate.response) },
      async (c) => c.json({ data: await service.updateTemplate(mutation(c), c.req.valid('param').id, c.req.valid('json')) }, 200)),
    route({ ...contracts.deleteTemplate, request: { params: contracts.deleteTemplate.params, body: body(contracts.deleteTemplate.body) }, responses: response(contracts.deleteTemplate.response) },
      async (c) => c.json({ data: await service.deleteTemplate(mutation(c), c.req.valid('param').id, c.req.valid('json')) }, 200)),
    route({ ...contracts.listSessions, request: { query: contracts.listSessions.query }, responses: response(contracts.listSessions.response) },
      async (c) => c.json(await service.listSessions(c.get('context').gym.gymId, c.req.valid('query')), 200)),
    route({ ...contracts.getSession, request: { params: contracts.getSession.params }, responses: response(contracts.getSession.response) },
      async (c) => c.json({ data: await service.getSession(c.get('context').gym.gymId, c.req.valid('param').id) }, 200)),
    route({ ...contracts.createSession, request: { body: body(contracts.createSession.body) }, responses: response(contracts.createSession.response) },
      async (c) => c.json({ data: await service.createSession(mutation(c), c.req.valid('json')) }, 200)),
    route({ ...contracts.updateSession, request: { params: contracts.updateSession.params, body: body(contracts.updateSession.body) }, responses: response(contracts.updateSession.response) },
      async (c) => c.json({ data: await service.updateSession(mutation(c), c.req.valid('param').id, c.req.valid('json')) }, 200)),
    route({ ...contracts.cancelSession, request: { params: contracts.cancelSession.params, body: body(contracts.cancelSession.body) }, responses: response(contracts.cancelSession.response) },
      async (c) => c.json({ data: await service.changeSession(mutation(c), c.req.valid('param').id, 'cancel', c.req.valid('json')) }, 200)),
    route({ ...contracts.swapCoach, request: { params: contracts.swapCoach.params, body: body(contracts.swapCoach.body) }, responses: response(contracts.swapCoach.response) },
      async (c) => c.json({ data: await service.changeSession(mutation(c), c.req.valid('param').id, 'coach', c.req.valid('json')) }, 200)),
    route({ ...contracts.updateNotes, request: { params: contracts.updateNotes.params, body: body(contracts.updateNotes.body) }, responses: response(contracts.updateNotes.response) },
      async (c) => c.json({ data: await service.changeSession(mutation(c), c.req.valid('param').id, 'notes', c.req.valid('json')) }, 200)),
    route({ ...contracts.updateCapacity, request: { params: contracts.updateCapacity.params, body: body(contracts.updateCapacity.body) }, responses: response(contracts.updateCapacity.response) },
      async (c) => c.json({ data: await service.changeSession(mutation(c), c.req.valid('param').id, 'capacity', c.req.valid('json')) }, 200)),
  ];
}
export const routes = createScheduleRoutes();
