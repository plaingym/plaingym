// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, staffRoles, type StaffRole } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { ImportJob } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import type { RequestEnvironment } from '../../core/context.js';
import { authorize } from '../staff/auth.permissions.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createSetupService } from './setup.js';
import { createSetupRoutes } from './setup.routes.js';
import { createImportPipeline } from '../imports/pipeline.js';
import { MapperRegistry } from '../imports/mappers/registry.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createImportStep, type ImportRuns } from './import-step.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-22T12:00:00Z');
const setup = createSetupService({ key: parseEncryptionKey('ab'.repeat(32)), origin: 'http://gym.localhost', clock, scope: database.forGym });
let gymA: string, gymB: string, ownerA: string, ownerB: string;
const runs = new Map<string, ImportJob>();
const imports: ImportRuns = { async get(gymId, id) {
  assertNoTransaction('setup import progress');
  const job = runs.get(gymId + '/' + id);
  if (!job) throw new AppError('not_found', 'Import resource not found or expired.');
  return job;
} };
const step = createImportStep({ imports, scope: database.forGym, clock });
const context = (gymId: string, userId: string) => ({ gymId, actor: { kind: 'user' as const, userId } });
async function wizardAtStep8(name: string) {
  const gymId = uuidv7();
  // Both switches start on so the test proves that finishing turns them off.
  await factory('gyms', gymId, { name, billingEnabled: true, memberEmailsEnabled: true });
  const owner = (await factory('authUser', gymId)).id;
  await database.forGym(gymId, (tx) => tx.update(gyms).set({
    settings: { setup: { completedSteps: [0, 1, 2, 3, 4, 5, 6, 7], completed: false, ownerId: owner } } }).where(eq(gyms.id, gymId)));
  return { gymId, owner };
}
/** Records an import run the way the pipeline does: committed runs audit `imports.started` with the run ID. */
async function importRun(gymId: string, owner: string, job: Partial<ImportJob> = {}) {
  const id = uuidv7();
  const value: ImportJob = { id, uploadId: uuidv7(), mapper: 'people', dryRun: false, status: 'succeeded', totalRows: 2,
    processedRows: 2, committedRows: 2, errorCount: 0, createdAt: clock.now().toISOString(), completedAt: clock.now().toISOString(), ...job };
  runs.set(gymId + '/' + id, value);
  if (!value.dryRun) await database.forGym(gymId, (tx) => writeAudit(tx, { id, gymId, actorKind: 'user', actorUserId: owner,
    action: 'imports.started', targetType: 'import', targetId: id, after: { totalRows: value.totalRows }, occurredAt: clock.now() }));
  return id;
}
const revision = async (gymId: string) => (await database.forGym(gymId, (tx) => tx.select().from(gyms).where(eq(gyms.id, gymId))))[0]!;
function server(role: StaffRole | 'anonymous', userId = ownerA, gymId = gymA) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, clock, requestId: 'import-step-test',
      principal: role === 'anonymous' ? { kind: 'anonymous' } : { kind: 'staff', gymId, userId, roles: [role] } });
    await next();
  });
  app.onError(errorHandler);
  // This is the same composition hook the integration owner will connect in setup.routes.ts.
  createServerRegistry({ routes: createSetupRoutes(() => ({ ...setup, finish: (context, input) => step.finish(setup, context, input) })) })
    .mount(app, authorize, new Set());
  return app;
}
const finishRequest = (app: ReturnType<typeof server>, input: unknown) => app.request('/api/setup/finish', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
});
beforeEach(async () => {
  ({ gymId: gymA, owner: ownerA } = await wizardAtStep8('Gym A'));
  ({ gymId: gymB, owner: ownerB } = await wizardAtStep8('Gym B'));
});

describe('setup step 8: import or start fresh', () => {
  it('finishes with a committed import and leaves billing and member emails off', async () => {
    const importId = await importRun(gymA, ownerA);
    const before = await revision(gymA);
    const result = await step.finish(setup, context(gymA, ownerA), { choice: 'import', revision: before.revision, importId });
    expect(result).toEqual({ completed: true, billingEnabled: false, memberEmailsEnabled: false, revision: before.revision + 1 });
    const after = await revision(gymA);
    expect(after).toMatchObject({ billingEnabled: false, memberEmailsEnabled: false });
    expect((after.settings as { setup: { completed: boolean } }).setup.completed).toBe(true);
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'setup.import_selected')));
    expect(audits).toEqual([expect.objectContaining({ targetId: importId, actorUserId: ownerA,
      after: { mapper: 'people', committedRows: 2, billingEnabled: false, memberEmailsEnabled: false } })]);
    // Setup is closed afterwards.
    await expect(step.finish(setup, context(gymA, ownerA), { choice: 'import', revision: after.revision, importId })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('delegates a fresh start unchanged', async () => {
    const { revision: current } = await revision(gymA);
    expect(await step.finish(setup, context(gymA, ownerA), { choice: 'fresh', revision: current }))
      .toEqual({ completed: true, billingEnabled: false, memberEmailsEnabled: false, revision: current + 1 });
    expect(await revision(gymA)).toMatchObject({ billingEnabled: false, memberEmailsEnabled: false });
  });
  it('never accepts another gym\'s import, a dry run, or a failed run, and changes nothing', async () => {
    const other = await importRun(gymB, ownerB);
    // Even if a progress record were visible, gym A has no committed run with gym B's ID.
    runs.set(gymA + '/' + other, runs.get(gymB + '/' + other)!);
    const dry = await importRun(gymA, ownerA, { dryRun: true, committedRows: 0 });
    const failed = await importRun(gymA, ownerA, { status: 'failed' });
    const before = await revision(gymA);
    for (const importId of [other, dry, failed, uuidv7()])
      await expect(step.finish(setup, context(gymA, ownerA), { choice: 'import', revision: before.revision, importId }))
        .rejects.toMatchObject({ code: importId === failed ? 'invalid_request' : 'not_found' });
    expect(await revision(gymA)).toEqual(before);
  });
  it('waits for a running import and fails closed without import progress', async () => {
    const running = await importRun(gymA, ownerA, { status: 'running', processedRows: 1, committedRows: 1, completedAt: null });
    const { revision: current } = await revision(gymA);
    await expect(step.finish(setup, context(gymA, ownerA), { choice: 'import', revision: current, importId: running }))
      .rejects.toMatchObject({ code: 'conflict' });
    const done = await importRun(gymA, ownerA);
    await expect(createImportStep({ scope: database.forGym, clock }).finish(setup, context(gymA, ownerA), { choice: 'import', revision: current, importId: done }))
      .rejects.toMatchObject({ code: 'unavailable' });
    expect(await revision(gymA)).toMatchObject({ revision: current, billingEnabled: true, memberEmailsEnabled: true });
  });
  it('only lets this gym\'s setup owner finish', async () => {
    const importId = await importRun(gymA, ownerA);
    const { revision: current } = await revision(gymA);
    await expect(step.finish(setup, context(gymA, ownerB), { choice: 'import', revision: current, importId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(step.finish(setup, context(gymB, ownerB), { choice: 'import', revision: current, importId })).rejects.toMatchObject({ code: 'not_found' });
    expect(await revision(gymA)).toMatchObject({ revision: current, billingEnabled: true });
  });
  it.each([...staffRoles, 'anonymous'] as const)('requires the setup owner at the finish endpoint (%s)', async (role) => {
    const importId = await importRun(gymA, ownerA), before = await revision(gymA);
    const response = await finishRequest(server(role), { choice: 'import', revision: before.revision, importId });
    expect(response.status).toBe(role === 'owner' ? 200 : role === 'anonymous' ? 401 : 403);
    if (role !== 'owner') expect(await revision(gymA)).toEqual(before);
  });
  it('returns 404 for another gym import and for an owner who did not start this setup', async () => {
    const own = await importRun(gymA, ownerA), other = await importRun(gymB, ownerB), before = await revision(gymA);
    expect((await finishRequest(server('owner'), { choice: 'import', revision: before.revision, importId: other })).status).toBe(404);
    expect((await finishRequest(server('owner', ownerB), { choice: 'import', revision: before.revision, importId: own })).status).toBe(404);
    expect(await revision(gymA)).toEqual(before);
  });
  it('rejects stale revisions and an unfinished backup step without completing setup', async () => {
    const importId = await importRun(gymA, ownerA), before = await revision(gymA);
    expect((await finishRequest(server('owner'), { choice: 'import', revision: before.revision + 1, importId })).status).toBe(409);
    await database.forGym(gymA, (tx) => tx.update(gyms).set({ settings: { setup: {
      completed: false, completedSteps: [0, 1, 2, 3, 4, 5, 6], ownerId: ownerA } } }).where(eq(gyms.id, gymA)));
    expect((await finishRequest(server('owner'), { choice: 'import', revision: before.revision, importId })).status).toBe(409);
    expect(await revision(gymA)).toMatchObject({ revision: before.revision, billingEnabled: true, memberEmailsEnabled: true });
  });
  it('checks the revision again after reading import progress outside the transaction', async () => {
    const importId = await importRun(gymA, ownerA), before = await revision(gymA);
    const racing = createImportStep({ scope: database.forGym, clock, imports: { async get(gymId, id) {
      const job = await imports.get(gymId, id);
      await database.forGym(gymId, (tx) => tx.update(gyms).set({ revision: before.revision + 1 }).where(eq(gyms.id, gymId)));
      return job;
    } } });
    await expect(racing.finish(setup, context(gymA, ownerA), { choice: 'import', revision: before.revision, importId }))
      .rejects.toMatchObject({ name: 'RevisionConflictError' });
    const after = await revision(gymA);
    expect(after).toMatchObject({ revision: before.revision + 1, billingEnabled: true, memberEmailsEnabled: true });
    expect((after.settings as { setup: { completed: boolean } }).setup.completed).toBe(false);
    expect(await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'setup.import_selected')))).toEqual([]);
  });
  it('finishes with a real pipeline run using immutable gym-scoped uploads', async () => {
    const storage = new FakeUploads(gymA, clock);
    const pipeline = createImportPipeline({ scope: database.forGym, clock, jobs: new FakeJobs(clock),
      uploadsFor: async () => storage,
      // Mapper implementations are separate tasks; exercise the real pipeline and run state here.
      mappers: new MapperRegistry([{ id: 'people', available: true,
        async analyze(_tx, rows) { return rows.map((row) => ({ ...row, action: 'skip', duplicateIds: [], issues: [] })); },
        async commit() { throw new Error('Skipped rows must not commit'); },
      }]),
    });
    const actor = context(gymA, ownerA);
    const upload = await pipeline.upload(actor, new File(['Name\nAna\n'], 'members.csv', { type: 'text/csv' }));
    const run = await pipeline.start(actor, { uploadId: upload.id, mapper: 'people', mapping: [{ sourceColumn: 'Name', targetField: 'firstName' }],
      duplicatePolicy: 'skip', dryRun: false }, 'UTC');
    await pipeline.run(gymA, run.id);
    const realStep = createImportStep({ imports: pipeline, scope: database.forGym, clock });
    const before = await revision(gymA);
    expect(await realStep.finish(setup, actor, { choice: 'import', revision: before.revision, importId: run.id }))
      .toMatchObject({ completed: true, billingEnabled: false, memberEmailsEnabled: false });
    expect(await revision(gymA)).toMatchObject({ billingEnabled: false, memberEmailsEnabled: false });
  });
});
