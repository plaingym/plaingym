// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { OpenAPIHono } from '@hono/zod-openapi';
import { AppError } from '@plaingym/shared';
import type { MiddlewareHandler } from 'hono';
import { clock as systemClock, type Clock } from './clock.js';
import type { RequestContext, RequestEnvironment } from './context.js';
import { createServerRegistry, type PermissionMiddleware, type ServerContributions } from './registry.js';
import { errorHandler, respondError } from './errors.js';
import { csrf, type CanonicalOrigin } from './csrf.js';
import { rateLimit, type RateLimitOptions } from './rate-limit.js';
import { mountHealthz } from './healthz.js';
import { mountSourceLink, sourceUrl } from './source-link.js';
import { mountOpenApi } from './openapi.js';
import { staticAssets } from './static.js';

export interface AppOptions {
  readonly resolveGym: MiddlewareHandler<RequestEnvironment>;
  readonly session: MiddlewareHandler<RequestEnvironment>;
  readonly authorize: PermissionMiddleware;
  readonly contributions?: ServerContributions;
  readonly clock?: Clock;
  readonly origin?: CanonicalOrigin;
  readonly rateLimit?: RateLimitOptions;
  readonly sourceUrl?: string;
  readonly publicDirectory?: string;
}

export function createApp(options: AppOptions): OpenAPIHono<RequestEnvironment> {
  const app = new OpenAPIHono<RequestEnvironment>({
    defaultHook: (result, context) => {
      if (!result.success) return respondError(context, result.error);
    },
  });
  app.use('*', async (context, next) => {
    // A caller cannot choose a log-correlation ID or inject response headers with it.
    const requestId = randomUUID();
    // Gym is populated only by resolveGym; install endpoints never read it.
    context.set('context', { requestId, principal: { kind: 'anonymous' }, clock: options.clock ?? systemClock } as RequestContext);
    context.header('X-Request-ID', requestId);
    await next();
  });
  app.onError(errorHandler);
  app.notFound((context) => respondError(context, new AppError('not_found', 'Not found.')));
  // These explicitly public install endpoints do not have a gym principal yet.
  const installAuthorize: PermissionMiddleware = (permission) => async (_context, next) => {
    if (permission.kind !== 'public') throw new Error('Install endpoints must be public');
    await next();
  };
  mountHealthz(app, installAuthorize);
  mountSourceLink(app, sourceUrl(options.sourceUrl), installAuthorize);
  app.use('*', options.resolveGym);
  app.use('*', options.session);
  app.use('*', csrf(options.origin));
  app.use('*', rateLimit(options.rateLimit));
  const registry = createServerRegistry(options.contributions ?? {});
  registry.mount(app, options.authorize, (context) => context.get('context').gym.enabledModules);
  mountOpenApi(app, options.authorize);
  app.use('*', staticAssets(options.publicDirectory));
  return app;
}
