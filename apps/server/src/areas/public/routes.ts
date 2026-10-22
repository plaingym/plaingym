// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRegistration } from '../../core/registry.js';
import { routes as part0 } from '../../public/pages/pages.routes.js';
import { routes as part1 } from '../../public/pages/join.routes.js';
import { routes as part2 } from '../../public/links/links.routes.js';

export const routes: readonly RouteRegistration[] = [...part0, ...part1, ...part2];
