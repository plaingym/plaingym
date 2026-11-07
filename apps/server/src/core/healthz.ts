// SPDX-License-Identifier: AGPL-3.0-only
import type { OpenAPIHono } from '@hono/zod-openapi';
import { installContracts } from '@plaingym/shared/contracts';
import type { RequestEnvironment } from './context.js';
import { route, type PermissionMiddleware } from './registry.js';
import { runningVersion } from '../areas/health/version.js';

/** Install liveness is deliberately independent of tenancy and sessions. */
export function mountHealthz(app: OpenAPIHono<RequestEnvironment>, authorize: PermissionMiddleware): void {
  route(installContracts.health, (context) => {
    context.header('Cache-Control', 'no-store');
    return context.json({ status: 'ok' as const, ...runningVersion() }, 200);
  }).mount(app, authorize);
}
