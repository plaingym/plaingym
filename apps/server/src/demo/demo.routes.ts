// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from '../core/context.js';
import { AppError, type Translator } from '@plaingym/shared';
import { route, type RouteRegistration } from '../core/registry.js';
import { clientIp, rateLimit, type ClientIpOptions } from '../core/rate-limit.js';
import { csrf } from '../core/csrf.js';
import { createTenantResolver, type TenancyMode } from '../core/tenancy.js';
import { demoContracts, demoTestCard } from '@plaingym/shared/contracts';
import { createOutboxQuery } from './outbox.js';
import type { DemoService } from './service.js';
import { demoLoginRateLimit, demoLoginRedirect, joinedMembers } from './identities.js';
import { z } from '@hono/zod-openapi';
import type { forGym } from '@plaingym/db';

/** A captured email's own policy: inline styles and data: images only, no script (sandbox), framed only by the app. */
export const outboxPreviewPolicy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; "
  + "sandbox; frame-ancestors 'self'";

export function createDemoRoutes(service: DemoService, options: { installOrigin: string; enabled?: boolean; tenancy?: TenancyMode; clientIp?: ClientIpOptions; outbox?: ReturnType<typeof createOutboxQuery>; scope?: typeof forGym }) {
  const limiter = rateLimit({ ...options.clientIp, limit: 3, windowMs: 60 * 60 * 1000 });
  const loginLimiter = rateLimit({ ...options.clientIp, limit: demoLoginRateLimit.max, windowMs: demoLoginRateLimit.window * 1000 });
  const guard = csrf(options.installOrigin), outbox = options.outbox ?? createOutboxQuery();
  const modeGuard: MiddlewareHandler<RequestEnvironment> = async (_c, next) => { if (options.enabled === false) throw new AppError('not_found', 'Not found'); await next(); };
  const { create, status, login, menu, signInLink, outbox: list, message, entry } = demoContracts;
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
  const discovery = route({ ...entry, middleware: [discoveryHost], responses: { 200: { description: 'Demo discovery', content: { 'application/json': { schema: entry.response } } } } },
    async (c) => {
      c.header('cache-control', 'no-store');
      if (options.enabled === false) return c.json({ data: { mode: 'disabled' as const } }, 200);
      if (isInstallHost(c.req.header('host') ?? new URL(c.req.url).host))
        return c.json({ data: { mode: 'entry' as const } }, 200);
      return c.json({ data: { mode: 'sandbox' as const, ...await service.status(c.get('context').gym.gymId) } }, 200);
    });
  return [
    route({ ...create, middleware: [modeGuard, installHost, guard, limiter],
      responses: { 201: { description: 'Created', content: { 'application/json': { schema: create.response } } } },
    }, async (c) => { c.header('cache-control', 'no-store'); return c.json({ data: await service.create() }, 201); }),
    route({ ...status,
      responses: { 200: { description: 'Demo status', content: { 'application/json': { schema: status.response } } } },
    }, async (c) => { c.header('cache-control', 'no-store'); const { expiresAt } = await service.status(c.get('context').gym.gymId); return c.json({ data: { expiresAt } }, 200); }),
    route({ ...login, middleware: [modeGuard, loginLimiter],
      request: { body: { required: true, content: { 'application/json': { schema: login.body } } } },
      responses: { 200: { description: 'Demo session created', content: { 'application/json': { schema: login.response } } } },
    }, async (c) => {
      const target = c.req.valid('json');
      const response = await service.login(c.get('context').gym.gymId, target, clientIp(c, options.clientIp) === 'unknown' ? '0.0.0.0' : clientIp(c, options.clientIp));
      for (const cookie of response.headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
      c.header('cache-control', 'no-store');
      return c.json({ data: { redirect: demoLoginRedirect(target) } }, 200);
    }),
    // The demo menu's joined members and website link. Anyone in a sandbox may sign in as any of its logins, so naming them hides nothing.
    route({ ...menu, middleware: [modeGuard],
      responses: { 200: { description: 'Demo menu', content: { 'application/json': { schema: menu.response } } } },
    }, async (c) => {
      const { gymId, enabledModules } = c.get('context').gym; await service.status(gymId);
      c.header('cache-control', 'no-store');
      return c.json({ data: { members: await joinedMembers(gymId, options.scope), website: enabledModules.has('website') } }, 200);
    }),
    // The visitor's own sign-in link, from the latest sign-in message to the address they entered on /login: sign-in messages
    // only, and only this sandbox's. The rest of the outbox stays with the owner and admins.
    route({ ...signInLink, middleware: [modeGuard, loginLimiter],
      request: { body: { required: true, content: { 'application/json': { schema: signInLink.body } } } },
      responses: { 200: { description: 'Sign-in link', content: { 'application/json': { schema: signInLink.response } } } },
    }, async (c) => {
      const gymId = c.get('context').gym.gymId; await service.status(gymId);
      c.header('cache-control', 'no-store'); c.header('referrer-policy', 'no-referrer');
      return c.json({ data: await outbox.signInLink(gymId, c.req.valid('json').email) }, 200);
    }),
    route({ ...list, request: { query: list.query },
      responses: { 200: { description: 'Outbox', content: { 'application/json': { schema: list.response } } } },
    }, async (c) => { const gymId = c.get('context').gym.gymId; await service.status(gymId); c.header('cache-control', 'no-store'); return c.json(await outbox.list(gymId, c.req.valid('query')), 200); }),
    route({ ...message, request: { params: message.params },
      responses: { 200: { description: 'Message', content: { 'application/json': { schema: message.response } } } },
    }, async (c) => { const gymId = c.get('context').gym.gymId; await service.status(gymId); c.header('cache-control', 'no-store'); return c.json({ data: await outbox.get(gymId, c.req.valid('param').id) }, 200); }),
    // The outbox's preview frame loads the message from here rather than from srcdoc, which would take the admin page's
    // policy: email HTML keeps its inline styles under a policy of its own, which runs no script, loads nothing and
    // may be framed only by the app's own pages. TODO: promote this contract into the shared demo contracts.
    route({ method: 'get', path: '/api/demo/outbox/{id}/preview', permission: message.permission, request: { params: message.params },
      responses: { 200: { description: 'Message HTML for the sandboxed preview frame', content: { 'text/html': { schema: z.string() } } } },
    }, async (c) => {
      const gymId = c.get('context').gym.gymId; await service.status(gymId);
      const html = (await outbox.get(gymId, c.req.valid('param').id)).html;
      c.header('cache-control', 'no-store'); c.header('x-content-type-options', 'nosniff'); c.header('referrer-policy', 'no-referrer');
      c.header('content-security-policy', outboxPreviewPolicy);
      return c.html(html, 200);
    }),
    { ...discovery, mount(app: Parameters<RouteRegistration['mount']>[0], authorize: Parameters<RouteRegistration['mount']>[1]) {
      // Discovery mounts before tenant resolution: the entry host has no gym.
      // Keep ordinary gym roots available to their public website routes.
      if (options.enabled !== false) app.get('/', async (c, next) => {
        if (!isInstallHost(c.req.header('host') ?? new URL(c.req.url).host)) return next();
        await authorize({ kind: 'public' })(c, async () => { c.res = c.redirect('/demo', 302); });
        return c.res;
      });
      discovery.mount(app, authorize);
    } },
  ];
}
/** For the join page's payment steps (`joinStatusPage`'s `testCardHint`): the test card to pay with, only in a sandbox that takes joins. */
export function joinTestCardHint(service: Pick<DemoService, 'status'>, t: Translator) {
  return async (gymId: string): Promise<string | undefined> => {
    const sandbox = await service.status(gymId).catch(() => undefined);
    return sandbox?.join ? t('demo/demo:joinTestCard', { number: demoTestCard }) : undefined;
  };
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
