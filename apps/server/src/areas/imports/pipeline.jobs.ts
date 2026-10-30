// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { z } from 'zod';
import { idSchema } from '@plaingym/shared/contracts';
import { IMPORT_JOB, type ImportPipeline } from './pipeline.js';
const payloadSchema = z.strictObject({ id: idSchema });
/** Imports run in the jobs batch lane, so the gym's webhooks and notices never wait behind one. */
export const importBatchJobs = [IMPORT_JOB] as const;
export function createPipelineJobs(service: ImportPipeline): JobRegistration[] {
  return [{ id: IMPORT_JOB, handler: async (payload, context) => service.run(context.gymId, payloadSchema.parse(payload).id, context.attempt) }];
}

export const jobs: readonly JobRegistration[] = [];
