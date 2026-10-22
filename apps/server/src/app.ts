// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { createApp } from './core/app.js';
import { areaContributions } from './core/registry-areas.js';

export { createApp, type AppOptions } from './core/app.js';

// A closed app for in-process tests: no gym resolves and every route is denied. The
// production server is composed in core/runtime.ts.
export const app = createApp({
  contributions: areaContributions,
  resolveGym: () => { throw new AppError('not_found', 'Gym not found.'); },
  session: async (_context, next) => { await next(); },
  authorize: () => () => { throw new AppError('forbidden', 'Access denied.'); },
});
