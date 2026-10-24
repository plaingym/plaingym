// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import type { Uploads } from '../../infra/storage/index.js';

export const UPLOAD_SWEEP_JOB = 'health.uploads.sweep';
/** How long a file marked deleted stays readable before a sweep without backups removes it. */
export const UPLOAD_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Backup pruning sweeps uploads under the backup lock, protecting every file a retained snapshot needs.
 * Without configured backups nothing else sweeps, so files marked deleted (replaced photos, expired exports)
 * would stay forever: this daily job removes them after a grace period, under the backup lock when one exists.
 */
export function createUploadSweepJobs(options: {
  readonly uploadsFor: (gymId: string) => Promise<Uploads>;
  readonly backupsConfigured: () => Promise<boolean>;
  readonly locked?: <T>(action: () => Promise<T>) => Promise<T>;
}): JobRegistration[] {
  return [{ id: UPLOAD_SWEEP_JOB, cron: '40 3 * * *', async handler(_payload, context) {
    if (await options.backupsConfigured()) return;
    const sweep = async () => (await options.uploadsFor(context.gymId))
      .sweep({ before: new Date(context.clock.now().getTime() - UPLOAD_SWEEP_GRACE_MS) });
    await (options.locked ? options.locked(sweep) : sweep());
  } }];
}
