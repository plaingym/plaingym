// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { attendanceContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestContext } from '../../core/context.js';
import { createAttendanceService } from './attendance.js';

function staff(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
    throw new AppError('not_found', 'Resource not found');
  return { gymId: context.gym.gymId, actor: { kind: 'user' as const, userId: context.principal.userId } };
}
export function createAttendanceRoutes(service = createAttendanceService()) {
  const { record, list, totals } = attendanceContracts;
  return [
    route({ ...record, request: { body: { required: true, content: { 'application/json': { schema: record.body } } } },
      responses: { 200: { description: 'Recorded attendance', content: { 'application/json': { schema: record.response } } } },
    }, async (c) => c.json({ data: await service.record(staff(c.get('context')), c.req.valid('json')) }, 200)),
    route({ ...list, request: { query: list.query },
      responses: { 200: { description: 'Attendance history', content: { 'application/json': { schema: list.response } } } },
    }, async (c) => c.json(await service.list(staff(c.get('context')).gymId, c.req.valid('query')), 200)),
    route({ ...totals, request: { query: totals.query },
      responses: { 200: { description: 'Attendance totals', content: { 'application/json': { schema: totals.response } } } },
    }, async (c) => c.json({ data: await service.totals(staff(c.get('context')).gymId, c.req.valid('query')) }, 200)),
  ];
}
export const routes = createAttendanceRoutes();
