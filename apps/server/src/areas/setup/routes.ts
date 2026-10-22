// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRegistration } from '../../core/registry.js';
import { routes as part0 } from './setup.routes.js';
import { routes as part1 } from './import-step.routes.js';
import { routes as part2 } from './stripe-step.routes.js';

export const routes: readonly RouteRegistration[] = [...part0, ...part1, ...part2];
