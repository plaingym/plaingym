// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { z } from 'zod';
import { idSchema } from '@plaingym/shared/contracts';
import { EXPORT_EXPIRY_JOB, EXPORT_JOB, type ExportService } from './export.js';
const payloadSchema = z.strictObject({ id: idSchema });
export function createExportJobs(service: ExportService): JobRegistration[] {
  // An export runs in the jobs batch lane, so the gym's webhooks and notices never wait behind one.
  return [{ id: EXPORT_JOB, lane: 'batch', handler: async (payload, context) => service.run(context.gymId, payloadSchema.parse(payload).id) },
    // Hourly, matching the one-hour download lifetime.
    { id: EXPORT_EXPIRY_JOB, cron: '17 * * * *', handler: async (_payload, context) => { await service.expire(context.gymId); } }];
}

export const jobs: readonly JobRegistration[] = [];
