// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { z } from 'zod';
import { idSchema } from '@plaingym/shared/contracts';
import { EXPORT_JOB, type ExportService } from './export.js';
const payloadSchema = z.strictObject({ id: idSchema });
export function createExportJobs(service: ExportService): JobRegistration[] {
  return [{ id: EXPORT_JOB, handler: async (payload, context) => service.run(context.gymId, payloadSchema.parse(payload).id) }];
}

export const jobs: readonly JobRegistration[] = [];
