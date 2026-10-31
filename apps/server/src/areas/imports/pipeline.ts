// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { t } from './pipeline.messages.js';
import { and, asc, count, eq, max } from 'drizzle-orm';
import { forGym, auditEvents, importRuns, importChunks, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { importPlanRequestSchema, startImportRequestSchema, type ImportUpload, type ImportJob, type ImportIssue,
  type ImportPlanRequest, type ImportPreviewRow, type Pagination, type StartImportRequest } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { Jobs } from '../../infra/jobs/index.js';
import type { Uploads } from '../../infra/storage/index.js';
import { parseCsv, autoMatch, MAX_CSV_BYTES, type CsvDocument } from './pipeline.csv.js';
import { PipelineStore, type UploadsFor } from './pipeline.store.js';
import { MapperRegistry, type MapperContext, type PlannedRow } from './mappers/registry.js';
import { peopleMapper } from './mappers/people.js';
import { matMapper } from './mappers/mat.js';
import { membershipsMapper } from './mappers/memberships.js';

export const IMPORT_JOB = 'imports.pipeline';
export const IMPORT_CHUNK_SIZE = 100;
const LIFETIME = 24 * 60 * 60 * 1000;
/** A stored preview is a snapshot of the gym's existing members: pages come from it for five minutes, then it is computed again. */
export const PREVIEW_LIFETIME = 5 * 60 * 1000;
/** Rows per stored preview file: 20 files for a 100,000-row upload, and a page of at most 100 rows reads two files at most. */
export const PREVIEW_FILE_ROWS = 5_000;
interface PreviewSummary { totalRows: number; create: number; update: number; skip: number; errors: number }
/**
 * Written last, after its `files` row files under `pages/<generation>/`. `startedAt` is when the computation began, after the
 * request read the gym's import revision (kept for the record: staleness goes through the revision in the key). `createdAt` is
 * when it finished, and the preview is served for `PREVIEW_LIFETIME` from then.
 */
interface StoredPreview extends PreviewSummary { generation: string; files: number; startedAt: string; createdAt: string }
/** `timezone` is fixed when the run starts; runs saved before it was recorded read offset-free values as UTC, as their dry runs did. */
interface StoredRun { job: ImportJob; input: StartImportRequest; actor: MutationContext['actor']; chunkIds: string[]; timezone?: string }
interface ChunkResult { count: number; issues: ImportIssue[] }
type Run = typeof importRuns.$inferSelect;
function runJob(run: Run): ImportJob {
  return { id: run.id, uploadId: run.input.uploadId, mapper: run.input.mapper, dryRun: run.dryRun, status: run.status,
    totalRows: run.totalRows, processedRows: run.processedRows, committedRows: run.committedRows, errorCount: run.errorCount,
    createdAt: run.createdAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null };
}
export interface PipelineOptions { uploadsFor: UploadsFor; jobs: Jobs; scope?: typeof forGym; clock?: Clock; mappers?: MapperRegistry }
export function createImportPipeline(options: PipelineOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const store = new PipelineStore(options.uploadsFor);
  const mappers = options.mappers ?? new MapperRegistry([peopleMapper, matMapper, membershipsMapper]);
  const key = (gymId: string, id: string, file: string) => store.key(gymId, 'runs', id, file);
  const stateKey = (gymId: string, id: string, index: number) => key(gymId, id, `state-${String(index).padStart(8, '0')}.json`);
  const runWhere = (gymId: string, id: string) => and(eq(importRuns.gymId, gymId), eq(importRuns.id, id));
  const findRun = (gymId: string, id: string) => scope(gymId, async (tx) =>
    (await tx.select().from(importRuns).where(runWhere(gymId, id)))[0]);
  const sourceKey = (gymId: string, uploadId: string) => store.key(gymId, 'uploads', uploadId, 'source.csv');
  /**
   * The upload's metadata, if it is still usable with this plan. Reads no CSV bytes. A deleted upload (expired, or removed by a
   * restore) is not found.
   */
  async function loadMeta(gymId: string, plan: ImportPlanRequest): Promise<ImportUpload> {
    const meta = await store.get<ImportUpload>(gymId, store.key(gymId, 'uploads', plan.uploadId, 'meta.json'));
    if (Date.parse(meta.expiresAt) <= clock.now().getTime()) throw new AppError('not_found', t('imports/pipeline:notFound'));
    if (new Set(plan.mapping.map((item) => item.sourceColumn)).size !== plan.mapping.length
      || plan.mapping.some((item) => !meta.columns.includes(item.sourceColumn)))
      throw new AppError('invalid_request', t('imports/pipeline:invalidMapping'));
    return meta;
  }
  /** The upload's CSV, once its metadata has been checked. */
  async function loadSource(gymId: string, uploadId: string): Promise<CsvDocument> {
    const body = await (await options.uploadsFor(gymId)).get(sourceKey(gymId, uploadId));
    if (!body) throw new AppError('not_found', t('imports/pipeline:notFound'));
    return parseCsv(await new Response(body).text());
  }
  async function load(gymId: string, plan: ImportPlanRequest): Promise<CsvDocument> {
    await loadMeta(gymId, plan);
    return loadSource(gymId, plan.uploadId);
  }
  function policy(rows: PlannedRow[], plan: ImportPlanRequest): PlannedRow[] {
    return rows.map((row) => {
      if (!row.duplicateIds.length || row.issues.length) return row;
      if (plan.duplicatePolicy === 'skip') return { ...row, action: 'skip' };
      if (plan.duplicatePolicy === 'update' && row.duplicateIds.length === 1) return { ...row, action: 'update' };
      return { ...row, action: 'error', issues: [{ rowNumber: row.rowNumber, column: null, code: 'duplicate', message: t('imports/pipeline:duplicate') }] };
    });
  }
  /** Analyzes the document one chunk at a time, so a caller never holds every planned row at once. */
  async function* analyze(document: CsvDocument, plan: ImportPlanRequest, context: MapperContext): AsyncGenerator<PlannedRow[]> {
    const mapper = mappers.get(plan.mapper);
    for (let i = 0; i < document.rows.length; i += IMPORT_CHUNK_SIZE) {
      const rows = document.rows.slice(i, i + IMPORT_CHUNK_SIZE);
      const planned = await scope(context.gymId, (tx) => mapper.analyze(tx, rows, plan, context));
      if (planned.length !== rows.length || planned.some((row, index) => row.rowNumber !== rows[index]!.rowNumber))
        throw new Error('Mapper must return one result per source row in order');
      yield policy(planned, plan);
    }
  }
  // A preview is stored per upload, plan, timezone and import revision under the upload's own prefix, so retention removes it
  // with the upload. Every computation writes its rows to a new `pages/<generation>/` (keys are immutable), then a summary last
  // at `<bucket>/summary.json`, where the bucket is the finish time divided by `PREVIEW_LIFETIME`. A reader computes that key for
  // the current and the previous bucket and never lists storage: a page costs at most two summary reads (none once this process
  // remembers the summary) and the one or two row files it spans. A crashed or failed computation leaves only row files under its
  // own generation, so it never blocks one after it.
  const bucketOf = (time: Date) => Math.floor(time.getTime() / PREVIEW_LIFETIME);
  const planPrefix = (gymId: string, plan: ImportPlanRequest, timezone: string, revision: string) => store.key(gymId, 'uploads', plan.uploadId,
    `preview/${createHash('sha256').update(JSON.stringify([plan, timezone, revision])).digest('hex').slice(0, 32)}`);
  const summaryKey = (prefix: string, bucket: number) => `${prefix}/${bucket}/summary.json`;
  const fileKey = (prefix: string, generation: string, index: number) => `${prefix}/pages/${generation}/rows-${String(index).padStart(4, '0')}.json`;
  /**
   * Changes whenever a real (not dry-run) import run of the gym is created or completes, or runs are removed by retention. It is in
   * the stored key, so a preview computed before any of these is never found again: that covers every upload's previews (people
   * before memberships) and runs that start or finish while a preview is computing. One aggregate over the gym's runs, which
   * `import_runs_retention_idx` (`gym_id` first) bounds to that gym's few runs.
   */
  const importRevision = (gymId: string) => scope(gymId, async (tx) => {
    const [row] = await tx.select({ runs: count(), completed: count(importRuns.completedAt), created: max(importRuns.createdAt),
      finished: max(importRuns.completedAt) }).from(importRuns).where(and(eq(importRuns.gymId, gymId), eq(importRuns.dryRun, false)));
    return [row?.runs ?? 0, row?.completed ?? 0, row?.created?.getTime() ?? 0, row?.finished?.getTime() ?? 0].join('.');
  });
  /**
   * Preview files are read with `get` alone, once `loadMeta` has found the upload live. `get` still serves a key marked deleted
   * until the upload sweep removes it (a day later at the earliest), so a reader holding a summary can finish reading its rows
   * after a newer preview marks them deleted; a row file that is gone makes the read miss and the preview is computed again.
   */
  async function readJson<T>(uploads: Uploads, key: string): Promise<T | undefined> {
    const body = await uploads.get(key);
    return body ? await new Response(body).json() as T : undefined;
  }
  async function readRows(uploads: Uploads, prefix: string, stored: StoredPreview, page: Pagination) {
    const { totalRows, create, update, skip, errors } = stored, summary: PreviewSummary = { totalRows, create, update, skip, errors };
    const first = Math.floor(page.offset / PREVIEW_FILE_ROWS), last = Math.min(Math.floor((page.offset + page.limit - 1) / PREVIEW_FILE_ROWS), stored.files - 1);
    const files = await Promise.all(Array.from({ length: Math.max(0, last - first + 1) },
      (_, index) => readJson<ImportPreviewRow[]>(uploads, fileKey(prefix, stored.generation, first + index))));
    if (files.some((file) => !file)) return undefined;
    const rows = files.flatMap((file) => file!), skipped = page.offset - first * PREVIEW_FILE_ROWS;
    return { summary, data: rows.slice(skipped, skipped + page.limit) };
  }
  // The newest summary this process stored or read for each plan prefix. Keys are immutable and carry the import revision, so a
  // remembered summary stays valid until its lifetime ends; it saves a warm page its summary reads.
  const summaries = new Map<string, StoredPreview>();
  const remember = (prefix: string, stored: StoredPreview) => {
    summaries.delete(prefix); summaries.set(prefix, stored);
    if (summaries.size > 64) summaries.delete(summaries.keys().next().value!);
  };
  const fresh = (stored: StoredPreview | undefined, now: Date): stored is StoredPreview =>
    !!stored && Date.parse(stored.createdAt) + PREVIEW_LIFETIME > now.getTime();
  /** The stored preview finished in the current or the previous bucket, if it is younger than `PREVIEW_LIFETIME`. */
  async function readPreview(gymId: string, prefix: string, page: Pagination) {
    const uploads = await options.uploadsFor(gymId), now = clock.now(), known = summaries.get(prefix);
    if (fresh(known, now)) {
      const rows = await readRows(uploads, prefix, known, page);
      if (rows) return rows;
    }
    summaries.delete(prefix);
    for (const bucket of [bucketOf(now), bucketOf(now) - 1]) {
      const stored = await readJson<StoredPreview>(uploads, summaryKey(prefix, bucket));
      if (fresh(stored, now)) { remember(prefix, stored); return readRows(uploads, prefix, stored, page); }
    }
    return undefined;
  }
  /** Marks deleted the files of the preview in the bucket before `bucket`, which readers no longer reach once `bucket` has one. */
  async function removePrevious(uploads: Uploads, prefix: string, bucket: number): Promise<void> {
    const key = summaryKey(prefix, bucket - 1), previous = await readJson<StoredPreview>(uploads, key);
    if (!previous) return;
    await Promise.all(Array.from({ length: previous.files }, (_, index) => uploads.markDeleted(fileKey(prefix, previous.generation, index))));
    await uploads.markDeleted(key);
  }
  const immutable = (error: unknown) => error instanceof Error && error.message === 'Upload keys are immutable';
  const computing = new Map<string, Promise<StoredPreview>>();
  /**
   * Computes and stores a preview, answering the stored preview to page from; the caller has checked the upload's metadata.
   * Two requests for one preview in this process share one pass; when another process stored the same bucket's summary first,
   * that one is answered and this one's rows are marked deleted. A summary key reserved by a writer that failed or crashed
   * mid-write can't be read or written: this pass's own summary is then remembered in this process, and its rows are kept and go
   * with the upload, so the bucket costs one pass per process.
   */
  function computePreview(context: MutationContext, plan: ImportPlanRequest, timezone: string, prefix: string): Promise<StoredPreview> {
    const running = computing.get(prefix);
    if (running) return running;
    const task = (async (): Promise<StoredPreview> => {
      const { gymId } = context, uploads = await options.uploadsFor(gymId), generation = uuidv7(), startedAt = clock.now();
      const document = await loadSource(gymId, plan.uploadId), written: string[] = [];
      const mapperContext: MapperContext = { ...context, clock, runId: uuidv7(), timezone, sourceRows: document.rows };
      const summary: PreviewSummary = { totalRows: document.rows.length, create: 0, update: 0, skip: 0, errors: 0 };
      const put = async (key: string, value: unknown) => { await store.put(gymId, key, value); written.push(key); };
      const removeWritten = async () => { for (const key of written) await uploads.markDeleted(key).catch(() => undefined); };
      let file: ImportPreviewRow[] = [], files = 0, stored: StoredPreview;
      try {
        for await (const planned of analyze(document, plan, mapperContext)) {
          for (const row of planned.map(({ issues: _issues, ...row }) => row)) {
            if (row.action === 'error') summary.errors++; else summary[row.action]++;
            file.push(row);
            if (file.length === PREVIEW_FILE_ROWS) { await put(fileKey(prefix, generation, files++), file); file = []; }
          }
        }
        if (file.length) await put(fileKey(prefix, generation, files++), file);
        // Its age counts from here, so a slow computation still leaves a preview that is served for the full lifetime.
        const finished = clock.now();
        stored = { ...summary, generation, files, startedAt: startedAt.toISOString(), createdAt: finished.toISOString() };
        try { await store.put(gymId, summaryKey(prefix, bucketOf(finished)), stored); }
        catch (error) {
          if (!immutable(error)) throw error;
          const other = await readJson<StoredPreview>(uploads, summaryKey(prefix, bucketOf(finished)));
          if (!other) { remember(prefix, stored); return stored; }
          await removeWritten();
          remember(prefix, other);
          return other;
        }
      } catch (error) {
        // The rows of a failed computation would otherwise keep row values until the upload expires.
        await removeWritten();
        throw error;
      }
      remember(prefix, stored);
      // Best effort once the preview is stored: retention removes whatever this leaves with the upload.
      await removePrevious(uploads, prefix, bucketOf(new Date(stored.createdAt))).catch(() => undefined);
      return stored;
    })().finally(() => computing.delete(prefix));
    computing.set(prefix, task);
    return task;
  }
  async function get(gymId: string, id: string): Promise<ImportJob> {
    const run = await findRun(gymId, id);
    if (run) return runJob(run);
    const files = await (await options.uploadsFor(gymId)).list(key(gymId, id, 'state-'));
    const latest = files.filter((file) => !file.deletedAt).sort((a, b) => b.key.localeCompare(a.key))[0];
    if (!latest) throw new AppError('not_found', t('imports/pipeline:notFound'));
    return store.get<ImportJob>(gymId, latest.key);
  }
  async function runStored(saved: Run, attempt: number): Promise<void> {
    const { gymId, id } = saved;
    if (saved.completedAt) return;
    await scope(gymId, (tx) => tx.update(importRuns).set({ status: 'running', updatedAt: clock.now() })
      .where(and(runWhere(gymId, id), eq(importRuns.status, 'pending'))));
    try {
      const document = await load(gymId, saved.input), mapper = mappers.get(saved.input.mapper);
      // `start` took the row count from the upload's metadata: never run chunks against a file with a different count.
      if (document.rows.length !== saved.totalRows) throw new Error('Upload does not match the run');
      const context: MapperContext = { gymId, actor: saved.actor, clock, runId: id, timezone: saved.timezone, sourceRows: document.rows };
      const chunks = await scope(gymId, (tx) => tx.select().from(importChunks)
        .where(and(eq(importChunks.gymId, gymId), eq(importChunks.runId, id))).orderBy(asc(importChunks.position)));
      for (const chunk of chunks) {
        const source = document.rows.slice(chunk.position * IMPORT_CHUNK_SIZE, (chunk.position + 1) * IMPORT_CHUNK_SIZE);
        async function commitChunk(failure?: ChunkResult): Promise<void> {
          await scope(gymId, async (tx) => {
            // A short run-row lock serializes deliveries and counters. Domain writes, chunk result and
            // aggregate progress commit together; a restarted worker never depends on storage checkpoints.
            const [run] = await tx.select().from(importRuns).where(runWhere(gymId, id)).for('update');
            if (!run || run.completedAt) return;
            const [current] = await tx.select().from(importChunks)
              .where(and(eq(importChunks.gymId, gymId), eq(importChunks.id, chunk.id)));
            if (!current || current.completedAt) return;
            let result = failure;
            if (!result) {
              const planned = policy(await mapper.analyze(tx, source, saved.input, context), saved.input);
              if (planned.length !== source.length || planned.some((row, index) => row.rowNumber !== source[index]!.rowNumber))
                throw new Error('Invalid mapper results');
              const valid = planned.filter((row) => !row.issues.length && (row.action === 'create' || row.action === 'update'));
              const count = saved.dryRun || !valid.length ? 0 : await mapper.commit(tx, valid, context);
              if (!Number.isInteger(count) || count < 0 || count > valid.length) throw new Error('Invalid mapper commit count');
              result = { count, issues: planned.flatMap((row) => row.issues) };
            }
            const now = clock.now(), processedRows = run.processedRows + current.rowCount;
            const errorCount = run.errorCount + result.issues.length, completed = processedRows === run.totalRows;
            await tx.update(importChunks).set({ committedRows: result.count, issues: result.issues, completedAt: now })
              .where(and(eq(importChunks.gymId, gymId), eq(importChunks.id, chunk.id)));
            await tx.update(importRuns).set({ processedRows, committedRows: run.committedRows + result.count, errorCount,
              updatedAt: now, status: completed ? (errorCount ? 'failed' : 'succeeded') : 'running', completedAt: completed ? now : null })
              .where(runWhere(gymId, id));
            if (!saved.dryRun) await writeAudit(tx, { id: chunk.id, gymId, actorKind: context.actor.kind,
              ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}), action: 'imports.chunk.committed',
              targetType: 'import', targetId: id, after: { offset: chunk.position * IMPORT_CHUNK_SIZE, count: result.count,
                errorCount: result.issues.length }, occurredAt: now });
          });
        }
        try { await commitChunk(); }
        catch {
          // The domain transaction rolled back. Safe issues are durable in the same transaction as progress.
          // If another worker won, commitChunk observes the completed chunk and leaves its result intact.
          await commitChunk({ count: 0, issues: source.map((row) => ({ rowNumber: row.rowNumber, column: null,
            code: 'conflict', message: t('imports/pipeline:chunkFailed') })) });
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // An empty CSV still has a durable terminal state.
      if (!saved.totalRows) await scope(gymId, (tx) => tx.update(importRuns)
        .set({ status: 'succeeded', completedAt: clock.now(), updatedAt: clock.now() }).where(runWhere(gymId, id)));
    } catch (error) {
      if (attempt >= 5) await scope(gymId, (tx) => tx.update(importRuns)
        .set({ status: 'failed', completedAt: clock.now(), updatedAt: clock.now() })
        .where(and(runWhere(gymId, id), eq(importRuns.status, 'running'))));
      throw error;
    }
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
    async preview(context: MutationContext, input: ImportPlanRequest, page: Pagination, timezone: string) {
      const plan = importPlanRequestSchema.parse(input);
      await loadMeta(context.gymId, plan);
      const prefix = planPrefix(context.gymId, plan, timezone, await importRevision(context.gymId));
      const respond = (stored: { summary: PreviewSummary; data: ImportPreviewRow[] }) =>
        ({ data: stored.data, pagination: { ...page, total: stored.summary.totalRows }, summary: stored.summary });
      const found = await readPreview(context.gymId, prefix, page);
      if (found) return respond(found);
      const computed = await computePreview(context, plan, timezone, prefix);
      const rows = await readRows(await options.uploadsFor(context.gymId), prefix, computed, page);
      if (!rows) throw new AppError('not_found', t('imports/pipeline:notFound'));
      return respond(rows);
    },
    async start(context: MutationContext, input: StartImportRequest, timezone: string): Promise<ImportJob> {
      input = startImportRequestSchema.parse(input);
      // The upload's metadata already holds the row count; the CSV is read when the job runs.
      const meta = await loadMeta(context.gymId, input), id = uuidv7();
      if (!await store.exists(context.gymId, sourceKey(context.gymId, input.uploadId))) throw new AppError('not_found', t('imports/pipeline:notFound'));
      const job: ImportJob = { id, uploadId: input.uploadId, mapper: input.mapper, dryRun: input.dryRun, status: 'pending',
        totalRows: meta.rowCount, processedRows: 0, committedRows: 0, errorCount: 0, createdAt: clock.now().toISOString(), completedAt: null };
      const chunkIds = Array.from({ length: Math.ceil(meta.rowCount / IMPORT_CHUNK_SIZE) }, () => uuidv7());
      await scope(context.gymId, async (tx) => {
        await tx.insert(importRuns).values({ id, gymId: context.gymId, input, actor: context.actor, timezone, dryRun: input.dryRun,
          totalRows: job.totalRows, createdAt: new Date(job.createdAt), updatedAt: clock.now() });
        if (chunkIds.length) await tx.insert(importChunks).values(chunkIds.map((chunkId, position) => ({
          id: chunkId, gymId: context.gymId, runId: id, position,
          rowCount: Math.min(IMPORT_CHUNK_SIZE, meta.rowCount - position * IMPORT_CHUNK_SIZE), createdAt: clock.now(),
        })));
        if (!input.dryRun) await writeAudit(tx, { id, gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}), action: 'imports.started', targetType: 'import', targetId: id,
          after: { totalRows: job.totalRows }, occurredAt: clock.now() });
      });
      try { await options.jobs.enqueue(IMPORT_JOB, { id }, { gymId: context.gymId, timezone, idempotencyKey: id, maxAttempts: 5 }); }
      catch (error) {
        await scope(context.gymId, (tx) => tx.update(importRuns).set({ status: 'failed', completedAt: clock.now(), updatedAt: clock.now() })
          .where(runWhere(context.gymId, id)));
        throw error;
      }
      // Nothing touches storage after the run is committed and queued. Stored previews go stale through the import revision.
      return job;
    },
    get,
    async errors(gymId: string, id: string, page: Pagination) {
      if (await findRun(gymId, id)) {
        const chunks = await scope(gymId, (tx) => tx.select({ issues: importChunks.issues }).from(importChunks)
          .where(and(eq(importChunks.gymId, gymId), eq(importChunks.runId, id))).orderBy(asc(importChunks.position)));
        const issues = chunks.flatMap((chunk) => chunk.issues);
        return { data: issues.slice(page.offset, page.offset + page.limit), pagination: { ...page, total: issues.length } };
      }
      await get(gymId, id);
      const files = await (await options.uploadsFor(gymId)).list(key(gymId, id, 'issues-'));
      const issues: ImportIssue[] = [];
      for (const file of files.filter((file) => !file.deletedAt).sort((a, b) => a.key.localeCompare(b.key)))
        issues.push(...await store.get<ImportIssue[]>(gymId, file.key));
      return { data: issues.slice(page.offset, page.offset + page.limit), pagination: { ...page, total: issues.length } };
    },
    async run(gymId: string, id: string, attempt = 1): Promise<void> {
      const run = await findRun(gymId, id);
      if (run) return runStored(run, attempt);
      // Runs created by the previous release stay on its protocol while old workers may still write them.
      const saved = await store.get<StoredRun>(gymId, key(gymId, id, 'run.json'));
      if (await store.exists(gymId, stateKey(gymId, id, 99999999))) return;
      const job = { ...saved.job, status: 'running' as ImportJob['status'] };
      await store.putOnce(gymId, stateKey(gymId, id, 1), job);
      try {
        const document = await load(gymId, saved.input), mapper = mappers.get(saved.input.mapper);
        const context: MapperContext = { gymId, actor: saved.actor, clock, runId: id, timezone: saved.timezone ?? 'UTC', sourceRows: document.rows };
        for (let i = 0; i < document.rows.length; i += IMPORT_CHUNK_SIZE) {
          const source = document.rows.slice(i, i + IMPORT_CHUNK_SIZE);
          let result: ChunkResult;
          const chunkId = saved.chunkIds[i / IMPORT_CHUNK_SIZE]!;
          // Compatibility checkpoint for runs created by the previous release.
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
