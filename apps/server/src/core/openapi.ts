// SPDX-License-Identifier: AGPL-3.0-only
import { z, type OpenAPIHono } from '@hono/zod-openapi';
import type { RequestEnvironment } from './context.js';
import { route, type PermissionMiddleware } from './registry.js';

export function mountOpenApi(app: OpenAPIHono<RequestEnvironment>, authorize: PermissionMiddleware): void {
  // TODO(CCR): promote the public document contract into shared contracts.
  const documentSchema = z.custom<ReturnType<typeof app.getOpenAPIDocument>>()
    .openapi({ type: 'object', description: 'OpenAPI 3.0 document' });
  route({ method: 'get', path: '/api/openapi.json', permission: { kind: 'public' },
    responses: { 200: { description: 'OpenAPI document', content: { 'application/json': { schema: documentSchema } } } },
  }, (context) => context.json(app.getOpenAPIDocument({
    openapi: '3.0.3', info: { title: 'PlainGym API', version: '0.0.0' },
  }), 200)).mount(app, authorize);
}
