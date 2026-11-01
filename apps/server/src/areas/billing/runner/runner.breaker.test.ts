// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { invoices, uuidv7 } from '@plaingym/db';
import { createServerRegistry } from '../../../core/registry.js';
import { PostgresJobs, PostgresJobStatsQuery } from '../../../infra/jobs/index.js';
import { chargeFailuresJob, createChargeRunner, dailyRunJob } from './index.js';
import { createRunnerJobs } from './runner.jobs.js';
import { webhookDispatchJob } from '../webhooks/inbox.js';
import { setLogSink } from '../../../core/log.js';
import { createChargeRunHealthProvider, monitorChargeRunner } from '../../health/charge-run.js';
import { clearJobs } from '../scenarios/workflow-fixture.js';
import { useRunnerFixture, gate, outage, type Fixture } from './runner.fixture.test-helper.js';

const { db, factory, fixture, invoice, addHouseholds } = useRunnerFixture();
// Each test's worker claims any gym's due jobs, so none may be left from an earlier test.
beforeEach(() => clearJobs(db));

describe('daily run lane and circuit breaker', () => {
  const gymJob = (f: Fixture) => ({ gymId: f.gymId, timezone: 'America/Vancouver' });
  /**
   * The worker's queue with the charge runner's batch lane; the runner queues its continuations there. As in the
   * runtime, the scheduled jobs get the monitored runner, which records each run for the health tile.
   */
  function lanes(f: Fixture) {
    const queue = new PostgresJobs({ database: db, clock: f.clock });
    const runner = monitorChargeRunner(createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, jobs: queue,
      payments: async () => f.provider }), { scope: db.forGym, clock: f.clock, settings: f.settings });
    createServerRegistry({ jobs: createRunnerJobs(() => runner, f.settings) }).registerJobs(queue, new Set());
    return queue;
  }
  it('runs a webhook dispatch while the daily run holds the batch lane, where one shared lane would wait', async () => {
    const f = await fixture(), entered = gate(), held = gate(), adopt = f.provider.adoptCustomer.bind(f.provider);
    vi.spyOn(f.provider, 'adoptCustomer').mockImplementationOnce(async id => { entered.release(); await held.wait; return adopt(id); });
    const queue = lanes(f), shared = new PostgresJobs({ database: db, clock: f.clock });
    for (const job of createRunnerJobs(() => f.runner, f.settings)) shared.handle(job.id, job.handler);
    const dispatched: string[] = [];
    for (const worker of [queue, shared]) worker.handle(webhookDispatchJob, async (_, context) => { dispatched.push(context.jobId); });
    await queue.enqueue(dailyRunJob, {}, gymJob(f));
    const daily = queue.runNext(); await entered.wait;
    try {
      const { jobId } = await queue.enqueue(webhookDispatchJob, { eventId: uuidv7() }, gymJob(f));
      expect(await shared.runNext()).toBe(false);
      expect(await queue.runNext()).toBe(true);
      expect(dispatched).toEqual([jobId]);
    } finally { held.release(); }
    expect(await daily).toBe(true);
    expect((await f.read()).invoices.map(row => row.status)).toEqual(['paid']);
  });
  it('stops after three consecutive provider outages and collects the rest in one continuation an hour later', async () => {
    const f = await fixture(); await addHouseholds(f, 4);
    const adopt = vi.spyOn(f.provider, 'adoptCustomer');
    for (let n = 0; n < 3; n++) adopt.mockRejectedValueOnce(outage());
    const logs: string[] = [], prior = setLogSink(line => logs.push(line)), queue = lanes(f);
    try {
      await queue.enqueue(dailyRunJob, {}, gymJob(f));
      expect(await queue.runNext()).toBe(true);
    } finally { setLogSink(prior); }
    // The fourth and fifth invoices are never tried: each would only wait out the provider's timeout.
    expect(adopt).toHaveBeenCalledTimes(3);
    let rows = await f.read();
    expect(rows.attempts.map(row => row.declineCode)).toEqual(['create_abandoned', 'create_abandoned', 'create_abandoned']);
    expect(rows.invoices.map(row => row.status)).toEqual(Array(5).fill('open'));
    expect(logs.map(line => JSON.parse(line) as object)).toContainEqual(expect.objectContaining({
      event: 'billing.runner.collection_stopped', gymId: f.gymId, failures: 3, continuesAt: '2028-03-01T18:00:00.000Z' }));
    // The run doesn't fail into its one- and two-second retries; the continuation waits its hour.
    f.clock.advance(3_599_000); expect(await queue.runNext()).toBe(false);
    f.clock.advance(1000); expect(await queue.runNext()).toBe(true);
    rows = await f.read();
    expect(rows.invoices.map(row => row.status)).toEqual(Array(5).fill('paid'));
    expect(rows.attempts.filter(row => row.status === 'succeeded')).toHaveLength(5);
    expect(await queue.runNext()).toBe(false);
  });
  it('leaves a continuation that stops again to the next daily run, one continuation a day', async () => {
    const f = await fixture(); await addHouseholds(f, 2);
    const adopt = vi.spyOn(f.provider, 'adoptCustomer');
    for (let n = 0; n < 6; n++) adopt.mockRejectedValueOnce(outage());
    const queue = lanes(f), logs: string[] = [], prior = setLogSink(line => logs.push(line));
    try {
      await queue.enqueue(dailyRunJob, {}, gymJob(f));
      expect(await queue.runNext()).toBe(true);
      f.clock.advance(3_600_000); expect(await queue.runNext()).toBe(true);
    } finally { setLogSink(prior); }
    expect(adopt).toHaveBeenCalledTimes(6);
    // The continuation's stop queues nothing more, and its log says so.
    expect(logs.map(line => JSON.parse(line) as { event: string }).filter(line => line.event === 'billing.runner.collection_stopped'))
      .toEqual([expect.objectContaining({ continuesAt: '2028-03-01T18:00:00.000Z' }), expect.objectContaining({ continuesAt: null })]);
    f.clock.advance(3_600_000); expect(await queue.runNext()).toBe(false);
    f.clock.set('2028-03-02T17:00:00Z');
    await queue.enqueue(dailyRunJob, {}, { ...gymJob(f), idempotencyKey: 'next day' });
    expect(await queue.runNext()).toBe(true);
    expect((await f.read()).invoices.map(row => row.status)).toEqual(Array(3).fill('paid'));
  });
  /** The first household's charge is refused on its own, then three outages stop the run. */
  function refuseThenStop(f: Fixture) {
    const adopt = vi.spyOn(f.provider, 'adoptCustomer');
    adopt.mockRejectedValueOnce(new Error('Customer belongs to another gym'));
    for (let n = 0; n < 3; n++) adopt.mockRejectedValueOnce(outage());
    return adopt;
  }
  /** The run collects invoices in due date and ID order, so the refused one has the lowest ID. */
  const refusedInvoice = async (f: Fixture) => (await f.read()).invoices.toSorted((a, b) => a.id < b.id ? -1 : 1)[0]!;
  /** The charge run health tile, as owners see it. */
  const tile = (f: Fixture) => createChargeRunHealthProvider({ scope: db.forGym, settings: f.settings })
    .read({ gymId: f.gymId, roles: ['owner'], clock: f.clock });
  it('reports the other failures of a stopped run without failing a job, and the continuation clears them', async () => {
    const f = await fixture(); await addHouseholds(f, 4);
    const adopt = refuseThenStop(f), queue = lanes(f), stats = new PostgresJobStatsQuery(db);
    const { jobId } = await queue.enqueue(dailyRunJob, {}, gymJob(f));
    expect(await queue.runNext()).toBe(true);
    // Nothing else runs now: the run's own job succeeded and its continuation waits its hour.
    expect(await queue.runNext()).toBe(false);
    expect(adopt).toHaveBeenCalledTimes(4);
    const refused = await refusedInvoice(f);
    expect(await f.runner.chargeFailures(f.gymId)).toEqual([{ runId: jobId, day: '2028-03-01', reportedAt: f.clock.now(),
      failures: [{ invoiceId: refused.id, number: refused.number, cause: 'unexpected' }] }]);
    expect(await stats.get(f.gymId)).toMatchObject({ failed: 0, succeeded: 1, pending: 1 });
    expect(await tile(f)).toMatchObject({ status: 'error', message: expect.stringContaining(`: 1 (#${refused.number})`) });
    // The continuation collects every invoice an hour later, the refused one included, which clears the report.
    f.clock.advance(3_600_000); expect(await queue.runNext()).toBe(true);
    expect((await f.read()).invoices.map(row => row.status)).toEqual(Array(5).fill('paid'));
    expect(await f.runner.chargeFailures(f.gymId)).toEqual([]);
    expect(await stats.get(f.gymId)).toMatchObject({ failed: 0, succeeded: 2, pending: 0 });
    expect(await tile(f)).toMatchObject({ status: 'healthy' });
  });
  it('keeps both reports of two stopped runs on one local day', async () => {
    const f = await fixture(); await addHouseholds(f, 4);
    const queue = lanes(f);
    refuseThenStop(f);
    const first = await queue.enqueue(dailyRunJob, {}, gymJob(f));
    expect(await queue.runNext()).toBe(true);
    // Staff rerun the day's collection, which is refused and stopped again.
    refuseThenStop(f); f.clock.advance(60_000);
    const rerun = await queue.enqueue(dailyRunJob, {}, { ...gymJob(f), idempotencyKey: 'rerun' });
    expect(await queue.runNext()).toBe(true);
    const reports = await f.runner.chargeFailures(f.gymId);
    expect(reports.map(report => [report.runId, report.day])).toEqual([[first.jobId, '2028-03-01'], [rerun.jobId, '2028-03-01']]);
    expect(reports[0]!.failures).toEqual(reports[1]!.failures);
    // The tile names the invoice once, and staff dismiss both reports together.
    const refused = await refusedInvoice(f);
    expect(await tile(f)).toMatchObject({ status: 'error', message: expect.stringContaining(`: 1 (#${refused.number})`) });
    const user = await factory('authUser', f.gymId);
    expect(await f.runner.dismissChargeFailures({ gymId: f.gymId, actor: { kind: 'user', userId: user.id } }))
      .toEqual({ dismissed: [refused.id] });
    expect(await f.runner.chargeFailures(f.gymId)).toEqual([]);
  });
  it('keeps a report for an invoice no later run collects until staff dismiss it, within its own gym', async () => {
    const f = await fixture(), other = await fixture(); await addHouseholds(f, 4);
    const queue = lanes(f);
    refuseThenStop(f);
    const { jobId } = await queue.enqueue(dailyRunJob, {}, gymJob(f));
    expect(await queue.runNext()).toBe(true);
    // Staff hold the refused invoice for review, so the continuation completes without it.
    const refused = await refusedInvoice(f);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ needsReview: true }).where(eq(invoices.id, refused.id)));
    f.clock.advance(3_600_000); expect(await queue.runNext()).toBe(true);
    expect(await f.runner.chargeFailures(f.gymId)).toMatchObject([{ runId: jobId, failures: [{ invoiceId: refused.id }] }]);
    expect(await tile(f)).toMatchObject({ status: 'error', details: { result: 'succeeded' } });
    // Gym B never sees gym A's report, and can't dismiss it.
    const staff = async (g: Fixture) => ({ gymId: g.gymId, actor: { kind: 'user' as const, userId: (await factory('authUser', g.gymId)).id } });
    expect(await other.runner.chargeFailures(other.gymId)).toEqual([]);
    expect(await tile(other)).toMatchObject({ status: 'warning', details: { result: 'never_run' } });
    await expect(other.runner.dismissChargeFailures(await staff(other), jobId)).rejects.toMatchObject({ code: 'not_found' });
    expect(await f.runner.dismissChargeFailures(await staff(f), jobId)).toEqual({ dismissed: [refused.id] });
    expect(await f.runner.chargeFailures(f.gymId)).toEqual([]);
    expect(await tile(f)).toMatchObject({ status: 'healthy' });
    expect((await f.read()).audits.filter(row => row.action === 'billing.runner.charge_failures.dismissed'))
      .toMatchObject([{ targetId: jobId, actorKind: 'user', after: { invoiceIds: [refused.id] } }]);
  });
  it('records a report job the previous release queued as that run\'s report, without failing it', async () => {
    const f = await fixture(), bill = await invoice(f), queue = lanes(f);
    const { jobId } = await queue.enqueue(chargeFailuresJob, { day: '2028-03-01', invoiceIds: [bill.id] },
      { ...gymJob(f), maxAttempts: 1, idempotencyKey: 'failures:2028-03-01' });
    expect(await queue.runNext()).toBe(true);
    expect(await new PostgresJobStatsQuery(db).get(f.gymId)).toMatchObject({ failed: 0, succeeded: 1 });
    expect(await f.runner.chargeFailures(f.gymId)).toMatchObject([{ runId: jobId, failures: [{ invoiceId: bill.id, cause: 'unexpected' }] }]);
  });
  it('counts only consecutive provider outages: answers and other errors in between keep the run going', async () => {
    const f = await fixture(); await addHouseholds(f, 7);
    const real = f.provider.adoptCustomer.bind(f.provider), adopt = vi.spyOn(f.provider, 'adoptCustomer');
    const refused = () => new Error('Customer belongs to another gym');
    // Two outages, an answer, two outages, then refusals that aren't outages: never three outages in a row.
    for (const next of [outage, outage, null, outage, outage, refused, refused, refused]) {
      if (next) adopt.mockRejectedValueOnce(next()); else adopt.mockImplementationOnce(id => real(id));
    }
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 1, stopped: false });
    expect(adopt).toHaveBeenCalledTimes(8);
    expect(f.serviceOptions.jobs.jobs.filter(job => job.name === dailyRunJob)).toEqual([]);
  });
  it('still stops when $0 settlements, which never reach the provider, fall between the outages', async () => {
    const f = await fixture({ dueOn: '2028-02-24' }), free = await factory('plans', f.gymId, { amountCents: 0 });
    // By due date: paid, $0, paid, $0, paid, $0, paid.
    for (const [n, dueOn] of ['2028-02-25', '2028-02-26', '2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01'].entries()) {
      const paid = n % 2 === 1;
      f.provider.seedCustomer({ id: `cus_mixed_${n}`, email: `mixed${n}@example.invalid` });
      const home = await factory('households', f.gymId, { billingDay: 1, stripeCustomerId: `cus_mixed_${n}` });
      const member = await factory('members', f.gymId, { householdId: home.id });
      await factory('memberships', f.gymId, { householdId: home.id, memberId: member.id, planId: paid ? f.plan.id : free.id,
        status: 'active', amountCents: paid ? 10000 : 0, startsOn: '2028-01-01', nextDueOn: dueOn });
      await factory('paymentMethods', f.gymId, { householdId: home.id, processorId: `pm_mixed_${n}`, isDefault: true });
    }
    const adopt = vi.spyOn(f.provider, 'adoptCustomer').mockRejectedValue(outage());
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 2, stopped: true });
    expect(adopt).toHaveBeenCalledTimes(3);
    // Each household's prorated first period comes first by due date; nothing after the third outage is tried.
    const statuses = (await f.read()).invoices.map(row => row.status);
    expect(statuses).toEqual(['open', 'paid', 'open', 'paid', ...Array(statuses.length - 4).fill('open')]);
  });
  it('collects only its own day when its continuation runs after local midnight', async () => {
    const f = await fixture(); await addHouseholds(f, 2);
    f.provider.seedCustomer({ id: 'cus_tomorrow', email: 'tomorrow@example.invalid' });
    const home = await factory('households', f.gymId, { billingDay: 2, stripeCustomerId: 'cus_tomorrow' });
    const member = await factory('members', f.gymId, { householdId: home.id });
    await factory('memberships', f.gymId, { householdId: home.id, memberId: member.id, planId: f.plan.id, status: 'active',
      startsOn: '2028-01-02', nextDueOn: '2028-03-02' });
    await factory('paymentMethods', f.gymId, { householdId: home.id, processorId: 'pm_tomorrow', isDefault: true });
    const adopt = vi.spyOn(f.provider, 'adoptCustomer');
    for (let n = 0; n < 3; n++) adopt.mockRejectedValueOnce(outage());
    const queue = lanes(f);
    await queue.enqueue(dailyRunJob, {}, gymJob(f));
    expect(await queue.runNext()).toBe(true);
    // The worker was down until 00:30 the next local day; the continuation still collects only 1 March.
    f.clock.set('2028-03-02T08:30:00Z');
    expect(await queue.runNext()).toBe(true);
    expect((await f.read()).invoices.map(row => [row.dueOn, row.status])).toEqual(Array(3).fill(['2028-03-01', 'paid']));
    f.clock.set('2028-03-02T17:00:00Z');
    await queue.enqueue(dailyRunJob, {}, { ...gymJob(f), idempotencyKey: 'next day' });
    expect(await queue.runNext()).toBe(true);
    expect((await f.read()).invoices.map(row => [row.dueOn, row.status]).at(-1)).toEqual(['2028-03-02', 'paid']);
  });
});
