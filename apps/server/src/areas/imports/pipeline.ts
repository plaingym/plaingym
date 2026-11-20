// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { t } from './pipeline.messages.js';
import { and, asc, count, eq, max } from 'drizzle-orm';
import { forGym, auditEvents, importRuns, importChunks, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { importPlanRequestSchema, startImportRequestSchema, type ImportUpload, type ImportJob, type ImportIssue,
  type ImportPlanRequest, type ImportPreviewRow, type ImportPreviewState, type Pagination, type StartImportRequest } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { Jobs } from '../../infra/jobs/index.js';
import type { Payments } from '../../infra/payments/index.js';
import type { Uploads } from '../../infra/storage/index.js';
import { parseCsv, autoMatch, MAX_CSV_BYTES, type CsvDocument } from './pipeline.csv.js';
import { PipelineStore, type UploadsFor } from './pipeline.store.js';
import { ImportPreparationChanged, MapperRegistry, type MapperContext, type PlannedRow } from './mappers/registry.js';
import { createPeopleMapper } from './mappers/people.js';
import { matMapper } from './mappers/mat.js';
import { membershipsMapper } from './mappers/memberships.js';
import { previewBudget, previewDeadline, PREVIEW_CLEANUP_MS, PREVIEW_TIMEOUT_MS, PREVIEW_LEASE_INTERVAL_MS,
  type PreviewBudget, type PreviewSummary, type StoredPreview } from './pipeline.budget.js';

export const IMPORT_JOB = 'imports.pipeline';
export const IMPORT_CHUNK_SIZE = 100;
const LIFETIME = 24 * 60 * 60 * 1000;
/** A stored preview is a snapshot of the gym's existing members: pages come from it for five minutes, then it is computed again. */
export const PREVIEW_LIFETIME = 5 * 60 * 1000;
/** Rows per stored preview file: 20 files for a 100,000-row upload, and a page of at most 100 rows reads two files at most. */
export const PREVIEW_FILE_ROWS = 5_000;
interface PreviewTicket { prefix: string; revision: string; leased?: true; expiresAt?: string }
type PreviewResult = { status: 'ready'; stored: StoredPreview } | { status: 'failed'; message: string };
/** `timezone` is fixed when the run starts; runs saved before it was recorded read offset-free values as UTC, as their dry runs did. */
interface StoredRun { job: ImportJob; input: StartImportRequest; actor: MutationContext['actor']; chunkIds: string[]; timezone?: string }
interface ChunkResult { count: number; issues: ImportIssue[] }
interface StoredUpload extends ImportUpload { byteSize?: number }
type Run = typeof importRuns.$inferSelect;
function runJob(run: Run): ImportJob {
  return { id: run.id, uploadId: run.input.uploadId, mapper: run.input.mapper, dryRun: run.dryRun, status: run.status,
    totalRows: run.totalRows, processedRows: run.processedRows, committedRows: run.committedRows, errorCount: run.errorCount,
    createdAt: run.createdAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null };
}
/**
 * Checks an upload as UTF-8 CSV and answers its header and row count. The file's bytes are read into a buffer only for the
 * decode, so they are released before parsing, and the text and parsed rows when this returns.
 */
async function readShape(file: File): Promise<{ columns: string[]; rowCount: number }> {
  const document = parseCsv(await decode(file));
  return { columns: document.columns, rowCount: document.rows.length };
}
/** A read failure is the server's; only bytes that aren't UTF-8 make the CSV invalid. */
async function decode(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AppError('invalid_request', t('imports/pipeline:invalidCsv')); }
}
export interface PipelineOptions {
  uploadsFor: UploadsFor; jobs: Jobs; scope?: typeof forGym; clock?: Clock; mappers?: MapperRegistry;
  previewBudget?: PreviewBudget; previewTimeoutMs?: number;
  paymentsFor?(gymId: string): Promise<Payments | null>;
}
export function createImportPipeline(options: PipelineOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const budget = options.previewBudget ?? previewBudget, timeout = options.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Invalid preview deadline');
  const store = new PipelineStore(options.uploadsFor);
  const pending = budget.pending;
  // Retention excludes the preview subtree when finding an upload's original age.
  const ticketPrefix = (gymId: string, uploadId: string, id: string) => store.key(gymId, 'uploads', uploadId, `preview/requests/${id}`);
  const ticketKey = (gymId: string, uploadId: string, id: string, file: string) => `${ticketPrefix(gymId, uploadId, id)}/${file}.json`;
  const mappers = options.mappers ?? new MapperRegistry([createPeopleMapper(scope, options.paymentsFor), matMapper, membershipsMapper]);
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
  async function loadMeta(gymId: string, plan: ImportPlanRequest): Promise<StoredUpload> {
    const meta = await store.get<StoredUpload>(gymId, store.key(gymId, 'uploads', plan.uploadId, 'meta.json'));
    if (Date.parse(meta.expiresAt) <= clock.now().getTime()) throw new AppError('not_found', t('imports/pipeline:notFound'));
    if (new Set(plan.mapping.map((item) => item.sourceColumn)).size !== plan.mapping.length
      || plan.mapping.some((item) => !meta.columns.includes(item.sourceColumn)))
      throw new AppError('invalid_request', t('imports/pipeline:invalidMapping'));
    return meta;
  }
  /** The upload's CSV, once its metadata has been checked. */
  async function loadSource(gymId: string, uploadId: string, signal?: AbortSignal): Promise<CsvDocument> {
    const body = await (await options.uploadsFor(gymId)).get(sourceKey(gymId, uploadId), signal ? { signal } : undefined);
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
  async function* analyze(document: CsvDocument, plan: ImportPlanRequest, context: MapperContext, check = () => {}): AsyncGenerator<PlannedRow[]> {
    const mapper = mappers.get(plan.mapper);
    for (let i = 0; i < document.rows.length; i += IMPORT_CHUNK_SIZE) {
      check();
      const rows = document.rows.slice(i, i + IMPORT_CHUNK_SIZE);
      const prepared = await mapper.prepare?.(rows, plan, context) ?? context;
      check();
      const planned = await scope(context.gymId, (tx) => mapper.analyze(tx, rows, plan, prepared));
      check();
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
  async function readJson<T>(uploads: Uploads, key: string, signal?: AbortSignal): Promise<T | undefined> {
    const body = await uploads.get(key, signal ? { signal } : undefined);
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
  async function removePrevious(uploads: Uploads, prefix: string, bucket: number, signal?: AbortSignal): Promise<void> {
    const key = summaryKey(prefix, bucket - 1), previous = await readJson<StoredPreview>(uploads, key, signal);
    if (!previous) return;
    await Promise.all(Array.from({ length: previous.files }, (_, index) => uploads.markDeleted(fileKey(prefix, previous.generation, index), signal ? { signal } : undefined)));
    await uploads.markDeleted(key, signal ? { signal } : undefined);
  }
  const immutable = (error: unknown) => error instanceof Error && error.message === 'Upload keys are immutable';
  /**
   * Computes and stores a preview, answering the stored preview to page from; the caller has checked the upload's metadata.
   * Each call takes its own budget reservation: callers coalesce in `preparePreview`. When another process stored the same bucket's summary first,
   * that one is answered and this one's rows are marked deleted. A summary key reserved by a writer that failed or crashed
   * mid-write can't be read or written: this pass's own summary is then remembered in this process, and its rows are kept and go
   * with the upload, so the bucket costs one pass per process.
   */
  function computePreview(context: MutationContext, plan: ImportPlanRequest, timezone: string, prefix: string, meta: StoredUpload,
    onStart = async () => {}): Promise<StoredPreview> {
    // Uploads from earlier releases have no byte size: reserve conservatively until they expire.
    return budget.run(context.gymId, meta.byteSize ?? MAX_CSV_BYTES, meta.rowCount, async () => {
      await onStart();
      return previewDeadline(timeout, async (signal, check): Promise<StoredPreview> => {
        const { gymId } = context, uploads = await options.uploadsFor(gymId), generation = uuidv7(), startedAt = clock.now();
        const document = await loadSource(gymId, plan.uploadId, signal), written: string[] = [];
        check();
        const mapperContext: MapperContext = { ...context, clock, runId: uuidv7(), timezone, sourceRows: document.rows };
        const summary: PreviewSummary = { totalRows: document.rows.length, create: 0, update: 0, skip: 0, errors: 0 };
        const put = async (key: string, value: unknown) => { check(); await store.put(gymId, key, value); written.push(key); check(); };
        // The computation's own signal may have aborted already, which would refuse every removal.
        const removeWritten = async () => {
          const limit = AbortSignal.timeout(PREVIEW_CLEANUP_MS);
          for (const key of written) await uploads.markDeleted(key, { signal: limit }).catch(() => undefined);
        };
        let file: ImportPreviewRow[] = [], files = 0, stored: StoredPreview;
        try {
          for await (const planned of analyze(document, plan, mapperContext, check)) {
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
          // No check after this write: once the summary is stored the preview exists, and readers may already be using it.
          try { check(); await store.put(gymId, summaryKey(prefix, bucketOf(finished)), stored); }
          catch (error) {
            if (!immutable(error)) throw error;
            // Another process finished this preview, so it is an answer even if this pass's deadline ended during the write.
            const other = await readJson<StoredPreview>(uploads, summaryKey(prefix, bucketOf(finished)), AbortSignal.timeout(PREVIEW_CLEANUP_MS));
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
        await removePrevious(uploads, prefix, bucketOf(new Date(stored.createdAt)), signal).catch(() => undefined);
        return stored;
      });
    });
  }
  const previewResponse = (stored: { summary: PreviewSummary; data: ImportPreviewRow[] }, page: Pagination) =>
    ({ data: stored.data, pagination: { ...page, total: stored.summary.totalRows }, summary: stored.summary });

  async function preparePreview(context: MutationContext, input: ImportPlanRequest, page: Pagination, timezone: string) {
    const plan = importPlanRequestSchema.parse(input), meta = await loadMeta(context.gymId, plan);
    const revision = await importRevision(context.gymId), prefix = planPrefix(context.gymId, plan, timezone, revision);
    const found = await readPreview(context.gymId, prefix, page);
    if (found) return { preview: previewResponse(found, page) };
    let entry = pending.get(prefix);
    if (!entry) {
      const id = uuidv7(), saved = Promise.withResolvers<void>(), finished = Promise.withResolvers<StoredPreview>();
      entry = { id, gymId: context.gymId, uploadId: plan.uploadId, expiresAt: meta.expiresAt, leaseUntil: 0,
        status: 'queued', admitted: saved.promise, finished: finished.promise };
      // An HTTP caller only waits for admission; its background completion must still have a rejection handler.
      void finished.promise.catch(() => undefined);
      pending.set(prefix, entry);
      const current = entry, ticket: PreviewTicket = { prefix, revision, leased: true };
      const requestPrefix = ticketPrefix(context.gymId, plan.uploadId, id);
      let heartbeat: ReturnType<typeof setTimeout> | undefined, stopped = false;
      const renew = async (): Promise<void> => {
        try { current.leaseUntil = await store.renewLease(context.gymId, requestPrefix, clock.now().getTime()); }
        finally {
          // Serialize writes, and stop on every terminal outcome, including a failed result write.
          if (!stopped) heartbeat = setTimeout(() => { void renew().catch(() => undefined); }, PREVIEW_LEASE_INTERVAL_MS);
        }
      };
      let computation: Promise<StoredPreview>;
      try {
        computation = computePreview(context, plan, timezone, prefix, meta, async () => {
          await saved.promise;
          await store.put(context.gymId, ticketKey(context.gymId, plan.uploadId, id, 'computing'), {});
          current.status = 'computing';
        });
      } catch (error) {
        pending.delete(prefix); saved.reject(error);
        // No duplicate caller can have observed the entry before this synchronous rejection.
        void saved.promise.catch(() => undefined);
        throw error;
      }
      void computation.catch(() => undefined);
      // Every background failure is observed, and only safe application explanations are persisted.
      void (async () => {
        try {
          await renew();
          await store.put(context.gymId, ticketKey(context.gymId, plan.uploadId, id, 'meta'), ticket);
          saved.resolve();
          const stored = await computation;
          await store.put(context.gymId, ticketKey(context.gymId, plan.uploadId, id, 'result'), { status: 'ready', stored });
          finished.resolve(stored);
        } catch (error) {
          saved.reject(error);
          await computation.catch(() => undefined);
          const message = error instanceof AppError && ['invalid_request', 'not_found', 'unavailable'].includes(error.code)
            ? error.message : t('imports/pipeline:previewFailed');
          finished.reject(error);
          await store.put(context.gymId, ticketKey(context.gymId, plan.uploadId, id, 'result'), { status: 'failed', message });
        } finally { stopped = true; clearTimeout(heartbeat); pending.delete(prefix); }
      })().catch(() => undefined);
    }
    await entry.admitted;
    return { entry, prefix };
  }
  async function requestPreview(context: MutationContext, input: ImportPlanRequest, page: Pagination, timezone: string): Promise<ImportPreviewState> {
    const prepared = await preparePreview(context, input, page, timezone);
    if (prepared.preview) return { status: 'ready', preview: prepared.preview };
    const { entry } = prepared;
    return { status: entry.status, id: entry.id, uploadId: entry.uploadId };
  }
  async function getPreview(gymId: string, uploadId: string, id: string, page: Pagination): Promise<ImportPreviewState> {
    const current = [...pending.values()].find(entry => entry.gymId === gymId && entry.uploadId === uploadId && entry.id === id);
    if (current) {
      await current.admitted;
      if (Date.parse(current.expiresAt) <= clock.now().getTime()) throw new AppError('not_found', t('imports/pipeline:notFound'));
      if (current.leaseUntil <= clock.now().getTime()) return { status: 'failed', message: t('imports/pipeline:previewFailed') };
      return { status: current.status, id, uploadId };
    }
    // Checking the upload first also enforces deletion, expiry, and gym ownership for every poll.
    const meta = await store.get<StoredUpload>(gymId, store.key(gymId, 'uploads', uploadId, 'meta.json'));
    if (Date.parse(meta.expiresAt) <= clock.now().getTime()) throw new AppError('not_found', t('imports/pipeline:notFound'));
    let requestPrefix = ticketPrefix(gymId, uploadId, id);
    if (!await store.exists(gymId, `${requestPrefix}/meta.json`))
      requestPrefix = store.key(gymId, 'uploads', uploadId, `preview-requests/${id}`);
    const ticket = await store.get<PreviewTicket>(gymId, `${requestPrefix}/meta.json`);
    const uploads = await options.uploadsFor(gymId);
    const result = await readJson<PreviewResult>(uploads, `${requestPrefix}/result.json`);
    if (result?.status === 'failed') return result;
    if (result?.status === 'ready') {
      if (ticket.revision !== await importRevision(gymId)) return { status: 'failed', message: t('imports/pipeline:previewChanged') };
      if (!fresh(result.stored, clock.now())) return { status: 'failed', message: t('imports/pipeline:previewChanged') };
      const rows = await readRows(uploads, ticket.prefix, result.stored, page);
      if (rows) return { status: 'ready', preview: previewResponse(rows, page) };
      return { status: 'failed', message: t('imports/pipeline:previewFailed') };
    }
    // Older releases used a fixed expiry; new tickets stay alive only while their owning process renews the lease.
    const alive = ticket.leased ? await store.hasLease(gymId, requestPrefix, clock.now().getTime())
      : !!ticket.expiresAt && Date.parse(ticket.expiresAt) > clock.now().getTime();
    if (!alive) return { status: 'failed', message: t('imports/pipeline:previewFailed') };
    return { status: await store.exists(gymId, `${requestPrefix}/computing.json`) ? 'computing' : 'queued', id, uploadId };
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
        if (chunk.completedAt) continue;
        const source = document.rows.slice(chunk.position * IMPORT_CHUNK_SIZE, (chunk.position + 1) * IMPORT_CHUNK_SIZE);
        const prepared = await mapper.prepare?.(source, saved.input, context) ?? context;
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
              const planned = policy(await mapper.analyze(tx, source, saved.input, prepared), saved.input);
              if (planned.length !== source.length || planned.some((row, index) => row.rowNumber !== source[index]!.rowNumber))
                throw new Error('Invalid mapper results');
              const valid = planned.filter((row) => !row.issues.length && (row.action === 'create' || row.action === 'update'));
              const count = saved.dryRun || !valid.length ? 0 : await mapper.commit(tx, valid, prepared);
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
        catch (error) {
          if (error instanceof ImportPreparationChanged) throw error;
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
    requestPreview, getPreview,
    async upload(context: MutationContext, file: File): Promise<ImportUpload> {
      if (!file.size || file.size > MAX_CSV_BYTES) throw new AppError('invalid_request', t('imports/pipeline:invalidCsv'));
      const { columns, rowCount } = await readShape(file), id = uuidv7(), mapping = autoMatch(columns);
      const data: ImportUpload = { id, filename: file.name.replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 255) || 'import.csv',
        rowCount, columns, suggestedMapping: mapping.length ? mapping : null,
        expiresAt: new Date(clock.now().getTime() + LIFETIME).toISOString() };
      // The stored bytes stream from the file itself, after its text and parsed rows are released.
      await (await options.uploadsFor(context.gymId)).put(store.key(context.gymId, 'uploads', id, 'source.csv'), file.stream(), 'text/csv');
      await store.put(context.gymId, store.key(context.gymId, 'uploads', id, 'meta.json'), { ...data, byteSize: file.size });
      await scope(context.gymId, (tx) => writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
        ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}), action: 'imports.uploaded', targetType: 'import', targetId: id,
        after: { rowCount: data.rowCount }, occurredAt: clock.now() }));
      return data;
    },
    async preview(context: MutationContext, input: ImportPlanRequest, page: Pagination, timezone: string) {
      const prepared = await preparePreview(context, input, page, timezone);
      if (prepared.preview) return prepared.preview;
      const computed = await prepared.entry.finished;
      const rows = await readRows(await options.uploadsFor(context.gymId), prepared.prefix, computed, page);
      if (!rows) throw new AppError('not_found', t('imports/pipeline:notFound'));
      return previewResponse(rows, page);
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
          const prior = mapper.prepare && !saved.input.dryRun ? await scope(gymId, existing) : undefined;
          const prepared = !prior ? await mapper.prepare?.(source, saved.input, context) ?? context : context;
          try {
            result = prior ?? await scope(gymId, async (tx) => {
              if (!saved.input.dryRun) { const committed = await existing(tx); if (committed) return committed; }
              const planned = policy(await mapper.analyze(tx, source, saved.input, prepared), saved.input);
              if (planned.length !== source.length || planned.some((row, index) => row.rowNumber !== source[index]!.rowNumber))
                throw new Error('Invalid mapper results');
              const valid = planned.filter((row) => !row.issues.length && (row.action === 'create' || row.action === 'update'));
              const count = saved.input.dryRun || !valid.length ? 0 : await mapper.commit(tx, valid, prepared);
              if (!Number.isInteger(count) || count < 0 || count > valid.length) throw new Error('Invalid mapper commit count');
              return checkpoint(tx, { count, issues: planned.flatMap((row) => row.issues) });
            });
          } catch (error) {
            if (error instanceof ImportPreparationChanged) throw error;
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
