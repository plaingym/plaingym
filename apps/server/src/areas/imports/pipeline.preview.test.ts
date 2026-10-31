// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { importRuns, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { ImportPlanRequest, ImportPreviewRow } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeUploads, type Uploads } from '../../infra/storage/index.js';
import { LocalUploads } from '../../infra/storage/local.js';
import { createImportPipeline, IMPORT_CHUNK_SIZE, PREVIEW_FILE_ROWS, PREVIEW_LIFETIME } from './pipeline.js';
import { createImportRetention, UPLOAD_RETENTION_MS } from './retention.js';
import { MapperRegistry, type CsvMapper, type PlannedRow } from './mappers/registry.js';
import { peopleMapper } from './mappers/people.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2099-10-22T12:00:00Z'), gymA = uuidv7(), gymB = uuidv7();
const duplicate = uuidv7(), actorA = { gymId: gymA, actor: { kind: 'system' } } as const, actorB = { gymId: gymB, actor: { kind: 'system' } } as const;
let directory: string | undefined;
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

/** Every seventh row has an issue, every eleventh a duplicate, every fifth is skipped: all four actions appear. */
function expectedRow(index: number, field: string): ImportPreviewRow {
  const base = { rowNumber: index + 2, values: { name: `P${index}`, field }, duplicateIds: index % 11 === 0 ? [duplicate] : [] };
  if (index % 7 === 0) return { ...base, action: 'error' };
  if (index % 11 === 0) return { ...base, action: 'error' };
  return { ...base, action: index % 5 === 0 ? 'skip' : 'create' };
}
function fixtureMapper(calls: { analyze: number }): CsvMapper {
  return { id: 'people', available: true, async commit() { return 0; },
    async analyze(_tx, rows, plan): Promise<PlannedRow[]> {
      calls.analyze++;
      return rows.map((row) => {
        const index = row.rowNumber - 2, planned = expectedRow(index, plan.mapping[0]!.targetField);
        return { ...planned, action: index % 7 === 0 ? 'error' : index % 11 === 0 ? 'create' : planned.action,
          issues: index % 7 === 0 ? [{ rowNumber: row.rowNumber, column: null, code: 'invalid_value', message: 'Invalid' }] : [] };
      });
    } };
}
interface Setup {
  /** Another gym's storage instead of FakeUploads. */
  readonly uploads?: (gymId: string) => Uploads;
  /** Keys reserved by a writer that crashed: `put` answers that keys are immutable, and nothing can be read from them. */
  readonly reserved?: (key: string) => boolean;
  readonly jobs?: FakeJobs;
}
function setup(mappers = new MapperRegistry([fixtureMapper({ analyze: 0 })]), clk = clock, options: Setup = {}) {
  const stores = new Map<string, Uploads>(), fail = new Set<string>(), calls: string[] = [];
  const reserved = options.reserved ?? (() => false);
  const uploadsFor = async (gymId: string): Promise<Uploads> => {
    if (!stores.has(gymId)) stores.set(gymId, options.uploads?.(gymId) ?? new FakeUploads(gymId, clk));
    const store = stores.get(gymId)!, count = (name: string) => { calls.push(name); };
    // A test can make a key unreadable to prove the pipeline never reads it; every call is counted.
    return {
      async put(key, body, type) { count('put'); if (reserved(key)) throw new Error('Upload keys are immutable'); return store.put(key, body, type); },
      async head(key) { count('head'); return reserved(key) ? null : store.head(key); },
      async list(prefix) { count('list'); return store.list(prefix); },
      async signedUrl(key, seconds) { count('signedUrl'); return store.signedUrl(key, seconds); },
      async markDeleted(key) { count('markDeleted'); return store.markDeleted(key); },
      async sweep(sweep) { count('sweep'); return store.sweep(sweep); },
      async get(key) { count('get'); if (fail.has(key)) throw new Error('unexpected read of ' + key); return reserved(key) ? null : store.get(key); },
    };
  };
  const jobs = options.jobs ?? new FakeJobs(clk);
  const pipeline = createImportPipeline({ uploadsFor, jobs, scope: database.forGym, clock: clk, mappers });
  return { pipeline, uploadsFor, fail, calls, jobs };
}
const csv = (count: number) => 'Name,Email\r\n' + Array.from({ length: count }, (_, i) => `P${i},p${i}@example.test\r\n`).join('');
const planFor = (uploadId: string, column = 'Name', field: 'firstName' | 'email' = 'firstName'): ImportPlanRequest =>
  ({ uploadId, mapper: 'people', mapping: [{ sourceColumn: column, targetField: field }], duplicatePolicy: 'error' });
const liveKeys = async (uploads: Uploads, prefix: string) => (await uploads.list(prefix)).filter((info) => !info.deletedAt).map((info) => info.key);
const previewPrefix = (gymId: string, uploadId: string) => `${gymId}/imports/uploads/${uploadId}/preview/`;
const bucket = (clk = clock) => Math.floor(clk.now().getTime() / PREVIEW_LIFETIME);

describe('stored import previews', () => {
  it('pages identically to analyzing the whole file, across stored file boundaries', async () => {
    const calls = { analyze: 0 }, { pipeline, uploadsFor } = setup(new MapperRegistry([fixtureMapper(calls)]));
    const rows = 2 * PREVIEW_FILE_ROWS + 100, upload = await pipeline.upload(actorA, new File([csv(rows)], 'people.csv')), plan = planFor(upload.id);
    const expected = Array.from({ length: rows }, (_, index) => expectedRow(index, 'firstName'));
    const summary = { totalRows: rows, create: 0, update: 0, skip: 0, errors: 0 };
    for (const row of expected) { if (row.action === 'error') summary.errors++; else summary[row.action as 'create' | 'skip']++; }
    expect(summary.errors).toBeGreaterThan(0); expect(summary.skip).toBeGreaterThan(0);
    const pages = [[0, 50], [4950, 100], [4990, 20], [5000, 100], [9999, 100], [10050, 100], [10099, 1], [10100, 50], [20000, 100], [0, 100]] as const;
    for (const [offset, limit] of pages) {
      const preview = await pipeline.preview(actorA, plan, { limit, offset }, 'UTC');
      expect(preview.data, `offset ${offset} limit ${limit}`).toEqual(expected.slice(offset, offset + limit));
      expect(preview.pagination).toEqual({ limit, offset, total: rows });
      expect(preview.summary).toEqual(summary);
    }
    expect(calls.analyze).toBe(Math.ceil(rows / IMPORT_CHUNK_SIZE));
    // Three row files (5,000, 5,000 and 100 rows) and the summary.
    expect(await liveKeys(await uploadsFor(gymA), previewPrefix(gymA, upload.id))).toHaveLength(4);
  });
  it('matches the people mapper analyzing the file chunk by chunk', async () => {
    const { pipeline } = setup(new MapperRegistry([peopleMapper]));
    await factory('members', gymA, { firstName: 'Existing', lastName: 'Member', email: 'existing@example.test' });
    const lines = Array.from({ length: 230 }, (_, i) => i === 3 ? 'Existing,Member,existing@example.test' : i === 9 ? 'Bad,Email,not-an-email'
      : i === 12 ? 'Twin,One,twin@example.test' : i === 13 ? 'Twin,Two,twin@example.test' : `First${i},Last${i},person${i}@example.test`);
    const text = 'First Name,Last Name,Email\r\n' + lines.join('\r\n') + '\r\n';
    const upload = await pipeline.upload(actorA, new File([text], 'people.csv'));
    const plan: ImportPlanRequest = { uploadId: upload.id, mapper: 'people', duplicatePolicy: 'skip', mapping: upload.suggestedMapping! };
    const { parseCsv } = await import('./pipeline.csv.js'), document = parseCsv(text);
    const context = { ...actorA, clock, runId: uuidv7(), timezone: 'UTC', sourceRows: document.rows };
    const direct: ImportPreviewRow[] = [];
    for (let i = 0; i < document.rows.length; i += IMPORT_CHUNK_SIZE) {
      const planned = await database.forGym(gymA, (tx) => peopleMapper.analyze(tx, document.rows.slice(i, i + IMPORT_CHUNK_SIZE), plan, context));
      // Duplicate policy 'skip' turns rows that matched an existing member into skips, as execution does.
      for (const { issues, ...row } of planned) direct.push(row.duplicateIds.length && !issues.length ? { ...row, action: 'skip' } : row);
    }
    expect(direct.some((row) => row.action === 'skip')).toBe(true); expect(direct.some((row) => row.action === 'error')).toBe(true);
    const stored: ImportPreviewRow[] = [];
    for (let offset = 0; offset < 230; offset += 75) stored.push(...(await pipeline.preview(actorA, plan, { limit: 75, offset }, 'UTC')).data);
    expect(stored).toEqual(direct);
  });
  it('analyzes once per plan: later pages and concurrent requests read the stored preview', async () => {
    const calls = { analyze: 0 }, { pipeline, uploadsFor } = setup(new MapperRegistry([fixtureMapper(calls)]));
    const upload = await pipeline.upload(actorA, new File([csv(300)], 'people.csv')), plan = planFor(upload.id);
    await Promise.all([pipeline.preview(actorA, plan, { limit: 50, offset: 0 }, 'UTC'), pipeline.preview(actorA, plan, { limit: 50, offset: 50 }, 'UTC')]);
    expect(calls.analyze).toBe(3);
    await pipeline.preview(actorA, plan, { limit: 100, offset: 200 }, 'UTC');
    expect(calls.analyze).toBe(3);
    const keys = await liveKeys(await uploadsFor(gymA), previewPrefix(gymA, upload.id));
    expect(keys).toHaveLength(2); // one row file and the summary
    expect(keys.filter((key) => key.endsWith(`/${bucket()}/summary.json`))).toHaveLength(1);
  });
  it('serves a warm page from at most three storage calls and no listing, whatever else the gym has stored', async () => {
    directory = await mkdtemp(join(tmpdir(), 'preview-local-'));
    const root = directory, calls = { analyze: 0 };
    const local = (gymId: string) => new LocalUploads({ gymId, root, signingKey: new Uint8Array(32).fill(7), downloadUrl: 'https://gym.test/uploads/download', clock });
    const { pipeline, uploadsFor, calls: storage } = setup(new MapperRegistry([fixtureMapper(calls)]), clock, { uploads: local });
    const uploads = await uploadsFor(gymA);
    // 2,000 records the preview has nothing to do with, half of them tombstones.
    for (let batch = 0; batch < 2000; batch += 50) await Promise.all(Array.from({ length: 50 }, async (_, offset) => {
      const i = batch + offset, key = `${gymA}/other/${String(i).padStart(4, '0')}.bin`;
      await uploads.put(key, new Uint8Array([i % 256]), 'application/octet-stream');
      if (i % 2) await uploads.markDeleted(key);
    }));
    // Halfway through a bucket, so the next bucket starts while the preview is still fresh.
    clock.advance(PREVIEW_LIFETIME - (clock.now().getTime() % PREVIEW_LIFETIME) + PREVIEW_LIFETIME / 2);
    const upload = await pipeline.upload(actorA, new File([csv(300)], 'people.csv')), plan = planFor(upload.id);
    storage.length = 0;
    expect((await pipeline.preview(actorA, plan, { limit: 100, offset: 0 }, 'UTC')).data).toHaveLength(100);
    expect(storage).not.toContain('list');
    for (const offset of [0, 100, 200]) {
      storage.length = 0;
      const preview = await pipeline.preview(actorA, plan, { limit: 100, offset }, 'UTC');
      expect(preview.data).toEqual(Array.from({ length: 100 }, (_, i) => expectedRow(offset + i, 'firstName')));
      expect(storage, `offset ${offset}`).not.toContain('list');
      expect(storage.length, `offset ${offset}`).toBeLessThanOrEqual(3);
    }
    // In the next bucket: the summary this process remembers, or for a process that never saw it, the previous bucket's.
    clock.advance(PREVIEW_LIFETIME / 2);
    storage.length = 0;
    expect((await pipeline.preview(actorA, plan, { limit: 50, offset: 250 }, 'UTC')).data).toHaveLength(50);
    expect(storage).not.toContain('list'); expect(storage.length).toBeLessThanOrEqual(3);
    // Another process checks the metadata (head and get), probes both buckets and reads the one row file.
    const other = setup(new MapperRegistry([fixtureMapper(calls)]), clock, { uploads: local });
    expect((await other.pipeline.preview(actorA, plan, { limit: 50, offset: 250 }, 'UTC')).data).toHaveLength(50);
    expect(other.calls).toEqual(['head', 'get', 'get', 'get', 'get']);
    expect(calls.analyze).toBe(3);
  }, 90_000);
  it('stores no issues, and recomputes when the mapping, duplicate policy or timezone changes or the preview ages out', async () => {
    const calls = { analyze: 0 }, { pipeline, uploadsFor } = setup(new MapperRegistry([fixtureMapper(calls)]));
    const upload = await pipeline.upload(actorA, new File([csv(120)], 'people.csv')), page = { limit: 5, offset: 0 };
    const first = await pipeline.preview(actorA, planFor(upload.id), page, 'UTC');
    expect(calls.analyze).toBe(2);
    expect(JSON.stringify(first)).not.toContain('Invalid');
    const prefix = previewPrefix(gymA, upload.id), uploads = await uploadsFor(gymA);
    for (const key of await liveKeys(uploads, prefix)) expect(new TextDecoder().decode(await new Response(await uploads.get(key)).arrayBuffer())).not.toContain('Invalid');
    // A changed mapping is analyzed again and shows its own values.
    const email = await pipeline.preview(actorA, planFor(upload.id, 'Email', 'email'), page, 'UTC');
    expect(calls.analyze).toBe(4);
    expect(email.data[0]!.values.field).toBe('email'); expect(first.data[0]!.values.field).toBe('firstName');
    // Each plan keeps its own stored preview while it is fresh: going back is served from storage.
    expect((await pipeline.preview(actorA, planFor(upload.id), page, 'UTC')).data).toEqual(first.data);
    expect(calls.analyze).toBe(4);
    await pipeline.preview(actorA, { ...planFor(upload.id), duplicatePolicy: 'skip' }, page, 'UTC');
    expect(calls.analyze).toBe(6);
    await pipeline.preview(actorA, { ...planFor(upload.id), duplicatePolicy: 'skip' }, page, 'America/Vancouver');
    expect(calls.analyze).toBe(8);
    expect(await liveKeys(uploads, prefix)).toHaveLength(8);
    // The same request is served from storage until the preview is five minutes old.
    clock.advance(PREVIEW_LIFETIME - 1);
    await pipeline.preview(actorA, { ...planFor(upload.id), duplicatePolicy: 'skip' }, { limit: 5, offset: 5 }, 'America/Vancouver');
    expect(calls.analyze).toBe(8);
    clock.advance(1);
    await pipeline.preview(actorA, { ...planFor(upload.id), duplicatePolicy: 'skip' }, page, 'America/Vancouver');
    expect(calls.analyze).toBe(10);
  });
  it('marks the previous bucket\'s files deleted once a newer preview of the plan is stored', async () => {
    const calls = { analyze: 0 }, { pipeline, uploadsFor } = setup(new MapperRegistry([fixtureMapper(calls)]));
    const upload = await pipeline.upload(actorA, new File([csv(PREVIEW_FILE_ROWS + 10)], 'people.csv')), plan = planFor(upload.id);
    const other = planFor(upload.id, 'Email', 'email'), uploads = await uploadsFor(gymA), prefix = previewPrefix(gymA, upload.id);
    await pipeline.preview(actorA, plan, { limit: 10, offset: 0 }, 'UTC');
    await pipeline.preview(actorA, other, { limit: 10, offset: 0 }, 'UTC');
    const before = await liveKeys(uploads, prefix);
    expect(before).toHaveLength(6); // two plans, each two row files and a summary
    clock.advance(PREVIEW_LIFETIME);
    await pipeline.preview(actorA, plan, { limit: 10, offset: 0 }, 'UTC');
    const after = await liveKeys(uploads, prefix), planKeys = before.filter((key) => !after.includes(key));
    // The plan's old summary and both its row files are tombstones; the other plan's preview waits for retention.
    expect(planKeys).toHaveLength(3);
    for (const key of planKeys) expect((await uploads.head(key))?.deletedAt).toBeInstanceOf(Date);
    expect(after).toHaveLength(6);
  });
  it('lets previews of different plans be computed at the same time without destroying each other', async () => {
    const calls = { analyze: 0 }, { pipeline } = setup(new MapperRegistry([fixtureMapper(calls)]));
    const upload = await pipeline.upload(actorA, new File([csv(120)], 'people.csv'));
    const [name, email] = await Promise.all([pipeline.preview(actorA, planFor(upload.id), { limit: 5, offset: 0 }, 'UTC'),
      pipeline.preview(actorA, planFor(upload.id, 'Email', 'email'), { limit: 5, offset: 0 }, 'UTC')]);
    expect(name.data[0]!.values.field).toBe('firstName'); expect(email.data[0]!.values.field).toBe('email');
    expect(calls.analyze).toBe(4);
    expect((await pipeline.preview(actorA, planFor(upload.id), { limit: 100, offset: 50 }, 'UTC')).data).toHaveLength(70);
    expect((await pipeline.preview(actorA, planFor(upload.id, 'Email', 'email'), { limit: 100, offset: 50 }, 'UTC')).data).toHaveLength(70);
    expect(calls.analyze).toBe(4);
  });
  it('serves a preview that took longer than its lifetime to compute for a full lifetime', async () => {
    const calls = { analyze: 0 }, base = fixtureMapper(calls);
    const slow: CsvMapper = { ...base, async analyze(tx, rows, plan, context) { clock.advance(PREVIEW_LIFETIME); return base.analyze(tx, rows, plan, context); } };
    const { pipeline } = setup(new MapperRegistry([slow]));
    const upload = await pipeline.upload(actorA, new File([csv(250)], 'people.csv'));
    const preview = await pipeline.preview(actorA, planFor(upload.id), { limit: 10, offset: 0 }, 'UTC');
    expect(preview.data).toHaveLength(10);
    await pipeline.preview(actorA, planFor(upload.id), { limit: 10, offset: 100 }, 'UTC');
    clock.advance(PREVIEW_LIFETIME - 1);
    await pipeline.preview(actorA, planFor(upload.id), { limit: 10, offset: 200 }, 'UTC');
    expect(calls.analyze).toBe(3);
  });
  it('removes the rows of a failed computation', async () => {
    const calls = { analyze: 0 }, base = fixtureMapper(calls);
    const flaky: CsvMapper = { ...base, async analyze(tx, rows, plan, context) {
      if (calls.analyze === 50) { calls.analyze++; throw new Error('database timeout'); }
      return base.analyze(tx, rows, plan, context);
    } };
    const { pipeline, uploadsFor } = setup(new MapperRegistry([flaky]));
    const upload = await pipeline.upload(actorA, new File([csv(PREVIEW_FILE_ROWS + 100)], 'people.csv')), uploads = await uploadsFor(gymA);
    await expect(pipeline.preview(actorA, planFor(upload.id), { limit: 10, offset: 0 }, 'UTC')).rejects.toThrow('database timeout');
    // The first row file was written before the failure; it is a tombstone now.
    expect((await uploads.list(previewPrefix(gymA, upload.id))).map((info) => !!info.deletedAt)).toEqual([true]);
    // The next request computes again and is stored.
    expect((await pipeline.preview(actorA, planFor(upload.id), { limit: 10, offset: 0 }, 'UTC')).data).toHaveLength(10);
    expect(await liveKeys(uploads, previewPrefix(gymA, upload.id))).toHaveLength(3);
  });
  it('never lets a crashed writer block previews: orphaned rows, or a summary key it reserved and never wrote', async () => {
    const calls = { analyze: 0 }, crashed = bucket();
    const { pipeline, uploadsFor } = setup(new MapperRegistry([fixtureMapper(calls)]), clock,
      { reserved: (key) => key.endsWith(`/${crashed}/summary.json`) });
    const upload = await pipeline.upload(actorA, new File([csv(150)], 'people.csv')), plan = planFor(upload.id), uploads = await uploadsFor(gymA);
    // Rows a crashed writer left under its own generation.
    const plans = previewPrefix(gymA, upload.id);
    await uploads.put(`${plans}crashed/pages/${uuidv7()}/rows-0000.json`, new TextEncoder().encode('[]'), 'application/json');
    const expected = (offset: number) => Array.from({ length: 10 }, (_, i) => expectedRow(offset + i, 'firstName'));
    expect((await pipeline.preview(actorA, plan, { limit: 10, offset: 0 }, 'UTC')).data).toEqual(expected(0));
    expect((await pipeline.preview(actorA, plan, { limit: 10, offset: 140 }, 'UTC')).data).toHaveLength(10);
    // One pass: this process remembers the preview it couldn't store, and its one row file stays until retention.
    expect(calls.analyze).toBe(2);
    const own = (await liveKeys(uploads, plans)).filter((key) => !key.startsWith(`${plans}crashed/`));
    expect(own).toHaveLength(1); expect(own[0]).toMatch(/\/pages\/[^/]+\/rows-0000\.json$/);
    // The next bucket is free again.
    clock.advance(PREVIEW_LIFETIME);
    await pipeline.preview(actorA, plan, { limit: 10, offset: 0 }, 'UTC');
    expect((await pipeline.preview(actorA, plan, { limit: 10, offset: 20 }, 'UTC')).data).toEqual(expected(20));
    expect(calls.analyze).toBe(4);
    expect((await liveKeys(uploads, plans)).filter((key) => key.endsWith('/summary.json'))).toHaveLength(1);
  });
  it('makes every stored preview stale when a real import of any upload starts or completes, but not a dry run', async () => {
    const calls = { analyze: 0 }, base = fixtureMapper(calls);
    let gate: { reached: () => void; released: Promise<void> } | undefined;
    const gated: CsvMapper = { ...base, async analyze(tx, rows, plan, context) {
      if (gate) { gate.reached(); await gate.released; }
      return base.analyze(tx, rows, plan, context);
    } };
    const { pipeline } = setup(new MapperRegistry([gated]));
    const people = await pipeline.upload(actorA, new File([csv(30)], 'people.csv'));
    const other = await pipeline.upload(actorA, new File([csv(40)], 'memberships.csv')), plan = planFor(other.id), page = { limit: 10, offset: 0 };
    // The memberships preview is one 40-row chunk: one analysis when it is computed, none when it is served.
    const analyses = async (request: Promise<unknown>) => { const before = calls.analyze; await request; return calls.analyze - before; };
    expect(await analyses(pipeline.preview(actorA, plan, page, 'UTC'))).toBe(1);
    await pipeline.start(actorA, { ...planFor(people.id), dryRun: true }, 'UTC');
    expect(await analyses(pipeline.preview(actorA, plan, page, 'UTC'))).toBe(0);
    // A real import of the people upload changes the members the memberships preview compared with.
    const job = await pipeline.start(actorA, { ...planFor(people.id), dryRun: false }, 'UTC');
    expect(await analyses(pipeline.preview(actorA, plan, page, 'UTC'))).toBe(1);
    expect(await analyses(pipeline.preview(actorA, plan, page, 'UTC'))).toBe(0);
    // So does its completion: the preview computed while it ran is not served after.
    await pipeline.run(gymA, job.id);
    expect((await database.forGym(gymA, (tx) => tx.select().from(importRuns).where(eq(importRuns.id, job.id))))[0]!.completedAt).toBeInstanceOf(Date);
    expect(await analyses(pipeline.preview(actorA, plan, page, 'UTC'))).toBe(1);
    // A run that starts while a preview is computing makes that preview stale: it is served to its own request only.
    let release!: () => void, reached!: () => void;
    const atMapper = new Promise<void>((resolve) => { reached = resolve; });
    gate = { reached, released: new Promise<void>((resolve) => { release = resolve; }) };
    const computing = pipeline.preview(actorA, plan, page, 'Europe/Paris');
    await atMapper;
    await pipeline.start(actorA, { ...planFor(people.id), dryRun: false }, 'UTC');
    release();
    expect((await computing).data).toHaveLength(10);
    gate = undefined;
    expect(await analyses(pipeline.preview(actorA, plan, page, 'Europe/Paris'))).toBe(1);
  });
  it('starts without touching storage after the run is committed and queued', async () => {
    const jobs = new FakeJobs(clock), { pipeline, calls } = setup(undefined, clock, { jobs });
    const upload = await pipeline.upload(actorA, new File([csv(150)], 'people.csv'));
    await pipeline.preview(actorA, planFor(upload.id), { limit: 10, offset: 0 }, 'UTC');
    let queued = -1;
    const enqueue = jobs.enqueue.bind(jobs);
    vi.spyOn(jobs, 'enqueue').mockImplementation(async (...args) => { const job = await enqueue(...args); queued = calls.length; return job; });
    const job = await pipeline.start(actorA, { ...planFor(upload.id), dryRun: false }, 'UTC');
    expect(queued).toBeGreaterThan(0);
    expect(calls.slice(queued)).toEqual([]);
    expect((await database.forGym(gymA, (tx) => tx.select().from(importRuns).where(eq(importRuns.id, job.id))))[0]).toMatchObject({ status: 'pending', dryRun: false });
  });
  it('refuses to run chunks against a file whose row count differs from the run', async () => {
    const { pipeline } = setup(), upload = await pipeline.upload(actorA, new File([csv(3)], 'people.csv'));
    const job = await pipeline.start(actorA, { ...planFor(upload.id), dryRun: true }, 'UTC');
    await database.forGym(gymA, (tx) => tx.update(importRuns).set({ totalRows: 5 }).where(eq(importRuns.id, job.id)));
    await expect(pipeline.run(gymA, job.id)).rejects.toThrow('Upload does not match the run');
  });
  it('removes a stored preview with its upload, and a late preview does not extend the upload', async () => {
    const { pipeline, uploadsFor } = setup(), retention = createImportRetention({ uploadsFor, clock, scope: database.forGym });
    const upload = await pipeline.upload(actorA, new File([csv(150)], 'people.csv'));
    clock.advance(UPLOAD_RETENTION_MS - 60_000);
    await pipeline.preview(actorA, planFor(upload.id), { limit: 50, offset: 0 }, 'UTC');
    const uploads = await uploadsFor(gymA), prefix = `${gymA}/imports/uploads/${upload.id}/`;
    expect((await liveKeys(uploads, prefix)).filter((key) => key.includes('/preview/'))).toHaveLength(2);
    expect(await retention.expire(gymA)).toBe(0);
    clock.advance(60_000);
    expect(await retention.expire(gymA)).toBe(1);
    expect(await liveKeys(uploads, prefix)).toEqual([]);
    expect((await uploads.list(prefix)).filter((info) => info.key.includes('/preview/')).every((info) => info.deletedAt)).toBe(true);
    await expect(pipeline.preview(actorA, planFor(upload.id), { limit: 50, offset: 0 }, 'UTC')).rejects.toMatchObject({ code: 'not_found' });
  });
  it('refuses to preview an upload marked deleted before it expires, as a restore does', async () => {
    const { pipeline, uploadsFor } = setup(), upload = await pipeline.upload(actorA, new File([csv(20)], 'people.csv'));
    await pipeline.preview(actorA, planFor(upload.id), { limit: 10, offset: 0 }, 'UTC');
    const uploads = await uploadsFor(gymA);
    for (const file of ['meta.json', 'source.csv']) await uploads.markDeleted(`${gymA}/imports/uploads/${upload.id}/${file}`);
    await expect(pipeline.preview(actorA, planFor(upload.id), { limit: 10, offset: 0 }, 'UTC')).rejects.toMatchObject({ code: 'not_found' });
  });
  it('never serves one gym a preview stored for another', async () => {
    const calls = { analyze: 0 }, { pipeline, uploadsFor } = setup(new MapperRegistry([fixtureMapper(calls)]));
    const upload = await pipeline.upload(actorA, new File([csv(40)], 'people.csv')), plan = planFor(upload.id);
    await pipeline.preview(actorA, plan, { limit: 50, offset: 0 }, 'UTC');
    const stored = await liveKeys(await uploadsFor(gymA), `${gymA}/imports/`);
    expect(stored.some((key) => key.includes('/preview/'))).toBe(true);
    // Gym B names gym A's upload: it is not found, and nothing is read from or written to either gym's preview.
    const before = calls.analyze;
    await expect(pipeline.preview(actorB, plan, { limit: 50, offset: 0 }, 'UTC')).rejects.toMatchObject({ code: 'not_found' });
    await expect(pipeline.start(actorB, { ...plan, dryRun: true }, 'UTC')).rejects.toMatchObject({ code: 'not_found' });
    expect(calls.analyze).toBe(before);
    expect(await liveKeys(await uploadsFor(gymB), `${gymB}/imports/`)).toEqual([]);
    // Storage is gym-scoped too: gym B's handle cannot read gym A's stored preview key directly.
    const previewKey = stored.find((key) => key.endsWith('/summary.json'))!;
    expect(previewKey).toMatch(new RegExp('^' + gymA + '/imports/uploads/' + upload.id + '/preview/'));
    await expect((await uploadsFor(gymB)).get(previewKey)).rejects.toThrow('another gym');
    expect(await (await uploadsFor(gymA)).head(previewKey)).not.toBeNull();
    // A real import in gym B leaves gym A's preview fresh; gym B's own upload gets its own preview, never gym A's rows.
    const other = await pipeline.upload(actorB, new File(['Name,Email\r\nBee,b@example.test\r\n'], 'people.csv'));
    await pipeline.start(actorB, { ...planFor(other.id), dryRun: false }, 'UTC');
    await pipeline.preview(actorA, plan, { limit: 50, offset: 0 }, 'UTC');
    expect(calls.analyze).toBe(before);
    const preview = await pipeline.preview(actorB, planFor(other.id), { limit: 50, offset: 0 }, 'UTC');
    expect(preview.summary.totalRows).toBe(1); expect(preview.data).toHaveLength(1);
    expect((await liveKeys(await uploadsFor(gymA), `${gymA}/imports/`)).filter((key) => key.includes('/preview/'))).toEqual(stored.filter((key) => key.includes('/preview/')));
  });
  it('starts from the upload metadata without reading the CSV', async () => {
    const { pipeline, uploadsFor, fail } = setup();
    const upload = await pipeline.upload(actorA, new File([csv(230)], 'people.csv'));
    fail.add(`${gymA}/imports/uploads/${upload.id}/source.csv`);
    const job = await pipeline.start(actorA, { ...planFor(upload.id), dryRun: true }, 'UTC');
    expect(job).toMatchObject({ totalRows: 230, status: 'pending' });
    expect(upload.rowCount).toBe(230);
    await expect(pipeline.start(actorA, { ...planFor(upload.id, 'Nope'), dryRun: true }, 'UTC')).rejects.toMatchObject({ code: 'invalid_request' });
    // A source that is gone is still reported before a run is created.
    const gone = await pipeline.upload(actorA, new File([csv(3)], 'gone.csv'));
    await (await uploadsFor(gymA)).markDeleted(`${gymA}/imports/uploads/${gone.id}/source.csv`);
    await expect(pipeline.start(actorA, { ...planFor(gone.id), dryRun: true }, 'UTC')).rejects.toMatchObject({ code: 'not_found' });
  });
});
