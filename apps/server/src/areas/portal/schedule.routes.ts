// SPDX-License-Identifier: AGPL-3.0-only
import { portalContracts, portalScheduleContracts } from '@plaingym/shared/contracts';
import type { RouteRegistration } from '../../core/registry.js';
import { route } from '../../core/registry.js';
import { portalIdentity } from './auth.permissions.js';
import { createPortalScheduleService, type PortalScheduleService } from './schedule.js';

export function createPortalScheduleRoutes(service: PortalScheduleService = createPortalScheduleService()): RouteRegistration[] {
  const { schedule } = portalContracts, { members } = portalScheduleContracts;
  return [
    route({ ...schedule, request: { query: schedule.query }, responses: { 200: { description: 'Class schedule with my bookings', content: { 'application/json': { schema: schedule.response } } } } },
      async c => { c.header('Cache-Control', 'no-store'); return c.json(await service.sessions(portalIdentity(c.get('context')), c.req.valid('query')), 200); }),
    route({ ...members, responses: { 200: { description: 'Members I may book for', content: { 'application/json': { schema: members.response } } } } },
      async c => { c.header('Cache-Control', 'no-store'); return c.json({ data: await service.members(portalIdentity(c.get('context'))) }, 200); }),
  ];
}
export const routes: readonly RouteRegistration[] = createPortalScheduleRoutes();
