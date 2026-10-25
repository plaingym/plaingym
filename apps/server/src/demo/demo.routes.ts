// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from '../core/context.js';
import { AppError } from '@plaingym/shared';
import { route, type RouteRegistration } from '../core/registry.js';
import { clientIp, rateLimit, type ClientIpOptions } from '../core/rate-limit.js';
import { csrf } from '../core/csrf.js';
import { createTenantResolver, type TenancyMode } from '../core/tenancy.js';
import { demoContracts } from '@plaingym/shared/contracts';
import { createOutboxQuery } from './outbox.js';
import type { DemoService } from './service.js';

export function createDemoRoutes(service: DemoService, options: { installOrigin: string; enabled?: boolean; tenancy?: TenancyMode; clientIp?: ClientIpOptions; outbox?: ReturnType<typeof createOutboxQuery> }) {
  const limiter = rateLimit({ ...options.clientIp, limit: 3, windowMs: 60 * 60 * 1000 });
  const loginLimiter = rateLimit({ ...options.clientIp, limit: 20, windowMs: 60_000 });
  const guard = csrf(options.installOrigin), outbox = options.outbox ?? createOutboxQuery();
  const modeGuard: MiddlewareHandler<RequestEnvironment> = async (_c, next) => { if (options.enabled === false) throw new AppError('not_found', 'Not found'); await next(); };
  const { create, status, login, outbox: list, message, entry } = demoContracts;
  // The configured install host is known before setup creates a gym and after a
  // restore changes its hostname. Multi-tenant gym hosts still require resolution.
  const mode = options.tenancy ?? (options.enabled === false ? 'single' : 'multi');
  const resolveDiscoveryGym = createTenantResolver({ mode });
  const installAuthority = options.installOrigin ? new URL(options.installOrigin).host : undefined;
  const isInstallHost = (authority: string) => authority === installAuthority;
  const discoveryHost: MiddlewareHandler<RequestEnvironment> = (c, next) => {
    if (isInstallHost(c.req.header('host') ?? new URL(c.req.url).host)) return next();
    if (mode === 'single') throw new AppError('not_found', 'Not found');
    return resolveDiscoveryGym(c, next);
  };
  const installHost: MiddlewareHandler<RequestEnvironment> = async (c, next) => {
    if (!isInstallHost(c.req.header('host') ?? new URL(c.req.url).host)) throw new AppError('not_found', 'Not found');
    await next();
  };
  return [
    route({ ...create, middleware: [modeGuard, installHost, guard, limiter],
      responses: { 201: { description: 'Created', content: { 'application/json': { schema: create.response } } } },
    }, async (c) => { c.header('cache-control', 'no-store'); return c.json({ data: await service.create() }, 201); }),
    route({ ...status,
      responses: { 200: { description: 'Demo status', content: { 'application/json': { schema: status.response } } } },
    }, async (c) => { c.header('cache-control', 'no-store'); return c.json({ data: await service.status(c.get('context').gym.gymId) }, 200); }),
    route({ ...login, middleware: [modeGuard, loginLimiter],
      request: { body: { required: true, content: { 'application/json': { schema: login.body } } } },
      responses: { 200: { description: 'Demo session created', content: { 'application/json': { schema: login.response } } } },
    }, async (c) => {
      const role = c.req.valid('json').role;
      const response = await service.login(c.get('context').gym.gymId, role, clientIp(c, options.clientIp) === 'unknown' ? '0.0.0.0' : clientIp(c, options.clientIp));
      for (const cookie of response.headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
      c.header('cache-control', 'no-store');
      return c.json({ data: { redirect: role === 'student' ? '/portal' as const : '/admin' as const } }, 200);
    }),
    route({ ...list, request: { query: list.query },
      responses: { 200: { description: 'Outbox', content: { 'application/json': { schema: list.response } } } },
    }, async (c) => { const gymId = c.get('context').gym.gymId; await service.status(gymId); c.header('cache-control', 'no-store'); return c.json(await outbox.list(gymId, c.req.valid('query')), 200); }),
    route({ ...message, request: { params: message.params },
      responses: { 200: { description: 'Message', content: { 'application/json': { schema: message.response } } } },
    }, async (c) => { const gymId = c.get('context').gym.gymId; await service.status(gymId); c.header('cache-control', 'no-store'); return c.json({ data: await outbox.get(gymId, c.req.valid('param').id) }, 200); }),
    route({ ...entry, middleware: [discoveryHost], responses: { 200: { description: 'Demo discovery', content: { 'application/json': { schema: entry.response } } } } },
      async (c) => {
        c.header('cache-control', 'no-store');
        if (options.enabled === false) return c.json({ data: { mode: 'disabled' as const } }, 200);
        if (isInstallHost(c.req.header('host') ?? new URL(c.req.url).host))
          return c.json({ data: { mode: 'entry' as const } }, 200);
        return c.json({ data: { mode: 'sandbox' as const, ...await service.status(c.get('context').gym.gymId) } }, 200);
      }),
  ];
}
let configured: ReturnType<typeof createDemoRoutes> | undefined;
export function configureDemoRoutes(service: DemoService, options: Parameters<typeof createDemoRoutes>[1]): void { configured = createDemoRoutes(service, options); }
export function disableDemoRoutes(installOrigin: string, tenancy: TenancyMode = 'single'): void { configured = createDemoRoutes(placeholder, { installOrigin, tenancy, enabled: false }); }
// Stable registrations delegate to the configured runtime; outside demo mode only discovery succeeds.
const disabled = async () => { throw new AppError('not_found', 'Not found'); };
const placeholder: DemoService = { create: disabled, status: disabled, login: disabled, expire: async () => {} };
export const routes: readonly RouteRegistration[] = createDemoRoutes(placeholder, { installOrigin: '', enabled: false }).map((entry, index) => ({
  ...entry, mount(app, authorize) {
    if (configured) configured[index]!.mount(app, authorize);
    else entry.mount(app, authorize);
  },
}));
