// SPDX-License-Identifier: AGPL-3.0-only
import type { OpenAPIHono } from '@hono/zod-openapi';
import { installContracts } from '@plaingym/shared/contracts';
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
  route(installContracts.source, (context) => {
    context.header('Cache-Control', 'no-store');
    return context.json({ data: { url } }, 200);
  }).mount(app, authorize);
  route(installContracts.sourceRedirect, (context) => {
    context.header('Cache-Control', 'no-store');
    return context.redirect(url, 302);
  }).mount(app, authorize);
}
