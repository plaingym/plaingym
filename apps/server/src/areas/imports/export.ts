// SPDX-License-Identifier: AGPL-3.0-only
import { t } from './pipeline.messages.js';
import { forGym, uuidv7, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { exportDatasets, type ExportJob } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { Jobs } from '../../infra/jobs/index.js';
import { PipelineStore, type UploadsFor } from './pipeline.store.js';
import { exportCatalog } from './export.catalog.js';
import { csvLine } from './pipeline.csv.js';
import { archiveStream, type ArchiveEntry } from './export.zip.js';
export const EXPORT_JOB = 'imports.export';
export const EXPORT_EXPIRY_JOB = 'imports.export.expire';
const DOWNLOAD_LIFETIME = 60 * 60;
export function createExportService(options: { uploadsFor: UploadsFor; jobs: Jobs; scope?: typeof forGym; clock?: Clock }) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock, store = new PipelineStore(options.uploadsFor);
  const key = (gymId: string, id: string, file: string) => store.key(gymId, 'exports', id, file);
  async function* entries(gymId: string, cutoff: Date): AsyncGenerator<ArchiveEntry> {
    const encoder = new TextEncoder();
    for (const name of exportDatasets) {
      const dataset = exportCatalog[name], columns = Object.keys(dataset.columns);
      yield { name: name + '.csv', body: (async function* () {
        yield encoder.encode(csvLine(columns)); let after: string | undefined;
        while (true) {
          const rows = await dataset.page(scope, gymId, cutoff, after);
          if (!rows.length) break;
          // The database transaction has ended before a byte is sent to storage.
          yield encoder.encode(rows.map((row) => csvLine(columns.map((column) => row[column]))).join(''));
          after = String(rows.at(-1)!.id);
        }
      })() };
    }
  }
  return {
    async create(context: MutationContext, timezone: string): Promise<ExportJob> {
      const id = uuidv7(), job: ExportJob = { id, status: 'pending', datasets: [...exportDatasets], createdAt: clock.now().toISOString(),
        completedAt: null, downloadUrl: null, expiresAt: null };
      await scope(context.gymId, (tx) => writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
        ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}), action: 'exports.requested', targetType: 'export', targetId: id,
        after: { datasets: exportDatasets.length }, occurredAt: clock.now() }));
      await store.put(context.gymId, key(context.gymId, id, 'pending.json'), job);
      try { await options.jobs.enqueue(EXPORT_JOB, { id }, { gymId: context.gymId, timezone, idempotencyKey: id, maxAttempts: 1 }); }
      catch (error) {
        await store.put(context.gymId, key(context.gymId, id, 'finished.json'), { ...job, status: 'failed', completedAt: clock.now().toISOString() });
        throw error;
      }
      return job;
    },
    /**
     * Marks each archive deleted once its download link has expired, so the next sweep removes the exported
     * personal data. An archive whose run never finished expires a link lifetime after it was written.
     */
    async expire(gymId: string): Promise<number> {
      const uploads = await options.uploadsFor(gymId), prefix = `${gymId}/imports/exports/`, now = clock.now().getTime();
      let expired = 0;
      for (const info of await uploads.list(prefix)) {
        if (!info.key.endsWith('/export.zip') || info.deletedAt) continue;
        const id = info.key.slice(prefix.length, -'/export.zip'.length);
        const finished = await store.exists(gymId, key(gymId, id, 'finished.json'))
          ? await store.get<ExportJob>(gymId, key(gymId, id, 'finished.json')) : undefined;
        const expiresAt = finished?.expiresAt ? Date.parse(finished.expiresAt) : info.createdAt.getTime() + DOWNLOAD_LIFETIME * 1000;
        if (expiresAt <= now) { await uploads.markDeleted(info.key); expired++; }
      }
      return expired;
    },
    async get(gymId: string, id: string): Promise<ExportJob> {
      for (const state of ['finished', 'running', 'pending']) {
        if (await store.exists(gymId, key(gymId, id, state + '.json'))) {
          const job = await store.get<ExportJob>(gymId, key(gymId, id, state + '.json'));
          if (job.expiresAt && Date.parse(job.expiresAt) <= clock.now().getTime())
            throw new AppError('not_found', t('imports/export:expired'));
          return job;
        }
      }
      throw new AppError('not_found', t('imports/pipeline:notFound'));
    },
    async run(gymId: string, id: string): Promise<void> {
      const job = await store.get<ExportJob>(gymId, key(gymId, id, 'pending.json'));
      if (!(await store.claim(gymId, key(gymId, id, 'claim.json')))) return;
      await store.put(gymId, key(gymId, id, 'running.json'), { ...job, status: 'running' });
      const uploads = await options.uploadsFor(gymId), archiveKey = key(gymId, id, 'export.zip');
      try {
        await uploads.put(archiveKey, archiveStream(entries(gymId, new Date(job.createdAt))), 'application/zip');
        const downloadUrl = await uploads.signedUrl(archiveKey, DOWNLOAD_LIFETIME);
        if (!downloadUrl) throw new Error('Export download is unavailable');
        await store.put(gymId, key(gymId, id, 'finished.json'), { ...job, status: 'succeeded', completedAt: clock.now().toISOString(),
          downloadUrl, expiresAt: new Date(clock.now().getTime() + DOWNLOAD_LIFETIME * 1000).toISOString() });
      } catch (error) {
        await store.put(gymId, key(gymId, id, 'finished.json'), { ...job, status: 'failed', completedAt: clock.now().toISOString() });
        throw error;
      }
    },
  };
}
export type ExportService = ReturnType<typeof createExportService>;
