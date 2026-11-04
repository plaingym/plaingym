// SPDX-License-Identifier: AGPL-3.0-only
import type { ModuleDefinition } from '../../core/registry.js';
import { routes } from './routes.js';

export { configureWebsite } from './routes.js';
/** The optional public website. Its routes answer only while the gym has it on (`gyms.website_enabled`). */
export const websiteModule = {
  id: 'website',
  schemaFile: null,
  routes,
  jobs: [],
  emails: [],
  web: {},
} satisfies ModuleDefinition;
