// SPDX-License-Identifier: AGPL-3.0-only
import type { Clock } from '@plaingym/shared';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { forGym, importRuns, importChunks, exportRuns } from '@plaingym/db';
import { clock as defaultClock } from '../../core/clock.js';
import type { JobRegistration } from '../../core/registry.js';
import type { UploadsFor } from './pipeline.store.js';

export const IMPORT_RETENTION_JOB = 'imports.retention';
/** How long an uploaded CSV stays usable; runs reject it after this anyway. */
export const UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How long run state, error reports, and legacy manifests stay after their last write. */
export const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Exports do not heartbeat their run row: allow two full days before declaring an abandoned run failed. */
export const EXPORT_STALE_MS = 48 * 60 * 60 * 1000;
const retention: Readonly<Record<string, number>> = { uploads: UPLOAD_RETENTION_MS, runs: RUN_RETENTION_MS, exports: RUN_RETENTION_MS };

/**
 * Marks pipeline files deleted once they have outlived their use, so the next upload sweep removes the member data
 * they hold: uploaded CSVs a day after upload, and import/export runs and legacy manifests 30 days
 * after their last write. A run or export is removed as a whole, so its status reads not-found, never half-deleted.
 * Export archives expire sooner, through `ExportService.expire`.
 */
export function createImportRetention(options: { uploadsFor: UploadsFor; clock?: Clock; scope?: typeof forGym }) {
  const clock = options.clock ?? defaultClock, scope = options.scope ?? forGym;
  return {
    async expire(gymId: string): Promise<number> {
      const now = clock.now(), cutoff = new Date(now.getTime() - RUN_RETENTION_MS);
      // A final expired job lease never calls the handler. Recover only table runs; legacy workers
      // keep their manifest protocol. Status predicates are rechecked after any concurrent finisher.
      await scope(gymId, async (tx) => {
        await tx.update(importRuns).set({ status: 'failed', completedAt: now, updatedAt: now })
          .where(and(eq(importRuns.gymId, gymId), inArray(importRuns.status, ['pending', 'running']),
            lte(importRuns.createdAt, new Date(now.getTime() - UPLOAD_RETENTION_MS))));
        await tx.update(exportRuns).set({ status: 'failed', completedAt: now, updatedAt: now })
          .where(and(eq(exportRuns.gymId, gymId), inArray(exportRuns.status, ['pending', 'running']),
            lte(exportRuns.updatedAt, new Date(now.getTime() - EXPORT_STALE_MS))));
      });
      const uploads = await options.uploadsFor(gymId), prefix = `${gymId}/imports/`;
      const groups = new Map<string, { kind: string; id: string; keys: string[]; newest: number; stored?: boolean }>();
      for (const info of await uploads.list(prefix)) {
        const [kind, id] = info.key.slice(prefix.length).split('/');
        if (!kind || !id || retention[kind] === undefined) continue;
        const group = groups.get(kind + '/' + id) ?? { kind, id, keys: [], newest: 0 };
        group.newest = Math.max(group.newest, info.createdAt.getTime());
        if (!info.deletedAt) group.keys.push(info.key);
        groups.set(kind + '/' + id, group);
      }
      // New imports have no run files at all. Updated timestamps, rather than source upload times,
      // retain their progress and issues, and keep export state and archive files on one deadline.
      const runs = await scope(gymId, async (tx) => [
        ...(await tx.select({ id: importRuns.id, updatedAt: importRuns.updatedAt }).from(importRuns)
          .where(and(eq(importRuns.gymId, gymId), lte(importRuns.updatedAt, cutoff)))).map((row) => ({ ...row, kind: 'runs' })),
        ...(await tx.select({ id: exportRuns.id, updatedAt: exportRuns.updatedAt }).from(exportRuns)
          .where(and(eq(exportRuns.gymId, gymId), lte(exportRuns.updatedAt, cutoff)))).map((row) => ({ ...row, kind: 'exports' })),
      ]);
      for (const row of runs) {
        const group = groups.get(row.kind + '/' + row.id) ?? { kind: row.kind, id: row.id, keys: [], newest: 0 };
        group.newest = Math.max(group.newest, row.updatedAt.getTime()); group.stored = true;
        groups.set(row.kind + '/' + row.id, group);
      }
      let expired = 0;
      for (const group of groups.values()) {
        if ((!group.keys.length && !group.stored) || group.newest + retention[group.kind]! > now.getTime()) continue;
        if (group.kind === 'runs' || group.kind === 'exports') {
          const table = group.kind === 'runs' ? importRuns : exportRuns;
          const removed = await scope(gymId, async (tx) => {
            const condition = and(eq(table.gymId, gymId), eq(table.id, group.id));
            const [row] = await tx.select({ id: table.id, updatedAt: table.updatedAt }).from(table).where(condition).for('update');
            // File-only candidates can belong to fresh table runs omitted by the indexed scan.
            // Recheck under the row lock, preserving the whole export even if its files are old.
            if (!row) return !group.stored;
            if (row.updatedAt > cutoff) return false;
            if (group.kind === 'runs') await tx.delete(importChunks)
              .where(and(eq(importChunks.gymId, gymId), eq(importChunks.runId, group.id)));
            await tx.delete(table).where(condition);
            return true;
          });
          if (!removed) continue;
        }
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
