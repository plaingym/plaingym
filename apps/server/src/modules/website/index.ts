// SPDX-License-Identifier: AGPL-3.0-only
import type { ModuleDefinition } from '../../core/registry.js';

export const websiteModule = {
  id: 'website',
  schemaFile: null,
  routes: [],
  jobs: [],
  emails: [],
  web: {},
} satisfies ModuleDefinition;
