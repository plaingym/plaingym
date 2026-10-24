// SPDX-License-Identifier: AGPL-3.0-only
import type { Clock } from '@plaingym/shared';
import { clock as defaultClock } from '../../core/clock.js';
import type { JobRegistration } from '../../core/registry.js';
import type { UploadsFor } from './pipeline.store.js';

export const IMPORT_RETENTION_JOB = 'imports.retention';
/** How long an uploaded CSV stays usable; runs reject it after this anyway. */
export const UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How long a run's manifests and error reports, and an export's manifests, stay after their last write. */
export const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const retention: Readonly<Record<string, number>> = { uploads: UPLOAD_RETENTION_MS, runs: RUN_RETENTION_MS, exports: RUN_RETENTION_MS };

/**
 * Marks pipeline files deleted once they have outlived their use, so the next upload sweep removes the member data
 * they hold: uploaded CSVs a day after upload, and import runs (state, error reports) and export manifests 30 days
 * after their last write. A run or export is removed as a whole, so its status reads not-found, never half-deleted.
 * Export archives expire sooner, through `ExportService.expire`.
 */
export function createImportRetention(options: { uploadsFor: UploadsFor; clock?: Clock }) {
  const clock = options.clock ?? defaultClock;
  return {
    async expire(gymId: string): Promise<number> {
      const uploads = await options.uploadsFor(gymId), prefix = `${gymId}/imports/`, now = clock.now().getTime();
      const groups = new Map<string, { kind: string; keys: string[]; newest: number }>();
      for (const info of await uploads.list(prefix)) {
        const [kind, id] = info.key.slice(prefix.length).split('/');
        if (!kind || !id || retention[kind] === undefined) continue;
        const group = groups.get(kind + '/' + id) ?? { kind, keys: [], newest: 0 };
        group.newest = Math.max(group.newest, info.createdAt.getTime());
        if (!info.deletedAt) group.keys.push(info.key);
        groups.set(kind + '/' + id, group);
      }
      let expired = 0;
      for (const group of groups.values()) {
        if (!group.keys.length || group.newest + retention[group.kind]! > now) continue;
        for (const key of group.keys) await uploads.markDeleted(key);
        expired++;
      }
      return expired;
    },
  };
}
export function createImportRetentionJobs(service: ReturnType<typeof createImportRetention>): JobRegistration[] {
  return [{ id: IMPORT_RETENTION_JOB, cron: '23 * * * *', handler: async (_payload, context) => { await service.expire(context.gymId); } }];
}
