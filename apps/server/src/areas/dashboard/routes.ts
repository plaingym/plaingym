// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRegistration } from '../../core/registry.js';
import { routes as part0 } from './dashboard.routes.js';
import { routes as part1 } from './billing.routes.js';

export const routes: readonly RouteRegistration[] = [...part0, ...part1];
