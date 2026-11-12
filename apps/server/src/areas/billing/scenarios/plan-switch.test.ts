// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { uuidv7 } from '@plaingym/db';
import { createRevenueReportService } from '../../reports/revenue.js';
import { dailyRunJob } from '../runner/index.js';
import { clearJobs, workflowFixture } from './workflow-fixture.js';

const db = useTestDatabase();
beforeEach(() => clearJobs(db));

describe('scheduled plan switch through the composed runner, synthetic Stripe and the revenue report', () => {
  it('bills the new price and the new plan\'s taxes from the next cycle, and the report keeps the earlier cycle under the old plan', async () => {
    const f = await workflowFixture(db);
    const tax = await f.factory('taxRates', f.gymId, { name: 'Sales tax', rateMillionths: 50_000, inclusive: false });
    const next = await f.factory('plans', f.gymId, { name: 'Unlimited', amountCents: 15_000, currency: 'USD' });
    await f.factory('planTaxRates', f.gymId, { planId: next.id, taxRateId: tax.id });
    await f.runJob(dailyRunJob);
    const membership = (await f.read()).memberships[0]!;
    const switched = await f.lifecycle.switchPlan(f.context, { membershipId: membership.id, revision: membership.revision,
      requestId: uuidv7(), planId: next.id, timing: 'next_billing_date' });
    expect(switched).toMatchObject({ membership: { planId: f.plan.id, scheduledPlanId: next.id, scheduledOn: '2028-04-01' }, invoiceId: null });
    f.clock.set('2028-04-01T17:00:00Z');
    await f.runJob(dailyRunJob); await f.runJob(dailyRunJob);
    const state = await f.read();
    expect(state.invoices.map(i => [i.dueOn, i.kind, i.status, i.amountCents])).toEqual([
      ['2028-03-01', 'cycle', 'paid', 10_000], ['2028-04-01', 'cycle', 'paid', 15_750]]);
    const april = state.invoices[1]!;
    expect(state.lines.filter(line => line.invoiceId === april.id).map(line => [line.kind, line.planId, line.amountCents]).sort())
      .toEqual([['membership', next.id, 15_000], ['tax', null, 750]]);
    const march = state.invoices[0]!;
    expect(state.lines.filter(line => line.invoiceId === march.id).map(line => [line.kind, line.planId, line.amountCents]))
      .toEqual([['membership', f.plan.id, 10_000]]);
    expect(state.memberships[0]).toMatchObject({ planId: next.id, amountCents: 15_000, scheduledPlanId: null, nextDueOn: '2028-05-01' });
    expect(state.payments).toHaveLength(2);
    const report = await createRevenueReportService(db.forGym).get({ gymId: f.gymId, timezone: f.timezone, clock: f.clock },
      { from: '2028-03', to: '2028-04' });
    // The synthetic transport stamps every charge with its fixed start time, so compare totals over the range: the
    // membership is now on the new plan, and the earlier cycle still counts under the plan its line recorded.
    const totals = new Map<string, number>();
    for (const bucket of report.data.currencies[0]!.buckets) for (const group of bucket.groups) {
      const key = group.kind + ':' + group.id;
      totals.set(key, (totals.get(key) ?? 0) + group.payments);
    }
    expect(Object.fromEntries(totals)).toEqual({ ['plan:' + f.plan.id]: 10_000, ['plan:' + next.id]: 15_000, ['tax:' + tax.id]: 750 });
  });
});
