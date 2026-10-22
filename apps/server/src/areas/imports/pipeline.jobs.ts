// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { z } from 'zod';
import { idSchema } from '@plaingym/shared/contracts';
import { IMPORT_JOB, type ImportPipeline } from './pipeline.js';
const payloadSchema = z.strictObject({ id: idSchema });
export function createPipelineJobs(service: ImportPipeline): JobRegistration[] {
  return [{ id: IMPORT_JOB, handler: async (payload, context) => service.run(context.gymId, payloadSchema.parse(payload).id, context.attempt) }];
}

export const jobs: readonly JobRegistration[] = [];
