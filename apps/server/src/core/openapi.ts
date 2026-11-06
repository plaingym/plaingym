// SPDX-License-Identifier: AGPL-3.0-only
import type { OpenAPIHono } from '@hono/zod-openapi';
import { installContracts } from '@plaingym/shared/contracts';
import type { RequestEnvironment } from './context.js';
import { route, type PermissionMiddleware } from './registry.js';

export function mountOpenApi(app: OpenAPIHono<RequestEnvironment>, authorize: PermissionMiddleware): void {
  route(installContracts.openApi, (context) => context.json(app.getOpenAPIDocument({
    openapi: '3.0.3', info: { title: 'PlainGym API', version: '0.0.0' },
  }), 200)).mount(app, authorize);
}
