// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { FakeUploads } from '../../../infra/storage/index.js';
import { createImportPipeline } from '../../imports/pipeline.js';
import { createPipelineJobs } from '../../imports/pipeline.jobs.js';
import { autoMatch, csvLine, parseCsv } from '../../imports/pipeline.csv.js';
import { createMembershipJobs } from '../memberships.jobs.js';
import { clearJobs, workflowFixture, type Workflow } from './workflow-fixture.js';

const db = useTestDatabase();
beforeEach(() => clearJobs(db));
async function importRenewals(f: Workflow, records: Record<string, string>[]) {
  const uploads = new FakeUploads(f.gymId, f.clock);
  const pipeline = createImportPipeline({ ...f.common, uploadsFor: async () => uploads });
  for (const job of createPipelineJobs(pipeline)) f.queue.handle(job.id, job.handler);
  const fields = [...new Set(records.flatMap(row => Object.keys(row)))];
  const text = csvLine(fields) + records.map(row => csvLine(fields.map(key => row[key] ?? ''))).join('');
  const upload = await pipeline.upload(f.context, new File([text], 'renewals.csv'));
  const run = await pipeline.start(f.context, { uploadId: upload.id, mapper: 'memberships', duplicatePolicy: 'error',
    mapping: autoMatch(parseCsv(text).columns), dryRun: false }, f.timezone);
  await f.drain(); expect((await pipeline.get(f.gymId, run.id)).committedRows).toBe(records.length);
  // An acknowledged chunk stays idempotent if its job is replayed.
  await pipeline.run(f.gymId, run.id); expect((await f.read()).memberships).toHaveLength(records.length);
}

describe('imported and changing membership billing', () => {
  it('imported monthly and annual dates survive the first cycle and adopt the imported customer before charging', async () => {
    const f = await workflowFixture(db, { empty: true, now: '2027-10-26T17:00:00Z' });
    const annual = await f.factory('members', f.gymId, { householdId: f.home.id, email: 'annual@example.invalid' });
    const annualPlan = await f.factory('plans', f.gymId, { interval: 'annual', amountCents: 90000, currency: 'USD' });
    f.transport.objects.get('cus_fixture')!.metadata = {}; // An imported, untagged customer is adopted by the real provider.
    await importRenewals(f, [{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2027-11-19', amountCents: '8250' },
      { email: annual.email!, plan: annualPlan.id, nextDueOn: '2028-02-29' }]);
    await f.runJob('billing.runner.daily'); expect((await f.read()).invoices).toEqual([]);
    const create = f.provider.createCharge.bind(f.provider);
    vi.spyOn(f.provider, 'createCharge').mockImplementation(async request => {
      expect(f.transport.objects.get('cus_fixture')!.metadata).toMatchObject({ gym_id: f.gymId });
      return create(request);
    });
    f.clock.set('2027-11-19T17:00:00Z'); await f.runJob('billing.runner.daily');
    const state = await f.read();
    expect(state.invoices).toMatchObject([{ dueOn: '2027-11-19', amountCents: 8250, status: 'paid' }]);
    expect(state.memberships.find(m => m.memberId === f.member.id)!.nextDueOn).toBe('2027-12-19');
    expect(state.memberships.find(m => m.memberId === annual.id)).toMatchObject({ nextDueOn: '2028-02-29', anniversaryOn: '2028-02-29' });
    expect(state.homes[0]!.billingDay).toBe(19);
  });

  it('imported Feb-29 anniversary differs from startsOn, survives Feb-28 renewals and returns in 2032', async () => {
    const f = await workflowFixture(db, { empty: true, now: '2027-10-26T17:00:00Z' });
    const plan = await f.factory('plans', f.gymId, { interval: 'annual', currency: 'USD', amountCents: 90000 });
    await importRenewals(f, [{ email: f.member.email!, plan: plan.id, nextDueOn: '2028-02-29' }]);
    expect((await f.read()).memberships[0]).toMatchObject({ startsOn: '2027-10-26', anniversaryOn: '2028-02-29' });
    f.clock.set('2028-02-28T17:00:00Z'); await f.runJob('billing.runner.daily'); expect((await f.read()).invoices).toEqual([]);
    const dates = ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29'];
    for (const date of dates) {
      f.clock.set(date + 'T17:00:00Z'); await f.runJob('billing.runner.daily'); await f.runJob('billing.runner.daily');
      expect((await f.read()).invoices.find(i => i.dueOn === date)).toMatchObject({ status: 'paid', amountCents: 90000 });
    }
    expect((await f.read()).invoices.map(i => i.dueOn)).toEqual(dates);
    expect((await f.read()).memberships[0]).toMatchObject({ anniversaryOn: '2028-02-29', nextDueOn: '2033-02-28' });
  });

  it('freeze skips collection, date jobs resume it, and the next cycle bills once', async () => {
    const f = await workflowFixture(db), membership = (await f.read()).memberships[0]!;
    await f.lifecycle.freeze(f.context, { membershipId: membership.id, revision: membership.revision, resumesOn: '2028-03-15' });
    await f.runJob('billing.runner.daily'); expect((await f.read()).payments).toEqual([]);
    const frozen = await f.read();
    expect(frozen.invoices, 'The entirely frozen March period produces no invoice').toEqual([]);
    expect(frozen.attempts).toEqual([]);
    expect(frozen.memberships[0]).toMatchObject({ status: 'frozen', nextDueOn: '2028-04-01' });
    for (const job of createMembershipJobs(() => f.lifecycle)) f.queue.handle(job.id, job.handler);
    f.clock.set('2028-03-15T16:00:00Z'); await f.runJob('billing.memberships.dates');
    expect((await f.lifecycle.get(f.gymId, membership.id)).status).toBe('active');
    f.clock.set('2028-04-01T16:00:00Z'); await f.runJob('billing.runner.daily');
    expect((await f.read()).payments).toHaveLength(1);
    expect((await f.read()).invoices).toMatchObject([{ dueOn: '2028-04-01', amountCents: 10000, status: 'paid' }]);
  });

  it('adding a household member bills their first period separately, then consolidates the next monthly cycle', async () => {
    const f = await workflowFixture(db); await f.runJob('billing.runner.daily');
    f.clock.set('2028-03-15T16:00:00Z');
    const member = await f.factory('members', f.gymId, { householdId: f.home.id });
    const added = await f.lifecycle.assign(f.context, { id: uuidv7(), householdId: f.home.id, memberId: member.id, planId: f.plan.id,
      startsOn: '2028-03-15', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' });
    await f.runner.collectAssigned(f.gymId, f.home.id); await f.drain();
    expect((await f.lifecycle.get(f.gymId, added.id)).status).toBe('active');
    f.clock.set('2028-04-01T16:00:00Z'); await f.runJob('billing.runner.daily');
    const state = await f.read(), cycle = state.invoices.find(i => i.dueOn === '2028-04-01')!;
    expect(cycle).toMatchObject({ status: 'paid', amountCents: 20000 });
    expect(state.lines.filter(l => l.invoiceId === cycle.id && l.kind === 'membership')).toHaveLength(2);
    expect(state.homes).toHaveLength(1); expect(state.payments).toHaveLength(3);
  });
});
