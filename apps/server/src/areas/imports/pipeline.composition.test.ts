// SPDX-License-Identifier: AGPL-3.0-only
// Install the OpenAPI schema extension before constructing shared contracts, as app startup does.
import '@hono/zod-openapi';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { importRuns, exportRuns, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { exportJobSchema, importJobSchema, importUploadSchema } from '@plaingym/shared/contracts';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { createUploadDownloadRoute } from '../../core/uploads-download.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { LocalUploads } from '../../infra/storage/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { createImportPipeline } from './pipeline.js';
import { createPipelineRoutes } from './pipeline.routes.js';
import { createPipelineJobs } from './pipeline.jobs.js';
import { createExportService } from './export.js';
import { createExportRoutes } from './export.routes.js';
import { createExportJobs } from './export.jobs.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2099-10-24T00:00:00Z');
const gymId = uuidv7(), origin = 'https://imports.example.test';
let root: string, userId: string, storage: LocalUploads;
beforeAll(async () => {
  await factory('gyms', gymId); userId = (await factory('authUser', gymId)).id;
  root = await mkdtemp(join(tmpdir(), 'plaingym-import-runs-'));
  storage = new LocalUploads({ root, gymId, signingKey: new Uint8Array(32).fill(7), clock, downloadUrl: origin + '/api/uploads/download' });
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
function server(principal: Principal = { kind: 'staff', gymId, userId, roles: ['owner'] }) {
  const jobs = new FakeJobs(clock), options = { scope: database.forGym, clock, jobs, uploadsFor: async () => storage };
  const pipeline = createImportPipeline(options), exports = createExportService(options);
  const contributions = { routes: [...createPipelineRoutes(pipeline), ...createExportRoutes(exports),
    createUploadDownloadRoute({ uploadsFor: options.uploadsFor, origin: () => origin })],
  jobs: [...createPipelineJobs(pipeline), ...createExportJobs(exports)] };
  createServerRegistry(contributions).registerJobs(jobs, new Set());
  const app = createApp({ clock, origin, authorize, contributions,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); },
  });
  return { app, jobs };
}
const post = (app: ReturnType<typeof server>['app'], path: string, body: unknown) => app.request(origin + path, {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

it('imports, restarts its API, exports, and follows the archive link through the app composition', async () => {
  const { app, jobs } = server(), form = new FormData();
  form.set('file', new File(['First Name,Last Name\nTest,Imported\n'], 'people.csv'));
  const response = await app.request(origin + '/api/imports/uploads', { method: 'POST', headers: { origin }, body: form });
  expect(response.status).toBe(200);
  const uploaded = importUploadSchema.parse((await response.json()).data);
  const started = await post(app, '/api/imports', { uploadId: uploaded.id, mapper: 'people', dryRun: false, duplicatePolicy: 'error',
    mapping: [{ sourceColumn: 'First Name', targetField: 'firstName' }, { sourceColumn: 'Last Name', targetField: 'lastName' }] });
  expect(started.status).toBe(200);
  const run = importJobSchema.parse((await started.json()).data);
  await jobs.runNext();
  const restarted = server();
  const status = await restarted.app.request(origin + '/api/imports/' + run.id);
  expect(importJobSchema.parse((await status.json()).data)).toMatchObject({ status: 'succeeded', processedRows: 1, committedRows: 1 });
  const created = await post(restarted.app, '/api/exports', { format: 'csv' }); expect(created.status).toBe(200);
  const exported = exportJobSchema.parse((await created.json()).data);
  await restarted.jobs.runNext();
  const result = exportJobSchema.parse((await (await restarted.app.request(origin + '/api/exports/' + exported.id)).json()).data);
  expect(result.status).toBe('succeeded');
  const download = await restarted.app.request(result.downloadUrl!);
  expect(download.status).toBe(200); expect(await download.text()).toContain('Imported');
  expect(await database.forGym(gymId, (tx) => tx.select().from(importRuns))).toHaveLength(1);
  expect(await database.forGym(gymId, (tx) => tx.select().from(exportRuns))).toHaveLength(1);
});

it('denies anonymous, member, kiosk, and foreign staff principals on every import/export route', async () => {
  const principals: Principal[] = [{ kind: 'anonymous' },
    { kind: 'member', userId, scope: { gymId, householdId: uuidv7(), role: 'payer' } },
    { kind: 'kiosk', gymId, deviceId: uuidv7() }, { kind: 'staff', gymId: uuidv7(), userId, roles: ['owner'] }];
  for (const principal of principals) {
    const { app } = server(principal), denied = principal.kind === 'anonymous' ? 401 : 403;
    for (const path of ['/api/imports/uploads', '/api/imports/preview', '/api/imports', '/api/exports'])
      expect((await post(app, path, {})).status, path).toBe(denied);
    for (const path of [`/api/imports/${uuidv7()}`, `/api/imports/${uuidv7()}/errors`, `/api/exports/${uuidv7()}`])
      expect((await app.request(origin + path)).status, path).toBe(denied);
  }
});
