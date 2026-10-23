// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, type OpenAPIHono, type RouteConfig, type RouteHandler } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import {
  isRoutePermission,
  Registry,
  type RegistryEntry,
  type RoutePermission,
  type Translator,
  type WebContribution,
} from '@plaingym/shared';
import type { RequestEnvironment } from './context.js';
import type { JobContext, JobHandler, Jobs } from '../infra/jobs/index.js';

export type PermissionMiddleware = (permission: RoutePermission) => MiddlewareHandler<RequestEnvironment>;
export interface RouteAuthorization {
  readonly permission: RoutePermission;
  readonly additionalPermissions?: readonly RoutePermission[];
}
export interface RouteRegistration extends RegistryEntry {
  readonly definition: RouteConfig & RouteAuthorization;
  mount(app: OpenAPIHono<RequestEnvironment>, authorize: PermissionMiddleware): void;
}

/** Contract fields spread into a definition hold Zod schemas; `request` and `responses` document the route.
 * Kept in the document, a recursive schema such as `z.json()` becomes circular once it has parsed a value. */
const contractOnly = new Set(['params', 'query', 'body', 'response', 'contentType']);
/** Authorization runs before request validation and the route handler. */
export function route<const C extends RouteConfig>(
  definition: C & RouteAuthorization,
  handler: RouteHandler<C, RequestEnvironment>,
): RouteRegistration {
  if (!isRoutePermission(definition.permission)) throw new Error('A route must declare a valid permission');
  const permissions = [definition.permission, ...(definition.additionalPermissions ?? [])];
  if (!permissions.every(isRoutePermission)) throw new Error('A route must declare valid additional permissions');
  const config = createRoute(definition);
  const documented = Object.fromEntries(Object.entries(config).filter(([key]) => !contractOnly.has(key))) as unknown as typeof config;
  return {
    id: `${definition.method.toUpperCase()} ${definition.path}`,
    definition: config,
    mount(app, authorize) {
      const middleware = definition.middleware ? [definition.middleware].flat() : [];
      app.openapi({ ...documented, middleware: [...permissions.map((permission) => authorize(permission)), ...middleware] }, handler);
    },
  };
}

export interface JobRegistration extends RegistryEntry {
  readonly handler: JobHandler;
  readonly cron?: string;
}
export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}
export interface EmailTemplate extends RegistryEntry {
  render(data: unknown, t: Translator): Promise<RenderedEmail>;
}
export interface ModuleDefinition extends RegistryEntry {
  readonly schemaFile: string | null;
  readonly routes: readonly RouteRegistration[];
  readonly jobs: readonly JobRegistration[];
  readonly emails: readonly EmailTemplate[];
  readonly web: WebContribution<unknown>;
}
export interface ServerContributions {
  readonly routes?: readonly RouteRegistration[];
  readonly jobs?: readonly JobRegistration[];
  readonly emails?: readonly EmailTemplate[];
  readonly modules?: readonly ModuleDefinition[];
}

export function createServerRegistry(contributions: ServerContributions) {
  const routes = new Registry<RouteRegistration>();
  const jobs = new Registry<JobRegistration>();
  const emails = new Registry<EmailTemplate>();
  const modules = new Registry<ModuleDefinition>();
  routes.registerAll(contributions.routes ?? []);
  jobs.registerAll(contributions.jobs ?? []);
  emails.registerAll(contributions.emails ?? []);
  for (const module of contributions.modules ?? []) {
    modules.register(module);
    routes.registerAll(module.routes.map((item) => ({ ...item, moduleId: module.id })));
    jobs.registerAll(module.jobs.map((item) => ({ ...item, moduleId: module.id })));
    emails.registerAll(module.emails.map((item) => ({ ...item, moduleId: module.id })));
  }
  return {
    routes,
    jobs,
    emails,
    modules,
    mount(
      app: OpenAPIHono<RequestEnvironment>,
      authorize: PermissionMiddleware,
      enabled: ReadonlySet<string> | ((context: Context<RequestEnvironment>) => ReadonlySet<string>),
    ) {
      for (const entry of typeof enabled === 'function' ? routes.all() : routes.forModules(enabled)) {
        entry.mount(app, (permission) => async (context, next) => {
          const active = typeof enabled === 'function' ? enabled(context) : enabled;
          if (entry.moduleId && !active.has(entry.moduleId)) return context.notFound();
          return authorize(permission)(context, next);
        });
      }
    },
    registerJobs(
      worker: Jobs,
      enabled: ReadonlySet<string> | ((context: JobContext) => Promise<ReadonlySet<string>>),
    ) {
      for (const entry of typeof enabled === 'function' ? jobs.all() : jobs.forModules(enabled)) {
        const handler: JobHandler = async (payload, context) => {
          const active = typeof enabled === 'function' ? await enabled(context) : enabled;
          if (!entry.moduleId || active.has(entry.moduleId)) await entry.handler(payload, context);
        };
        if (entry.cron) worker.schedule(entry.id, entry.cron, handler);
        else worker.handle(entry.id, handler);
      }
    },
  };
}
