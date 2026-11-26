// SPDX-License-Identifier: AGPL-3.0-only
import type { OpenAPIHono } from '@hono/zod-openapi';
import { installContracts } from '@plaingym/shared/contracts';
import type { RequestEnvironment } from './context.js';
import { route, type PermissionMiddleware } from './registry.js';

export const defaultSourceUrl = 'https://github.com/plaingym/plaingym';

export function sourceUrl(value?: string): string {
  const chosen = value || process.env.SOURCE_URL, image = process.env.IMAGE_SOURCE_URL;
  // Older Compose files pass the repository root explicitly, so an image's own, more exact link replaces it.
  // The parsed href lowercases the host and keeps any credentials, query or fragment, so only the bare root matches.
  const isRoot = (text: string) => URL.canParse(text) && new URL(text).href.replace(/\/$/, '') === defaultSourceUrl;
  const url = new URL(chosen && !(image && isRoot(chosen)) ? chosen : image || defaultSourceUrl);
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
