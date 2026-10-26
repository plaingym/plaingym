// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeEach, expect, it } from 'vitest';
import { memberships, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { importJobSchema, importPreviewResponseSchema, importUploadSchema } from '@plaingym/shared/contracts';
import type { StaffRole } from '@plaingym/shared';
import { createApp } from '../../../core/app.js';
import { TestClock } from '../../../core/clock.js';
import type { Principal } from '../../../core/context.js';
import { createServerRegistry } from '../../../core/registry.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { FakeUploads } from '../../../infra/storage/index.js';
import { authorize } from '../../staff/auth.permissions.js';
import { createImportPipeline } from '../pipeline.js';
import { createPipelineRoutes } from '../pipeline.routes.js';
import { createPipelineJobs } from '../pipeline.jobs.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-26T12:00:00Z');
const origin = 'https://imports.example.test';
let gymId: string, foreignGym: string, userId: string, text: string;
let service: ReturnType<typeof createImportPipeline>, jobs: FakeJobs;
beforeEach(async () => {
  gymId = uuidv7(); foreignGym = uuidv7();
  await factory('gyms', gymId, { currency: 'CAD' }); await factory('gyms', foreignGym, { currency: 'CAD' });
  userId = (await factory('authUser', gymId)).id;
  const member = await factory('members', gymId, { email: 'private@example.test' });
  const plan = await factory('plans', gymId, { name: 'Annual', interval: 'annual' });
  text = `Email,Plan,Next Due On\n${member.email},${plan.id},2028-02-29\n`;
  const storage = new Map<string, FakeUploads>(); jobs = new FakeJobs(clock);
  service = createImportPipeline({ scope: database.forGym, clock, jobs, uploadsFor: async gym => {
    if (!storage.has(gym)) storage.set(gym, new FakeUploads(gym, clock));
    return storage.get(gym)!;
  } });
  createServerRegistry({ jobs: createPipelineJobs(service) }).registerJobs(jobs, new Set());
});
function server(role: StaffRole = 'owner', principal?: Principal) {
  return createApp({ clock, origin, authorize, contributions: { routes: createPipelineRoutes(service) },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'America/Vancouver', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: principal ?? { kind: 'staff', gymId, userId, roles: [role] } }); await next(); },
  });
}
const post = (app: ReturnType<typeof server>, path: string, body: unknown) => app.request(origin + path, {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const planFor = (uploadId: string) => ({ uploadId, mapper: 'memberships' as const, duplicatePolicy: 'error' as const,
  mapping: [{ sourceColumn: 'Email', targetField: 'email' as const }, { sourceColumn: 'Plan', targetField: 'plan' as const },
    { sourceColumn: 'Next Due On', targetField: 'nextDueOn' as const }] });
it.each(['owner', 'admin', 'coach', 'front_desk'] as const)('checks %s permissions through upload, preview, start, progress and errors', async role => {
  const app = server(role), allowed = role === 'owner' || role === 'admin', form = new FormData();
  form.set('file', new File([text], 'memberships.csv'));
  const upload = await app.request(origin + '/api/imports/uploads', { method: 'POST', headers: { origin }, body: form });
  expect(upload.status).toBe(allowed ? 200 : 403);
  if (!allowed) {
    for (const path of ['/api/imports/preview', '/api/imports']) expect((await post(app, path, {})).status).toBe(403);
    for (const path of [`/api/imports/${uuidv7()}`, `/api/imports/${uuidv7()}/errors`]) expect((await app.request(origin + path)).status).toBe(403);
    return;
  }
  const uploaded = importUploadSchema.parse((await upload.json()).data), plan = planFor(uploaded.id);
  const preview = await post(app, '/api/imports/preview', plan); expect(preview.status).toBe(200);
  expect(importPreviewResponseSchema.parse(await preview.json()).summary).toMatchObject({ create: 1, errors: 0 });
  const started = await post(app, '/api/imports', { ...plan, dryRun: false }); expect(started.status).toBe(200);
  const run = importJobSchema.parse((await started.json()).data); await jobs.runNext();
  const status = await server(role).request(origin + '/api/imports/' + run.id); expect(status.status).toBe(200);
  expect(importJobSchema.parse((await status.json()).data)).toMatchObject({ status: 'succeeded', committedRows: 1 });
  expect((await app.request(origin + `/api/imports/${run.id}/errors`)).status).toBe(200);
  expect(await database.forGym(gymId, tx => tx.select().from(memberships))).toEqual([
    expect.objectContaining({ status: 'active', nextDueOn: '2028-02-29', anniversaryOn: '2028-02-29' }),
  ]);
});
it('returns 404 for another gym upload, run and errors, and denies foreign principals', async () => {
  const actor = { gymId: foreignGym, actor: { kind: 'system' } } as const;
  const upload = await service.upload(actor, new File([text], 'foreign.csv')), plan = planFor(upload.id);
  const run = await service.start(actor, { ...plan, dryRun: false }, 'UTC'), app = server();
  expect((await post(app, '/api/imports/preview', plan)).status).toBe(404);
  expect((await post(app, '/api/imports', { ...plan, dryRun: false })).status).toBe(404);
  for (const path of [`/api/imports/${run.id}`, `/api/imports/${run.id}/errors`]) expect((await app.request(origin + path)).status).toBe(404);
  const denied = server('owner', { kind: 'staff', gymId: foreignGym, userId, roles: ['owner'] });
  expect((await post(denied, '/api/imports', { ...plan, dryRun: false })).status).toBe(403);
  await jobs.runNext();
  expect(await database.forGym(foreignGym, tx => tx.select().from(memberships))).toEqual([]);
  expect(await database.forGym(gymId, tx => tx.select().from(memberships))).toEqual([]);
});
