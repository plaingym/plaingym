// SPDX-License-Identifier: AGPL-3.0-only
import type { RouteRegistration } from '../../core/registry.js';
import { routes as funnelRoutes } from './funnel.routes.js';

export const routes: readonly RouteRegistration[] = [...funnelRoutes];
