// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRegistration } from '../../core/registry.js';
import { routes as part0 } from './backups.routes.js';
import { routes as part1 } from './restore.routes.js';
import { routes as part2 } from './status.routes.js';
import { routes as part3 } from './stripe.routes.js';
import { routes as part4 } from './charge-run.routes.js';
import { routes as part5 } from './auto-update.routes.js';
import { routes as part6 } from './updates.routes.js';

export const routes: readonly RouteRegistration[] = [
  ...part0,
  ...part1,
  ...part2,
  ...part3,
  ...part4,
  ...part5,
  ...part6,
];
