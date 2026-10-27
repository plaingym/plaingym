// SPDX-License-Identifier: AGPL-3.0-only
import { t } from './pipeline.messages.js';
import { AppError } from '@plaingym/shared';
import { importsContracts } from '@plaingym/shared/contracts';
import type { RequestContext } from '../../core/context.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import { route, type RouteRegistration } from '../../core/registry.js';
import type { ImportPipeline } from './pipeline.js';

export function importActor(context: RequestContext): MutationContext {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
    throw new AppError('not_found', t('imports/pipeline:notFound'));
  return { gymId: context.gym.gymId, actor: { kind: 'user', userId: context.principal.userId } };
}
// TODO: put this documentation on the shared upload schema. zod-to-openapi has no
// representation for z.file(); the cloned field keeps its validation.
const uploadBody = importsContracts.upload.body.extend({
  file: importsContracts.upload.body.shape.file.openapi({ type: 'string', format: 'binary' }),
});
export function createPipelineRoutes(service: ImportPipeline): RouteRegistration[] {
  const { upload, preview, start, get, errors } = importsContracts;
  return [
    route({ ...upload, middleware: [async (c, next) => {
      if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'multipart/form-data')
        throw new AppError('invalid_request', 'The request must contain a multipart file upload.');
      await next();
    }], request: { body: { required: true, content: { 'multipart/form-data': { schema: uploadBody } } } },
      responses: { 200: { description: 'CSV upload', content: { 'application/json': { schema: upload.response } } } } },
    async (c) => c.json({ data: await service.upload(importActor(c.get('context')), c.req.valid('form').file) }, 200)),
    route({ ...preview, request: { query: preview.query, body: { required: true, content: { 'application/json': { schema: preview.body } } } },
      responses: { 200: { description: 'Import preview', content: { 'application/json': { schema: preview.response } } } } },
    async (c) => c.json(await service.preview(importActor(c.get('context')), c.req.valid('json'), c.req.valid('query'), c.get('context').gym.timezone), 200)),
    route({ ...start, request: { body: { required: true, content: { 'application/json': { schema: start.body } } } },
      responses: { 200: { description: 'Import queued', content: { 'application/json': { schema: start.response } } } } },
    async (c) => c.json({ data: await service.start(importActor(c.get('context')), c.req.valid('json'), c.get('context').gym.timezone) }, 200)),
    route({ ...get, request: { params: get.params },
      responses: { 200: { description: 'Import progress', content: { 'application/json': { schema: get.response } } } } },
    async (c) => c.json({ data: await service.get(importActor(c.get('context')).gymId, c.req.valid('param').id) }, 200)),
    route({ ...errors, request: { params: errors.params, query: errors.query },
      responses: { 200: { description: 'Import errors', content: { 'application/json': { schema: errors.response } } } } },
    async (c) => c.json(await service.errors(importActor(c.get('context')).gymId, c.req.valid('param').id, c.req.valid('query')), 200)),
  ];
}

// Runtime owns storage and the job worker; mount createPipelineRoutes with those injected.
export const routes: readonly RouteRegistration[] = [];
