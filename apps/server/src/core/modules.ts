// SPDX-License-Identifier: AGPL-3.0-only
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { GymSettingsAccessor } from './interfaces/gym-settings.js';
import type { RequestEnvironment } from './context.js';
import type { PermissionMiddleware } from './registry.js';
import { createServerRegistry } from './registry.js';
import type { Jobs } from '../infra/jobs/index.js';
export function enabledModules(settings: { websiteEnabled: boolean }): ReadonlySet<string> {
  return new Set(settings.websiteEnabled ? ['website'] : []);
}
/** The caller supplies module definitions; core never imports a feature module. */
export function mountModules(registry: ReturnType<typeof createServerRegistry>, app: OpenAPIHono<RequestEnvironment>, authorize: PermissionMiddleware) {
  registry.mount(app, authorize, (context) => context.get('context').gym.enabledModules);
}
export function registerModuleJobs(registry: ReturnType<typeof createServerRegistry>, worker: Jobs, settings: GymSettingsAccessor) {
  registry.registerJobs(worker, async (context) => context.gymId ? enabledModules(await settings.get(context.gymId)) : new Set());
}
