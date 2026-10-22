// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OpenAPIHono, z } from '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { route, createServerRegistry } from './registry.js';
import { enabledModules, mountModules, registerModuleJobs } from './modules.js';
import { FakeGymSettingsAccessor } from './interfaces/gym-settings.js';
import { FakeJobs } from '../infra/jobs/index.js';
const websiteModule = { id: 'website', schemaFile: null, routes: [], jobs: [], emails: [], web: {} };
import { TestClock } from './clock.js';
import type { RequestEnvironment } from './context.js';
const clock = new TestClock('2026-10-22Z');
it('checks module activation on every request without disabling core routes', async () => {
  let websiteEnabled = false;
  const page = (path: string) => route({ method: 'get', path, permission: { kind: 'public' },
    responses: { 200: { description: 'Page', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } } } },
    (c) => c.json({ ok: true }, 200));
  const registry = createServerRegistry({ routes: [page('/core')], modules: [{ ...websiteModule, routes: [page('/website')] }] });
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => { c.set('context', { requestId: 'test', clock, principal: { kind: 'anonymous' },
    gym: { gymId: uuidv7(), timezone: 'UTC', enabledModules: enabledModules({ websiteEnabled }) } }); await next(); });
  mountModules(registry, app, () => async (_c, next) => { await next(); });
  expect((await app.request('/website')).status).toBe(404); expect((await app.request('/core')).status).toBe(200);
  websiteEnabled = true; expect((await app.request('/website')).status).toBe(200);
  websiteEnabled = false; expect((await app.request('/website')).status).toBe(404);
});
it('reads each job gym settings at execution time, including after a module toggle', async () => {
  const gymA = uuidv7(), gymB = uuidv7(), ran: string[] = [];
  const base = { timezone: 'UTC', currency: 'USD', revision: 1, billingEnabled: false, memberEmailsEnabled: false,
    websiteEnabled: false, bookingWindowDays: 14, cancellationCutoffMinutes: 60 };
  const settings = new FakeGymSettingsAccessor([{ ...base, gymId: gymA, websiteEnabled: true }, { ...base, gymId: gymB }]);
  const worker = new FakeJobs(clock);
  const registry = createServerRegistry({ modules: [{ ...websiteModule, jobs: [{ id: 'website.refresh',
    handler: async (_payload, context) => { ran.push(context.gymId); } }] }] });
  registerModuleJobs(registry, worker, settings);
  for (const gymId of [gymA, gymB]) await worker.enqueue('website.refresh', {}, { gymId, timezone: 'UTC' });
  await worker.runNext(); await worker.runNext(); expect(ran).toEqual([gymA]);
  settings.set({ ...base, gymId: gymA });
  await worker.enqueue('website.refresh', {}, { gymId: gymA, timezone: 'UTC' }); await worker.runNext();
  expect(ran).toEqual([gymA]);
});
