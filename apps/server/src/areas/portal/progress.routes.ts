// SPDX-License-Identifier: AGPL-3.0-only
import { portalContracts } from '@plaingym/shared/contracts';
import type { RouteRegistration } from '../../core/registry.js';
import { route } from '../../core/registry.js';
import type { AttendanceQueries } from '../../core/interfaces/attendance.js';
import type { RanksService } from '../ranks/ranks.service.js';
import { portalIdentity } from './auth.permissions.js';
import { createPortalProgressService, type PortalProgressService } from './progress.js';

let configured: { ranks: RanksService; attendance: AttendanceQueries } | undefined;
/** Runtime passes a ranks service over its criterion registry and the shared attendance queries. */
export function configurePortalProgress(options: { ranks: RanksService; attendance: AttendanceQueries }) { configured = options; }
export function createPortalProgressRoutes(service: PortalProgressService = createPortalProgressService({
  ranks: () => configured?.ranks, attendance: () => configured?.attendance })): RouteRegistration[] {
  const { progress, attendance } = portalContracts;
  return [
    route({ ...progress, request: { params: progress.params }, responses: { 200: { description: 'Member rank progress', content: { 'application/json': { schema: progress.response } } } } },
      async c => {
        c.header('Cache-Control', 'no-store');
        const context = c.get('context');
        return c.json({ data: await service.progress(portalIdentity(context), c.req.valid('param').memberId, context.gym.enabledModules) }, 200);
      }),
    route({ ...attendance, request: { params: attendance.params, query: attendance.query }, responses: { 200: { description: 'Member attendance history', content: { 'application/json': { schema: attendance.response } } } } },
      async c => {
        c.header('Cache-Control', 'no-store');
        return c.json(await service.attendance(portalIdentity(c.get('context')), c.req.valid('param').memberId, c.req.valid('query')), 200);
      }),
  ];
}
export const routes: readonly RouteRegistration[] = createPortalProgressRoutes();
