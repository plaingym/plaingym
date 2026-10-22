// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRegistration } from '../../core/registry.js';
import { routes as part0 } from './members.routes.js';
import { routes as part1 } from './checkin-code.routes.js';

export const routes: readonly RouteRegistration[] = [...part0, ...part1];
