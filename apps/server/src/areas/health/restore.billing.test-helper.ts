// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { createFactories } from '@plaingym/db/testing/factories';
import { FakePayments } from '../../infra/payments/index.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { createChargeRunner } from '../billing/runner/index.js';
import { configureChargeRunner, createRunnerJobs } from '../billing/runner/runner.jobs.js';
import { createInvoiceTransitions } from '../billing/transitions/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createGoLiveService, configureGoLive } from '../settings/go-live.js';
import { createApp } from '../../app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { authorize } from '../staff/auth.permissions.js';
import type { RestoreFixture } from './restore.fixture.test-helper.js';

/** The production billing runner, go-live service and routes on top of a restored install (the fixture's target database). */
export async function restoredBilling({ target, clock, gymId }: Pick<RestoreFixture, 'target' | 'clock' | 'gymId'>) {
  const provider = new FakePayments(gymId, clock), queue = new PostgresJobs({ database: target, clock });
  const settings = createGymSettingsAccessor({ scope: target.forGym, clock });
  const runner = createChargeRunner({ scope: target.forGym, clock, settings, jobs: queue,
    transitions: createInvoiceTransitions({ scope: target.forGym, clock }),
    payments: async id => id === gymId ? provider : new FakePayments(id, clock) });
  configureChargeRunner(runner);
  for (const job of createRunnerJobs(() => runner, settings)) queue.handle(job.id, job.handler);
  const options = { scope: target.forGym, clock, smtpConfigured: async () => true };
  configureGoLive(options);
  const service = createGoLiveService(options), context = { gymId, actor: { kind: 'system' as const } };
  const owner = await createFactories(target)('authUser', gymId), origin = 'https://gym.example.test';
  const app = createApp({ clock, skipSetup: true, origin, authorize, contributions: areaContributions,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId, userId: owner.id, roles: ['owner'] } }); await next(); },
  });
  const request = (path: string, method: string, body: unknown) => app.request(origin + path, {
    method, headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const read = () => service.checklist(gymId);
  const enable = async () => request('/api/settings/go-live', 'PATCH', { revision: (await read()).revision, billingEnabled: true });
  const rerun = async () => { const data = await read(); return request('/api/settings/go-live/reconciliation', 'POST', {
    revision: data.revision, restoreId: data.restoreReconciliation!.restoreId,
  }); };
  return { provider, runner, queue, service, context, read, enable, rerun, request };
}
