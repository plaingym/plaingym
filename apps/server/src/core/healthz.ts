// SPDX-License-Identifier: AGPL-3.0-only
import { z, type OpenAPIHono } from '@hono/zod-openapi';
import type { RequestEnvironment } from './context.js';
import { route, type PermissionMiddleware } from './registry.js';

/** Install liveness is deliberately independent of tenancy and sessions. */
export function mountHealthz(app: OpenAPIHono<RequestEnvironment>, authorize: PermissionMiddleware): void {
  // TODO: promote the public install contract into shared contracts.
  route({ method: 'get', path: '/healthz', permission: { kind: 'public' },
    responses: { 200: { description: 'Install liveness', content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } } } },
  }, (context) => context.json({ status: 'ok' as const }, 200)).mount(app, authorize);
}
