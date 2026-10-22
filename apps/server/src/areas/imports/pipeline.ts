// SPDX-License-Identifier: AGPL-3.0-only
import { t } from './pipeline.messages.js';
import { and, eq } from 'drizzle-orm';
import { forGym, auditEvents, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { importPlanRequestSchema, startImportRequestSchema, type ImportUpload, type ImportJob, type ImportIssue,
  type ImportPlanRequest, type Pagination, type StartImportRequest } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { Jobs } from '../../infra/jobs/index.js';
import { parseCsv, autoMatch, MAX_CSV_BYTES, type CsvDocument } from './pipeline.csv.js';
import { PipelineStore, type UploadsFor } from './pipeline.store.js';
import { MapperRegistry, type MapperContext, type PlannedRow } from './mappers/registry.js';
import { peopleMapper } from './mappers/people.js';
import { matMapper } from './mappers/mat.js';
import { membershipsMapper } from './mappers/memberships.js';

export const IMPORT_JOB = 'imports.pipeline';
export const IMPORT_CHUNK_SIZE = 100;
const LIFETIME = 24 * 60 * 60 * 1000;
interface StoredRun { job: ImportJob; input: StartImportRequest; actor: MutationContext['actor']; chunkIds: string[] }
interface ChunkResult { count: number; issues: ImportIssue[] }
export interface PipelineOptions { uploadsFor: UploadsFor; jobs: Jobs; scope?: typeof forGym; clock?: Clock; mappers?: MapperRegistry }
export function createImportPipeline(options: PipelineOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const store = new PipelineStore(options.uploadsFor);
  const mappers = options.mappers ?? new MapperRegistry([peopleMapper, matMapper, membershipsMapper]);
  const key = (gymId: string, id: string, file: string) => store.key(gymId, 'runs', id, file);
  const stateKey = (gymId: string, id: string, index: number) => key(gymId, id, `state-${String(index).padStart(8, '0')}.json`);
  async function load(gymId: string, plan: ImportPlanRequest): Promise<CsvDocument> {
    const meta = await store.get<ImportUpload>(gymId, store.key(gymId, 'uploads', plan.uploadId, 'meta.json'));
    if (Date.parse(meta.expiresAt) <= clock.now().getTime()) throw new AppError('not_found', t('imports/pipeline:notFound'));
    if (new Set(plan.mapping.map((item) => item.sourceColumn)).size !== plan.mapping.length
      || plan.mapping.some((item) => !meta.columns.includes(item.sourceColumn)))
      throw new AppError('invalid_request', t('imports/pipeline:invalidMapping'));
    const body = await (await options.uploadsFor(gymId)).get(store.key(gymId, 'uploads', plan.uploadId, 'source.csv'));
    if (!body) throw new AppError('not_found', t('imports/pipeline:notFound'));
    return parseCsv(await new Response(body).text());
  }
  function policy(rows: PlannedRow[], plan: ImportPlanRequest): PlannedRow[] {
    return rows.map((row) => {
      if (!row.duplicateIds.length || row.issues.length) return row;
      if (plan.duplicatePolicy === 'skip') return { ...row, action: 'skip' };
      if (plan.duplicatePolicy === 'update' && row.duplicateIds.length === 1) return { ...row, action: 'update' };
      return { ...row, action: 'error', issues: [{ rowNumber: row.rowNumber, column: null, code: 'duplicate', message: t('imports/pipeline:duplicate') }] };
    });
  }
  async function analyze(document: CsvDocument, plan: ImportPlanRequest, context: MapperContext): Promise<PlannedRow[]> {
    const result: PlannedRow[] = [], mapper = mappers.get(plan.mapper);
    for (let i = 0; i < document.rows.length; i += IMPORT_CHUNK_SIZE) {
      const rows = document.rows.slice(i, i + IMPORT_CHUNK_SIZE);
      const planned = await scope(context.gymId, (tx) => mapper.analyze(tx, rows, plan, context));
      if (planned.length !== rows.length || planned.some((row, index) => row.rowNumber !== rows[index]!.rowNumber))
        throw new Error('Mapper must return one result per source row in order');
      result.push(...policy(planned, plan));
    }
    return result;
  }
  async function get(gymId: string, id: string): Promise<ImportJob> {
    const files = await (await options.uploadsFor(gymId)).list(key(gymId, id, 'state-'));
    const latest = files.filter((file) => !file.deletedAt).sort((a, b) => b.key.localeCompare(a.key))[0];
    if (!latest) throw new AppError('not_found', t('imports/pipeline:notFound'));
    return store.get<ImportJob>(gymId, latest.key);
  }
  return {
    async upload(context: MutationContext, file: File): Promise<ImportUpload> {
      if (!file.size || file.size > MAX_CSV_BYTES) throw new AppError('invalid_request', t('imports/pipeline:invalidCsv'));
      const bytes = new Uint8Array(await file.arrayBuffer());
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new AppError('invalid_request', t('imports/pipeline:invalidCsv')); }
      const document = parseCsv(text), id = uuidv7(), mapping = autoMatch(document.columns);
      const data: ImportUpload = { id, filename: file.name.replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 255) || 'import.csv',
        rowCount: document.rows.length, columns: document.columns, suggestedMapping: mapping.length ? mapping : null,
        expiresAt: new Date(clock.now().getTime() + LIFETIME).toISOString() };
      await (await options.uploadsFor(context.gymId)).put(store.key(context.gymId, 'uploads', id, 'source.csv'), bytes, 'text/csv');
      await store.put(context.gymId, store.key(context.gymId, 'uploads', id, 'meta.json'), data);
      await scope(context.gymId, (tx) => writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
        ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}), action: 'imports.uploaded', targetType: 'import', targetId: id,
        after: { rowCount: data.rowCount }, occurredAt: clock.now() }));
      return data;
    },
    async preview(context: MutationContext, input: ImportPlanRequest, page: Pagination) {
      const plan = importPlanRequestSchema.parse(input), document = await load(context.gymId, plan);
      const rows = await analyze(document, plan, { ...context, clock, runId: uuidv7(), sourceRows: document.rows });
      const summary = { totalRows: rows.length, create: 0, update: 0, skip: 0, errors: 0 };
      for (const row of rows) { if (row.action === 'error') summary.errors++; else summary[row.action]++; }
      return { data: rows.slice(page.offset, page.offset + page.limit).map(({ issues: _issues, ...row }) => row),
        pagination: { ...page, total: rows.length }, summary };
    },
    async start(context: MutationContext, input: StartImportRequest, timezone: string): Promise<ImportJob> {
      input = startImportRequestSchema.parse(input);
      const document = await load(context.gymId, input), id = uuidv7();
      const job: ImportJob = { id, uploadId: input.uploadId, mapper: input.mapper, dryRun: input.dryRun, status: 'pending',
        totalRows: document.rows.length, processedRows: 0, committedRows: 0, errorCount: 0, createdAt: clock.now().toISOString(), completedAt: null };
      const chunkIds = Array.from({ length: Math.ceil(document.rows.length / IMPORT_CHUNK_SIZE) }, () => uuidv7());
      await store.put(context.gymId, key(context.gymId, id, 'run.json'), { job, input, actor: context.actor, chunkIds } satisfies StoredRun);
      await store.put(context.gymId, stateKey(context.gymId, id, 0), job);
      if (!input.dryRun) await scope(context.gymId, (tx) => writeAudit(tx, { id, gymId: context.gymId, actorKind: context.actor.kind,
        ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}), action: 'imports.started', targetType: 'import', targetId: id,
        after: { totalRows: job.totalRows }, occurredAt: clock.now() }));
      try { await options.jobs.enqueue(IMPORT_JOB, { id }, { gymId: context.gymId, timezone, idempotencyKey: id, maxAttempts: 5 }); }
      catch (error) {
        await store.put(context.gymId, stateKey(context.gymId, id, 99999999), { ...job, status: 'failed', completedAt: clock.now().toISOString() });
        throw error;
      }
      return job;
    },
    get,
    async errors(gymId: string, id: string, page: Pagination) {
      await get(gymId, id);
      const files = await (await options.uploadsFor(gymId)).list(key(gymId, id, 'issues-'));
      const issues: ImportIssue[] = [];
      for (const file of files.filter((file) => !file.deletedAt).sort((a, b) => a.key.localeCompare(b.key)))
        issues.push(...await store.get<ImportIssue[]>(gymId, file.key));
      return { data: issues.slice(page.offset, page.offset + page.limit), pagination: { ...page, total: issues.length } };
    },
    async run(gymId: string, id: string, attempt = 1): Promise<void> {
      const saved = await store.get<StoredRun>(gymId, key(gymId, id, 'run.json'));
      if (await store.exists(gymId, stateKey(gymId, id, 99999999))) return;
      const job = { ...saved.job, status: 'running' as ImportJob['status'] };
      await store.putOnce(gymId, stateKey(gymId, id, 1), job);
      try {
        const document = await load(gymId, saved.input), mapper = mappers.get(saved.input.mapper);
        const context: MapperContext = { gymId, actor: saved.actor, clock, runId: id, sourceRows: document.rows };
        for (let i = 0; i < document.rows.length; i += IMPORT_CHUNK_SIZE) {
          const source = document.rows.slice(i, i + IMPORT_CHUNK_SIZE);
          let result: ChunkResult;
          const chunkId = saved.chunkIds[i / IMPORT_CHUNK_SIZE]!;
          // TODO(CCR): audit rows temporarily provide atomic chunk checkpoints.
          // No CSV values are stored here. A chunk checkpoint and its domain writes commit together.
          const checkpoint = async (tx: Transaction, result: ChunkResult) => {
            if (!saved.input.dryRun) await writeAudit(tx, { id: chunkId, gymId, actorKind: context.actor.kind,
              ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}), action: 'imports.chunk.committed',
              targetType: 'import', targetId: id, after: { offset: i, ...result }, occurredAt: clock.now() });
            return result;
          };
          const existing = async (tx: Transaction) => {
            const [row] = await tx.select({ result: auditEvents.after }).from(auditEvents)
              .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.id, chunkId)));
            return row ? row.result as ChunkResult : undefined;
          };
          try {
            result = await scope(gymId, async (tx) => {
              if (!saved.input.dryRun) { const prior = await existing(tx); if (prior) return prior; }
              const planned = policy(await mapper.analyze(tx, source, saved.input, context), saved.input);
              if (planned.length !== source.length || planned.some((row, index) => row.rowNumber !== source[index]!.rowNumber))
                throw new Error('Invalid mapper results');
              const valid = planned.filter((row) => !row.issues.length && (row.action === 'create' || row.action === 'update'));
              const count = saved.input.dryRun || !valid.length ? 0 : await mapper.commit(tx, valid, context);
              if (!Number.isInteger(count) || count < 0 || count > valid.length) throw new Error('Invalid mapper commit count');
              return checkpoint(tx, { count, issues: planned.flatMap((row) => row.issues) });
            });
          } catch {
            // The entire short transaction rolled back. Never echo SQL or uploaded PII.
            result = { count: 0, issues: source.map((row) => ({ rowNumber: row.rowNumber, column: null,
              code: 'conflict', message: t('imports/pipeline:chunkFailed') })) };
            if (!saved.input.dryRun) {
              try { result = await scope(gymId, async (tx) => await existing(tx) ?? await checkpoint(tx, result)); }
              catch (error) {
                // A racing delivery may have committed the checkpoint while our insert waited.
                // Its unique ID rolls back every domain write from the losing transaction.
                const prior = await scope(gymId, existing);
                if (!prior) throw error;
                result = prior;
              }
            }
          }
          if (result.issues.length) await store.putOnce(gymId, key(gymId, id, `issues-${String(i).padStart(8, '0')}.json`), result.issues);
          job.processedRows += source.length; job.committedRows += result.count; job.errorCount += result.issues.length;
          await store.putOnce(gymId, stateKey(gymId, id, 2 + i / IMPORT_CHUNK_SIZE), job);
          // Let other requests run between transactions, even with an in-memory storage adapter.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        job.status = job.errorCount ? 'failed' : 'succeeded';
      } catch (error) {
        if (attempt >= 5) await store.putOnce(gymId, stateKey(gymId, id, 99999999), { ...job, status: 'failed', completedAt: clock.now().toISOString() });
        throw error;
      }
      job.completedAt = clock.now().toISOString();
      await store.putOnce(gymId, stateKey(gymId, id, 99999999), job);
    },
  };
}
export type ImportPipeline = ReturnType<typeof createImportPipeline>;
