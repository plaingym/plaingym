// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRegistration } from '../../core/registry.js';
import { routes as part0 } from './pipeline.routes.js';
import { routes as part1 } from './export.routes.js';
import { routes as part2 } from './mappers/people.routes.js';
import { routes as part3 } from './mappers/mat.routes.js';
import { routes as part4 } from './mappers/memberships.routes.js';

export const routes: readonly RouteRegistration[] = [...part0, ...part1, ...part2, ...part3, ...part4];
