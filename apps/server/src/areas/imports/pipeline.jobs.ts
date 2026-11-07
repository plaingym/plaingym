// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { z } from 'zod';
import { idSchema } from '@plaingym/shared/contracts';
import { IMPORT_JOB, type ImportPipeline } from './pipeline.js';
// Read from a stored job: a newer release may add keys, which this one ignores after a rollback.
export const importPayloadSchema = z.object({ id: idSchema });
export function createPipelineJobs(service: ImportPipeline): JobRegistration[] {
  // An import runs in the jobs batch lane, so the gym's webhooks and notices never wait behind one.
  return [{ id: IMPORT_JOB, lane: 'batch', handler: async (payload, context) => service.run(context.gymId, importPayloadSchema.parse(payload).id, context.attempt) }];
}

export const jobs: readonly JobRegistration[] = [];
