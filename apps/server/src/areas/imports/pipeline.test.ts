// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, attendances, forGym, memberTags, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, canStaff, errorResponse, staffRoles, type StaffRole } from '@plaingym/shared';
import { exportDatasets, exportJobSchema, importJobSchema, importUploadSchema, type ImportPlanRequest } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { RequestEnvironment } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createImportPipeline, IMPORT_CHUNK_SIZE } from './pipeline.js';
import { createPipelineRoutes } from './pipeline.routes.js';
import { createPipelineJobs } from './pipeline.jobs.js';
import { createExportService } from './export.js';
import { createExportRoutes } from './export.routes.js';
import { createExportJobs } from './export.jobs.js';
import { exportCatalog } from './export.catalog.js';
import { MapperRegistry, type CsvMapper } from './mappers/registry.js';

const database = useTestDatabase(), factory = createFactories(database);
// The injected clock follows fixture creation times; exports include rows that existed when requested.
const clock = new TestClock('2099-10-22T12:00:00Z'), gymA = uuidv7(), gymB = uuidv7();
const actor = { gymId: gymA, actor: { kind: 'system' } } as const;
const stores = new Map<string, FakeUploads>();
const uploadsFor = async (gymId: string) => {
  if (!stores.has(gymId)) stores.set(gymId, new FakeUploads(gymId, clock));
  return stores.get(gymId)!;
};
function fixtureMapper(overrides: Partial<CsvMapper> = {}): CsvMapper {
  return { id: 'people', available: true,
    async analyze(_tx, rows) { return rows.map((row) => ({ ...row, action: 'create', duplicateIds: [], issues: [] })); },
    async commit(tx, rows, context) {
      await tx.insert(memberTags).values(rows.map((row) => ({ gymId: context.gymId, name: context.runId + ':' + row.rowNumber + ':' + uuidv7(), createdAt: context.clock.now() })));
      return rows.length;
    }, ...overrides };
}
function services(mapper = fixtureMapper(), storage = uploadsFor, scope: typeof forGym = database.forGym) {
  const jobs = new FakeJobs(clock), options = { uploadsFor: storage, jobs, scope, clock, mappers: new MapperRegistry([mapper]) };
  const pipeline = createImportPipeline(options), exports = createExportService(options);
  const registry = createServerRegistry({ routes: [...createPipelineRoutes(pipeline), ...createExportRoutes(exports)],
    jobs: [...createPipelineJobs(pipeline), ...createExportJobs(exports)] });
  registry.registerJobs(jobs, new Set());
  return { pipeline, exports, jobs, registry };
}
const shared = services();
let userId: string;
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); userId = (await factory('authUser', gymA)).id; });
async function upload(pipeline: ReturnType<typeof services>['pipeline'], count = 2, gymId = gymA) {
  const file = new File(['First Name,Email\r\n' + Array.from({ length: count }, (_, i) => `Person ${i},person${i}@example.test\r\n`).join('')], 'people.csv');
  return pipeline.upload({ ...actor, gymId }, file);
}
const plan = (uploadId: string): ImportPlanRequest => ({ uploadId, mapper: 'people', mapping: [{ sourceColumn: 'First Name', targetField: 'firstName' }], duplicatePolicy: 'error' });
function server(role: StaffRole, gymId = gymA, principalGym = gymId) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, principal: { kind: 'staff', gymId: principalGym, userId, roles: [role] }, clock, requestId: 'imports-test' });
    await next();
  });
  app.onError((error, c) => c.json(errorResponse(error, 'imports-test'), error instanceof AppError ? error.status : 500));
  shared.registry.mount(app, (permission) => async (c, next) => {
    const context = c.get('context'), principal = context.principal;
    if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId) return c.notFound();
    if (permission.kind !== 'staff' || !canStaff(principal.roles, permission.capability)) return c.json({ error: 'forbidden' }, 403);
    await next();
  }, new Set());
  return app;
}
const post = (app: ReturnType<typeof server>, path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
describe('import pipeline using Postgres and immutable uploads', () => {
  it('commits 5,000 rows in 100-row transactions, allowing a check-in between chunks', async () => {
    const member = await factory('members', gymA);
    let maxChunk = 0, checkinAt = 0;
    const mapper = fixtureMapper({ async commit(tx, rows, context) {
      maxChunk = Math.max(maxChunk, rows.length); return fixtureMapper().commit(tx, rows, context);
    } });
    class CheckinUploads extends FakeUploads {
      override async put(key: string, ...args: Parameters<FakeUploads['put']> extends [string, ...infer R] ? R : never) {
        if (key.endsWith('state-00000002.json')) {
          // Storage is reached outside the import transaction, before the next chunk begins.
          const tags = await database.forGym(gymA, (tx) => tx.select({ id: memberTags.id }).from(memberTags));
          checkinAt = tags.length;
          await database.forGym(gymA, (tx) => tx.insert(attendances).values({ gymId: gymA, memberId: member.id, source: 'coach', occurredAt: clock.now() }));
        }
        return super.put(key, ...args);
      }
    }
    const storage = new CheckinUploads(gymA, clock), { pipeline, jobs } = services(mapper, async () => storage);
    const before = (await database.forGym(gymA, (tx) => tx.select().from(memberTags))).length;
    const data = await upload(pipeline, 5000), job = await pipeline.start(actor, { ...plan(data.id), dryRun: false }, 'UTC');
    await jobs.runNext();
    expect(await pipeline.get(gymA, job.id)).toMatchObject({ status: 'succeeded', processedRows: 5000, committedRows: 5000, errorCount: 0 });
    expect(maxChunk).toBe(IMPORT_CHUNK_SIZE); expect(checkinAt - before).toBe(IMPORT_CHUNK_SIZE);
    expect((await database.forGym(gymA, (tx) => tx.select().from(attendances).where(eq(attendances.memberId, member.id))))).toHaveLength(1);
    expect((await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, job.id))))).toHaveLength(51);
  }, 60_000);
  it('a dry run and preview leave every gym-owned table unchanged', async () => {
    const { pipeline, jobs } = services(), data = await upload(pipeline);
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const [name, dataset] of Object.entries(exportCatalog)) result[name] = await database.forGym(gymA, (tx) => tx.select().from(dataset.table).orderBy(dataset.table.id));
      return result;
    };
    const before = await snapshot();
    expect((await pipeline.preview(actor, plan(data.id), { limit: 50, offset: 0 })).summary.create).toBe(2);
    const job = await pipeline.start(actor, { ...plan(data.id), dryRun: true }, 'UTC'); await jobs.runNext();
    expect(await pipeline.get(gymA, job.id)).toMatchObject({ status: 'succeeded', committedRows: 0, processedRows: 2 });
    expect(await snapshot()).toEqual(before);
  });
  it('resumes after a crash between a committed chunk and its storage progress update without duplicates', async () => {
    let crashed = false;
    class CrashUploads extends FakeUploads {
      override async put(key: string, ...args: Parameters<FakeUploads['put']> extends [string, ...infer R] ? R : never) {
        if (!crashed && key.endsWith('state-00000002.json')) { crashed = true; throw new Error('simulated worker crash'); }
        return super.put(key, ...args);
      }
    }
    const storage = new CrashUploads(gymA, clock), { pipeline } = services(fixtureMapper(), async () => storage);
    const data = await upload(pipeline, 250), job = await pipeline.start(actor, { ...plan(data.id), dryRun: false }, 'UTC');
    await expect(pipeline.run(gymA, job.id)).rejects.toThrow('simulated worker crash');
    // A new process uses the same DB and objects, with no in-memory run state.
    const restarted = services(fixtureMapper(), async () => storage).pipeline;
    await Promise.all([restarted.run(gymA, job.id), restarted.run(gymA, job.id)]);
    expect(await restarted.get(gymA, job.id)).toMatchObject({ status: 'succeeded', processedRows: 250, committedRows: 250 });
    const rows = await database.forGym(gymA, (tx) => tx.select().from(memberTags));
    expect(rows.filter((row) => row.name.startsWith(job.id + ':'))).toHaveLength(250);
  });
  it('rolls back the entire failed chunk and paginates safe error reports', async () => {
    const { pipeline, jobs } = services(fixtureMapper({ async commit(tx, rows, context) {
      await fixtureMapper().commit(tx, rows, context); throw new Error('private SQL value');
    } }));
    const data = await upload(pipeline, 150), job = await pipeline.start(actor, { ...plan(data.id), dryRun: false }, 'UTC'); await jobs.runNext();
    expect(await pipeline.get(gymA, job.id)).toMatchObject({ status: 'failed', committedRows: 0, processedRows: 150, errorCount: 150 });
    const report = await pipeline.errors(gymA, job.id, { limit: 50, offset: 100 });
    expect(report.data).toHaveLength(50); expect(report.pagination.total).toBe(150); expect(JSON.stringify(report)).not.toContain('private SQL');
    const rows = await database.forGym(gymA, (tx) => tx.select().from(memberTags));
    expect(rows.some((row) => row.name.startsWith(job.id + ':'))).toBe(false);
  });
  it.each(['skip', 'update', 'error'] as const)('applies duplicate policy %s in preview and execution', async (duplicatePolicy) => {
    const duplicateId = uuidv7();
    const { pipeline, jobs } = services(fixtureMapper({ async analyze(_tx, rows) {
      return rows.map((row) => ({ ...row, action: 'create', duplicateIds: [duplicateId], issues: [] }));
    } }));
    const data = await upload(pipeline, 1), input = { ...plan(data.id), duplicatePolicy };
    const preview = await pipeline.preview(actor, input, { limit: 1, offset: 0 });
    expect(preview.data[0]!.action).toBe(duplicatePolicy === 'error' ? 'error' : duplicatePolicy);
    const job = await pipeline.start(actor, { ...input, dryRun: false }, 'UTC'); await jobs.runNext();
    expect(await pipeline.get(gymA, job.id)).toMatchObject({ committedRows: duplicatePolicy === 'update' ? 1 : 0, errorCount: duplicatePolicy === 'error' ? 1 : 0 });
  });
  it('rejects missing columns, expired uploads and malformed UTF-8', async () => {
    const { pipeline } = services(), data = await upload(pipeline);
    await expect(pipeline.preview(actor, { ...plan(data.id), mapping: [{ sourceColumn: 'nonexistent', targetField: 'email' }] }, { limit: 50, offset: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(pipeline.upload(actor, new File([new Uint8Array([255])], 'bad.csv'))).rejects.toMatchObject({ code: 'invalid_request' });
    const later = createImportPipeline({ uploadsFor, jobs: new FakeJobs(clock), scope: database.forGym, clock: new TestClock('2100-01-01Z') });
    await expect(later.preview(actor, plan(data.id), { limit: 50, offset: 0 })).rejects.toMatchObject({ code: 'not_found' });
  });
});
describe('full CSV exports', () => {
  it('exports all datasets and excludes other gyms, credentials, and nested secret carriers', async () => {
    const b = await factory('members', gymB, { firstName: 'OTHER_GYM_PRIVATE' });
    await factory('members', gymA, { firstName: '=FORMULA', checkinCodeHash: 'c'.repeat(64) });
    await factory('households', gymA, { name: 'Export household', pinHash: 'PIN_SECRET_HASH' });
    await factory('kioskDevices', gymA, { tokenHash: 'd'.repeat(64) });
    await factory('auditEvents', gymA, { after: { config: 'ENCRYPTED_NESTED_SECRET' } });
    await factory('emailOutbox', gymA, { html: 'SECRET_LOGIN_LINK', text: 'SECRET_LOGIN_LINK' });
    const { exports, jobs } = services(), job = await exports.create(actor, 'UTC'); await jobs.runNext();
    const result = await exports.get(gymA, job.id);
    expect(exportJobSchema.safeParse(result).success).toBe(true); expect(result.status).toBe('succeeded');
    const storage = await uploadsFor(gymA), archive = await storage.get(`${gymA}/imports/exports/${job.id}/export.zip`);
    const raw = await new Response(archive).text();
    for (const dataset of exportDatasets) expect(raw).toContain(dataset + '.csv');
    expect(raw).toContain("'=FORMULA");
    for (const forbidden of ['OTHER_GYM_PRIVATE', b.id, gymB, 'c'.repeat(64), 'd'.repeat(64), 'PIN_SECRET_HASH', 'ENCRYPTED_NESTED_SECRET', 'SECRET_LOGIN_LINK', 'pin_hash', 'token_hash', 'checkin_code_hash']) expect(raw).not.toContain(forbidden);
    await expect(exports.get(gymB, job.id)).rejects.toMatchObject({ code: 'not_found' });
    const expired = createExportService({ uploadsFor, jobs: new FakeJobs(clock), scope: database.forGym, clock: new TestClock('2100-01-01Z') });
    await expect(expired.get(gymA, job.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
describe('HTTP permissions and gym isolation', () => {
  it.each(staffRoles)('allows only owner/admin on all seven routes (%s)', async (role) => {
    const app = server(role), allowed = role === 'owner' || role === 'admin';
    const form = new FormData(); form.set('file', new File(['First Name\nTest'], 'test.csv'));
    const uploadResponse = await app.request('/api/imports/uploads', { method: 'POST', body: form });
    expect(uploadResponse.status).toBe(allowed ? 200 : 403);
    if (!allowed) {
      for (const path of ['/api/imports/preview', '/api/imports', '/api/exports']) expect((await post(app, path, {})).status).toBe(403);
      for (const path of [`/api/imports/${uuidv7()}`, `/api/imports/${uuidv7()}/errors`, `/api/exports/${uuidv7()}`]) expect((await app.request(path)).status).toBe(403);
      return;
    }
    const data = importUploadSchema.parse((await uploadResponse.json() as { data: unknown }).data);
    const input = plan(data.id);
    expect((await post(app, '/api/imports/preview', input)).status).toBe(200);
    const start = await post(app, '/api/imports', { ...input, dryRun: true }); expect(start.status).toBe(200);
    const run = importJobSchema.parse((await start.json() as { data: unknown }).data);
    expect((await app.request(`/api/imports/${run.id}`)).status).toBe(200);
    expect((await app.request(`/api/imports/${run.id}/errors`)).status).toBe(200);
    const exported = await post(app, '/api/exports', { format: 'csv' }); expect(exported.status).toBe(200);
    const exportJob = exportJobSchema.parse((await exported.json() as { data: unknown }).data);
    expect((await app.request(`/api/exports/${exportJob.id}`)).status).toBe(200);
  });
  it('returns 404 for gym B uploads/jobs from gym A and for a mismatched principal on every route', async () => {
    const data = await upload(shared.pipeline, 1, gymB), input = plan(data.id);
    const run = await shared.pipeline.start({ ...actor, gymId: gymB }, { ...input, dryRun: true }, 'UTC');
    const exported = await shared.exports.create({ ...actor, gymId: gymB }, 'UTC'), app = server('owner');
    expect((await post(app, '/api/imports/preview', input)).status).toBe(404);
    expect((await post(app, '/api/imports', { ...input, dryRun: false })).status).toBe(404);
    for (const path of [`/api/imports/${run.id}`, `/api/imports/${run.id}/errors`, `/api/exports/${exported.id}`]) expect((await app.request(path)).status).toBe(404);
    const mismatch = server('owner', gymB, gymA), form = new FormData(); form.set('file', new File(['Name\nTest'], 'test.csv'));
    expect((await mismatch.request('/api/imports/uploads', { method: 'POST', body: form })).status).toBe(404);
    for (const path of ['/api/imports/preview', '/api/imports', '/api/exports']) expect((await post(mismatch, path, {})).status).toBe(404);
    for (const path of [`/api/imports/${run.id}`, `/api/imports/${run.id}/errors`, `/api/exports/${exported.id}`]) expect((await mismatch.request(path)).status).toBe(404);
  });
});
describe('OpenAPI documentation for composed routes', () => {
  it('documents the import and export routes, including the multipart upload', () => {
    const jobs = new FakeJobs(), app = new OpenAPIHono<RequestEnvironment>();
    const routes = [...createPipelineRoutes(createImportPipeline({ uploadsFor, jobs, scope: database.forGym, clock })),
      ...createExportRoutes(createExportService({ uploadsFor, jobs, scope: database.forGym, clock }))];
    createServerRegistry({ routes }).mount(app, () => async (_c, next) => { await next(); }, () => new Set());
    const document = app.getOpenAPIDocument({ openapi: '3.0.0', info: { title: 'test', version: '1' } });
    expect(Object.keys(document.paths ?? {})).toEqual(expect.arrayContaining(['/api/imports/uploads', '/api/exports']));
  });
});
