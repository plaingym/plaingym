// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { OpenAPIHono } from '@hono/zod-openapi';
import { AppError } from '@plaingym/shared';
import { demoContracts, ranksContracts, setupContracts } from '@plaingym/shared/contracts';
import type { MiddlewareHandler } from 'hono';
import { clock as systemClock, type Clock } from './clock.js';
import type { RequestContext, RequestEnvironment } from './context.js';
import { createServerRegistry, type PermissionMiddleware, type ServerContributions } from './registry.js';
import { errorHandler, respondError } from './errors.js';
import { csrf, type CanonicalOrigin } from './csrf.js';
import { clientIp, rateLimit, type RateLimitOptions } from './rate-limit.js';
import { requestBodyLimit, type BodyLimits } from './body-limit.js';
import { mountHealthz } from './healthz.js';
import { mountSourceLink, sourceUrl } from './source-link.js';
import { mountOpenApi } from './openapi.js';
import { staticAssets } from './static.js';
import { requireSetupToken } from '../areas/setup/setup.token.js';

export interface AppOptions {
  readonly resolveGym: MiddlewareHandler<RequestEnvironment>;
  readonly session: MiddlewareHandler<RequestEnvironment>;
  readonly authorize: PermissionMiddleware;
  readonly contributions?: ServerContributions;
  readonly clock?: Clock;
  readonly origin?: CanonicalOrigin;
  readonly rateLimit?: RateLimitOptions;
  readonly bodyLimits?: BodyLimits;
  readonly sourceUrl?: string;
  readonly publicDirectory?: string;
  /** Install-local gate, before any tenant database access. */
  readonly restoreGate?: MiddlewareHandler<RequestEnvironment>;
  /** First-boot requests have no resolved gym from which to derive an origin. */
  readonly installOrigin?: string;
  readonly setupToken?: string;
  readonly skipSetup?: boolean;
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
    // Resolved once at the proxy boundary, so every limiter buckets the actual client.
    context.set('context', { requestId, principal: { kind: 'anonymous' }, clock: options.clock ?? systemClock } as RequestContext);
    context.set('context', { ...context.get('context'), clientIp: clientIp(context, options.rateLimit) });
    context.header('X-Request-ID', requestId);
    await next();
  });
  app.use('*', requestBodyLimit(options.bodyLimits));
  app.onError(errorHandler);
  app.notFound((context) => respondError(context, new AppError('not_found', 'Not found.')));
  // These explicitly public install endpoints do not have a gym principal yet.
  const installAuthorize: PermissionMiddleware = (permission) => async (_context, next) => {
    if (permission.kind !== 'public') throw new Error('Install endpoints must be public');
    await next();
  };
  mountHealthz(app, installAuthorize);
  mountSourceLink(app, sourceUrl(options.sourceUrl), installAuthorize);
  const contributions = { ...options.contributions, routes: (options.contributions?.routes ?? []).filter((entry) =>
    !options.skipSetup || !Object.values(setupContracts).some((contract) => entry.id === `${contract.method.toUpperCase()} ${contract.path}`)) };
  const firstBootIds = new Set(Object.values(setupContracts)
    .filter((contract) => contract.gate === 'uninitialized_install')
    .map((contract) => `${contract.method.toUpperCase()} ${contract.path}`));
  const catalogId = `${ranksContracts.catalog.method.toUpperCase()} ${ranksContracts.catalog.path}`;
  const installRoutes = (contributions.routes ?? []).filter((entry) => firstBootIds.has(entry.id) || entry.id === catalogId);
  const installCsrf = csrf(options.installOrigin ?? (typeof options.origin === 'string' ? options.origin : undefined));
  const installLimiter = rateLimit(options.rateLimit);
  const setupToken = requireSetupToken(options.setupToken ?? process.env.SETUP_TOKEN);
  const authorizeInstall: PermissionMiddleware = (permission) => async (context, next) => {
    await installCsrf(context, async () => {
      await installLimiter(context, async () => { await installAuthorize(permission)(context, next); });
    });
  };
  // Setup handlers enforce their own first-boot guard. Only the restore coordinator
  // and its status reader run outside the activity lease that restore must drain.
  const restoreIds = new Set([setupContracts.restore, setupContracts.restoreStatus]
    .map((contract) => `${contract.method.toUpperCase()} ${contract.path}`));
  for (const entry of installRoutes.filter((entry) => firstBootIds.has(entry.id))) {
    entry.mount(app, (permission) => async (context, next) => {
      const guarded = () => entry.id === 'GET /api/setup'
        ? authorizeInstall(permission)(context, next)
        : setupToken(context, async () => { await authorizeInstall(permission)(context, next); });
      if (options.restoreGate && !restoreIds.has(entry.id)) {
        return options.restoreGate(context, async () => { await guarded(); });
      }
      return guarded();
    });
  }
  if (options.restoreGate) app.use('*', options.restoreGate);
  const demoInstallIds = new Set([demoContracts.create, demoContracts.entry].map((contract) => `${contract.method.toUpperCase()} ${contract.path}`));
  const demoInstallRoutes = (contributions.routes ?? []).filter((entry) => demoInstallIds.has(entry.id));
  for (const entry of demoInstallRoutes) entry.mount(app, authorizeInstall);
  for (const entry of installRoutes.filter((entry) => entry.id === catalogId)) entry.mount(app, authorizeInstall);
  app.use('*', staticAssets(options.publicDirectory));
  app.use('*', options.resolveGym);
  // Flood protection runs before the session middleware, which answers auth requests itself.
  app.use('*', rateLimit(options.rateLimit));
  app.use('*', options.session);
  app.use('*', csrf(options.origin));
  const registry = createServerRegistry({ ...contributions,
    routes: (contributions.routes ?? []).filter((entry) => !installRoutes.includes(entry) && !demoInstallRoutes.includes(entry)),
  });
  registry.mount(app, options.authorize, (context) => context.get('context').gym.enabledModules);
  mountOpenApi(app, options.authorize);
  return app;
}
