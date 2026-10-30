// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { createChargeRunner } from '../billing/runner/index.js';
import { createRunnerJobs } from '../billing/runner/runner.jobs.js';
import { createInvoiceTransitions } from '../billing/transitions/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { authorize } from '../staff/auth.permissions.js';
import { createHealthService } from './status.js';
import { createStatusRoutes } from './status.routes.js';
import { createChargeRunHealthProvider, monitorChargeRunner } from './charge-run.js';
import { setLogSink } from '../../core/log.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(enabled = true) {
  const gymId = uuidv7(); await factory('gyms', gymId, { billingEnabled: enabled });
  const clock = new TestClock('2026-10-26T12:00:00Z');
  const settings = createGymSettingsAccessor({ scope: db.forGym, clock });
  const options = { scope: db.forGym, clock, settings, jobs: new FakeJobs(clock) };
  const runner = createChargeRunner({ ...options, transitions: createInvoiceTransitions(options), payments: async () => new FakePayments(gymId, clock) });
  const provider = createChargeRunHealthProvider(options);
  const read = () => provider.read({ gymId, roles: ['owner'], clock });
  return { gymId, clock, options, runner, provider, read };
}
describe('durable daily charge-run health', () => {
  it('preserves the runner error and logs a failed failure-record write', async () => {
    const f = await fixture(), runnerError = new Error('original processor failure'), auditError = new Error('private database failure');
    let records = 0;
    const scope: typeof db.forGym = (gymId, fn) => {
      if (++records === 2) return Promise.reject(auditError);
      return db.forGym(gymId, fn);
    };
    const logs: string[] = [], previous = setLogSink(line => logs.push(line));
    try {
      const runner = monitorChargeRunner({ ...f.runner, async daily() { throw runnerError; } }, { ...f.options, scope });
      await expect(runner.daily(f.gymId)).rejects.toBe(runnerError);
      expect(records).toBe(2);
      expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
        event: 'billing.runner.failure_record_failed', gymId: f.gymId, error: expect.objectContaining({ name: 'Error' }),
      }));
      expect(logs.join()).not.toContain(auditError.message);
      expect(await f.read()).toMatchObject({ details: { result: 'running' } });
    } finally { setLogSink(previous); }
  });
  it('runs the actual scheduled runner, records completion, survives reconstruction, and isolates gyms', async () => {
    const a = await fixture(), b = await fixture();
    expect(await a.read()).toMatchObject({ status: 'warning', details: { result: 'never_run' } });
    const monitored = monitorChargeRunner(a.runner, a.options);
    await createRunnerJobs(() => monitored, a.options.settings).find(job => job.id === 'billing.runner.daily')!.handler({},
      { gymId: a.gymId, jobId: uuidv7(), timezone: 'UTC', attempt: 1, clock: a.clock });
    expect(await createChargeRunHealthProvider(a.options).read({ gymId: a.gymId, roles: ['owner'], clock: a.clock }))
      .toMatchObject({ status: 'healthy', details: { result: 'succeeded', invoicesProcessed: 0, failures: 0 } });
    expect(await b.read()).toMatchObject({ details: { result: 'never_run' } });
    a.clock.advance(27 * 3_600_000);
    expect(await a.read()).toHaveProperty('status', 'warning');
  });
  it('reports running and stalled work, and redacts thrown errors', async () => {
    const f = await fixture();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const runner = monitorChargeRunner({ ...f.runner, async daily() { await wait; throw new Error('private processor error'); } }, f.options);
    const running = runner.daily(f.gymId);
    // The persisted start is observable before the underlying work completes.
    await expect.poll(async () => (await f.read()).details).toMatchObject({ result: 'running' });
    f.clock.advance(3 * 3_600_000);
    expect(await f.read()).toMatchObject({ status: 'warning', message: 'The daily charge run is overdue or has stopped reporting.' });
    release(); await expect(running).rejects.toThrow('private processor error');
    expect(await f.read()).toMatchObject({ status: 'error', details: { result: 'failed', failures: 1 } });
    expect(JSON.stringify(await f.read())).not.toContain('private processor');
  });
  it('records partial collection errors and respects paused billing', async () => {
    const f = await fixture(), paused = await fixture(false);
    await monitorChargeRunner({ ...f.runner, async daily() { return { generatedPeriods: 3, attempted: 2, errors: [{ invoiceId: uuidv7(), message: 'private' }], stopped: false }; } }, f.options).daily(f.gymId);
    expect(await f.read()).toMatchObject({ status: 'error', details: { invoicesProcessed: 2, failures: 1 } });
    await monitorChargeRunner(paused.runner, paused.options).daily(paused.gymId);
    expect(await paused.read()).toMatchObject({ status: 'not_configured', details: { result: 'never_run' } });
  });
  it('does not let an older concurrent run completion hide the newer run', async () => {
    const f = await fixture();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const slow = monitorChargeRunner({ ...f.runner, async daily() { await wait; return { generatedPeriods: 0, attempted: 0, errors: [], stopped: false }; } }, f.options);
    const older = slow.daily(f.gymId);
    await expect.poll(async () => (await f.read()).details).toMatchObject({ result: 'running' });
    f.clock.advance(1000);
    await monitorChargeRunner({ ...f.runner, async daily() { throw new Error('newer run failed'); } }, f.options).daily(f.gymId).catch(() => undefined);
    release(); await older;
    expect(await f.read()).toMatchObject({ status: 'error', details: { result: 'failed' } });
  });
  it('serves the provider through the real health route with allow/deny permissions', async () => {
    const f = await fixture(), user = await factory('authUser', f.gymId);
    await monitorChargeRunner(f.runner, f.options).daily(f.gymId);
    const service = createHealthService([f.provider]);
    for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) {
      const app = createApp({ clock: f.clock, authorize, skipSetup: true,
        resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
        session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId: f.gymId, userId: user.id, roles: [role] } }); await next(); },
        contributions: { routes: createStatusRoutes(() => service) },
      });
      const response = await app.request('/api/health');
      expect(response.status).toBe(['owner', 'admin'].includes(role) ? 200 : 403);
      if (response.status === 200) expect(await response.json()).toMatchObject({ data: { tiles: expect.arrayContaining([
        expect.objectContaining({ id: 'last_charge_run', status: 'healthy' }),
      ]) } });
    }
  });
});
