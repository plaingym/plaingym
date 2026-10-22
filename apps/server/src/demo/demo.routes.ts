// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from '../core/context.js';
import { AppError } from '@plaingym/shared';
import { route, type RouteRegistration } from '../core/registry.js';
import { clientIp, rateLimit, type ClientIpOptions } from '../core/rate-limit.js';
import { csrf } from '../core/csrf.js';
import { demoContracts } from '@plaingym/shared/contracts';
import { createOutboxQuery } from './outbox.js';
import type { DemoService } from './service.js';

export function createDemoRoutes(service: DemoService, options: { installOrigin: string; enabled?: boolean; clientIp?: ClientIpOptions; outbox?: ReturnType<typeof createOutboxQuery> }) {
  const limiter = rateLimit({ ...options.clientIp, limit: 3, windowMs: 60 * 60 * 1000 });
  const loginLimiter = rateLimit({ ...options.clientIp, limit: 20, windowMs: 60_000 });
  const guard = csrf(options.installOrigin), outbox = options.outbox ?? createOutboxQuery();
  const modeGuard: MiddlewareHandler<RequestEnvironment> = async (_c, next) => { if (options.enabled === false) throw new AppError('not_found', 'Not found'); await next(); };
  const { create, status, login, outbox: list, message, entry } = demoContracts;
  const installHost: MiddlewareHandler<RequestEnvironment> = async (c, next) => {
    if ((c.req.header('host') ?? new URL(c.req.url).host) !== new URL(options.installOrigin).host) throw new AppError('not_found', 'Not found');
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
    route({ ...entry, middleware: [modeGuard, installHost], responses: { 200: { description: 'Demo entry', content: { 'application/json': { schema: entry.response } } } } },
      (c) => { c.header('cache-control', 'no-store'); return c.json({ data: { enabled: true as const } }, 200); }),
  ];
}
let configured: ReturnType<typeof createDemoRoutes> | undefined;
export function configureDemoRoutes(service: DemoService, options: Parameters<typeof createDemoRoutes>[1]): void { configured = createDemoRoutes(service, options); }
export function disableDemoRoutes(): void { configured = undefined; }
// Stable registrations delegate to the configured runtime; outside demo mode every route is absent.
const disabled = async () => { throw new AppError('not_found', 'Not found'); };
const placeholder: DemoService = { create: disabled, status: disabled, login: disabled, expire: async () => {} };
export const routes: readonly RouteRegistration[] = createDemoRoutes(placeholder, { installOrigin: 'https://demo.invalid', enabled: false }).map((entry, index) => ({
  ...entry, mount(app, authorize) {
    if (configured) configured[index]!.mount(app, authorize);
    else entry.mount(app, authorize);
  },
}));
