// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { createScheduleService } from './schedule.js';

export function createScheduleJobs(service = createScheduleService()): readonly JobRegistration[] {
  return [{ id: 'schedule.materialize', cron: '0 0 * * *', async handler(_payload, context) {
    await service.materialize(context.gymId, context.timezone, context.clock);
  } }];
}
export const jobs = createScheduleJobs();
