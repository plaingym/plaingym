// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { AppError } from '@plaingym/shared';
import { joinCleanupJob, type createJoinCleanup } from './join.cleanup.js';

let cleanup: ReturnType<typeof createJoinCleanup> | undefined;
export function configureJoinCleanup(service: ReturnType<typeof createJoinCleanup>) { cleanup = service; }
export const jobs: readonly JobRegistration[] = [{ id: joinCleanupJob, cron: '29 3 * * *', lane: 'batch', async handler(_payload, context) {
  if (!cleanup) throw new AppError('unavailable', 'Join cleanup is not configured');
  await cleanup.run(context.gymId, context.timezone);
} }];
