// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from './context.js';

export type CanonicalOrigin = string | ((context: Context<RequestEnvironment>) => string);

/** Canonical origins must come from install configuration or the resolved gym. */
export function csrf(origin?: CanonicalOrigin): MiddlewareHandler<RequestEnvironment> {
  return async (context, next) => {
    const { method } = context.req;
    const principal = context.get('context').principal;
    const webhook = context.req.path === '/webhooks/stripe';
    const kioskBearer = principal.kind === 'kiosk' && principal.gymId === context.get('context').gym.gymId
      && /^Bearer\s+\S+$/i.test(context.req.header('authorization') ?? '')
      && (context.req.path === '/api/kiosk' || context.req.path.startsWith('/api/kiosk/'));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && context.req.header('cookie') && !webhook && !kioskBearer) {
      const expected = typeof origin === 'function' ? origin(context) : origin ?? new URL(context.req.url).origin;
      const actual = context.req.header('origin');
      const site = context.req.header('sec-fetch-site');
      if (!actual || actual === 'null' || actual !== new URL(expected).origin
        || (site !== undefined && site !== 'same-origin' && site !== 'none')) {
        throw new AppError('forbidden', 'The request origin is not allowed.');
      }
    }
    await next();
  };
}
