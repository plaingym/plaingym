// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { emailDeliveries, uuidv7 } from '@plaingym/db';
import { createPriceChangeService } from '../catalog.price-change.js';
import { createPriceNotice, priceNoticeJob } from '../memberships.price-notice.js';
import { dailyRunJob } from '../runner/index.js';
import { clearJobs, workflowFixture } from './workflow-fixture.js';

const db = useTestDatabase();
beforeEach(() => clearJobs(db));

describe('plan price change through the composed runner, the job queue and synthetic Stripe', () => {
  it('bills the old price before the date and the new price from it, after one notice email', async () => {
    const f = await workflowFixture(db);
    const notice = createPriceNotice({ scope: db.forGym, clock: f.clock, demoMode: false, mailer: async () => f.email });
    f.queue.handle(priceNoticeJob, async (payload, context) => notice.run(payload, context.gymId));
    const changes = createPriceChangeService({ ...f.common, smtp: { configured: async () => true } });
    await f.runJob(dailyRunJob);
    const preview = await changes.preview(f.gymId, f.plan.id, { amountCents: '12500', effectiveOn: '2028-04-15' });
    expect(preview).toMatchObject({ total: 1, households: 1, canEmail: true, change: 'increase' });
    const ticked = preview.memberships.filter(item => item.tickedByDefault).map(({ id, revision }) => ({ id, revision }));
    const input = { requestKey: uuidv7(), planRevision: preview.plan.revision, amountCents: 12_500, effectiveOn: '2028-04-15',
      notify: true, memberships: ticked };
    // The request is sent twice: one schedule and one notice.
    const result = await changes.apply(f.context, f.plan.id, input);
    expect(await changes.apply(f.context, f.plan.id, input)).toEqual(result);
    expect(result).toMatchObject({ scheduled: [ticked[0]!.id], skipped: [], householdsNotified: 1 });
    await f.drain();
    const sent = await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries));
    expect(sent.filter(row => row.key.startsWith('plan-price:'))).toMatchObject([
      { key: `plan-price:${input.requestKey}:${f.home.id}`, state: 'accepted', attempts: 1 }]);
    for (const day of ['2028-04-01', '2028-05-01']) {
      f.clock.set(day + 'T17:00:00Z');
      await f.runJob(dailyRunJob); await f.runJob(dailyRunJob);
    }
    const state = await f.read();
    expect(state.invoices.map(invoice => [invoice.dueOn, invoice.kind, invoice.status, invoice.amountCents])).toEqual([
      ['2028-03-01', 'cycle', 'paid', 10_000], ['2028-04-01', 'cycle', 'paid', 10_000], ['2028-05-01', 'cycle', 'paid', 12_500]]);
    expect(state.memberships[0]).toMatchObject({ planId: f.plan.id, amountCents: 12_500, scheduledPlanId: null, nextDueOn: '2028-06-01' });
    expect(state.payments).toHaveLength(3);
  });
});
