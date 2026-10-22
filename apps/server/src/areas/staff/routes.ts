// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRegistration } from '../../core/registry.js';
import { routes as part0 } from './auth.routes.js';
import { routes as part1 } from './profiles.routes.js';

export const routes: readonly RouteRegistration[] = [...part0, ...part1];
