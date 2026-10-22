// SPDX-License-Identifier: AGPL-3.0-only
import { z, type OpenAPIHono } from '@hono/zod-openapi';
import type { RequestEnvironment } from './context.js';
import { route, type PermissionMiddleware } from './registry.js';

export const defaultSourceUrl = 'https://github.com/plaingym/plaingym';

export function sourceUrl(value = process.env.SOURCE_URL ?? defaultSourceUrl): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid SOURCE_URL');
  return url.href;
}

/** Public install metadata remains available even before a gym is configured. */
export function mountSourceLink(app: OpenAPIHono<RequestEnvironment>, url: string, authorize: PermissionMiddleware): void {
  // TODO(CCR): promote the public install contracts into shared contracts.
  route({ method: 'get', path: '/api/source', permission: { kind: 'public' },
    responses: { 200: { description: 'Running source URL', content: { 'application/json': { schema: z.object({ data: z.object({ url: z.url() }) }) } } } },
  }, (context) => {
    context.header('Cache-Control', 'no-store');
    return context.json({ data: { url } }, 200);
  }).mount(app, authorize);
  route({ method: 'get', path: '/source', permission: { kind: 'public' },
    responses: { 302: { description: 'Source code', headers: { Location: { schema: { type: 'string', format: 'uri' } } } } },
  }, (context) => {
    context.header('Cache-Control', 'no-store');
    return context.redirect(url, 302);
  }).mount(app, authorize);
}
