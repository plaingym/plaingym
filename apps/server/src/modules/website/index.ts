// SPDX-License-Identifier: AGPL-3.0-only
import type { ModuleDefinition } from '../../core/registry.js';
import { routes, settingsRoutes } from './routes.js';

export { configureWebsite } from './routes.js';
/** Public routes require the gym's switch; authenticated preparation remains available while it is off. */
export const websiteModule = {
  id: 'website',
  schemaFile: null,
  routes,
  settingsRoutes,
  jobs: [],
  emails: [],
  web: {},
} satisfies ModuleDefinition;
