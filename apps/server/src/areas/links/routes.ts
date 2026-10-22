// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRegistration } from '../../core/registry.js';
import { routes as part0 } from './service.routes.js';
import { routes as part1 } from './campaigns.routes.js';

export const routes: readonly RouteRegistration[] = [...part0, ...part1];
