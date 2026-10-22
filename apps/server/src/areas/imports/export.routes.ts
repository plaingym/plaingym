// SPDX-License-Identifier: AGPL-3.0-only
import { importsContracts } from '@plaingym/shared/contracts';
import { route, type RouteRegistration } from '../../core/registry.js';
import { importActor } from './pipeline.routes.js';
import type { ExportService } from './export.js';
export function createExportRoutes(service: ExportService): RouteRegistration[] {
  const create = importsContracts.createExport, get = importsContracts.getExport;
  return [
    route({ ...create, request: { body: { required: true, content: { 'application/json': { schema: create.body } } } },
      responses: { 200: { description: 'Export queued', content: { 'application/json': { schema: create.response } } } } },
    async (c) => c.json({ data: await service.create(importActor(c.get('context')), c.get('context').gym.timezone) }, 200)),
    route({ ...get, request: { params: get.params },
      responses: { 200: { description: 'Export progress', content: { 'application/json': { schema: get.response } } } } },
    async (c) => c.json({ data: await service.get(importActor(c.get('context')).gymId, c.req.valid('param').id) }, 200)),
  ];
}

export const routes: readonly RouteRegistration[] = [];
