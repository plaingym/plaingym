// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRegistration } from '../../core/registry.js';
import { routes as part0 } from './auth.routes.js';
import { routes as part1 } from './access.routes.js';
import { routes as part2 } from './bookings.routes.js';
import { routes as part3 } from './schedule.routes.js';
import { routes as part4 } from './checkin.routes.js';
import { routes as part5 } from './progress.routes.js';
import { routes as part6 } from './billing.routes.js';
import { routes as part7 } from './waivers.routes.js';
import { routes as part8 } from './household.routes.js';

export const routes: readonly RouteRegistration[] = [
  ...part0,
  ...part1,
  ...part2,
  ...part3,
  ...part4,
  ...part5,
  ...part6,
  ...part7,
  ...part8,
];
