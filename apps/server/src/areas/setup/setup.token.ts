// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '@plaingym/shared';
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from '../../core/context.js';

/** A fragment keeps the installer secret out of HTTP URLs and referrer headers. */
export function setupLink(origin: string, token: string | undefined): string {
  if (!token || token.length < 32) throw new Error('Set SETUP_TOKEN to a random secret of at least 32 characters');
  const url = new URL('/setup', origin);
  url.hash = new URLSearchParams({ token }).toString();
  return url.href;
}
export function requireSetupToken(token: string | undefined): MiddlewareHandler<RequestEnvironment> {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return async (c, next) => {
    const supplied = c.req.header('x-setup-token');
    if (!token || token.length < 32 || !supplied || !timingSafeEqual(digest(token), digest(supplied)))
      throw new AppError('forbidden', 'Use the setup link printed by the installer');
    c.header('Cache-Control', 'no-store');
    await next();
  };
}
