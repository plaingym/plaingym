// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { invoices, paymentMethods, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { zonedInstant } from '@plaingym/shared/time';
import { clearJobs, workflowFixture, type Workflow } from '../scenarios/workflow-fixture.js';
import { dailyRunJob, retryJob } from './index.js';

const db = useTestDatabase();
beforeEach(() => clearJobs(db));

const paths = ['card removed', 'billing paused', 'billing paused before create'] as const;
type Path = typeof paths[number];
/** How the runner closes the attempt it gave up on: before creating the intent, or after creating it unconfirmed. */
const abandoned = (path: Path) => path === 'billing paused before create' ? 'create_abandoned' : 'confirm_abandoned';
/** 09:00 in the gym's timezone, when retries run. */
const nine = (f: Workflow, date: string) => zonedInstant(date, '09:00', f.timezone, { gap: 'shift' })!;
/** Makes the runner give up on its next charge mid-charge, before Stripe confirms it. */
function abandonNextCharge(f: Workflow, path: Path) {
  if (path === 'billing paused before create') {
    const adopt = f.provider.adoptCustomer.bind(f.provider);
    vi.spyOn(f.provider, 'adoptCustomer').mockImplementationOnce(async id => { await f.enable(false); return adopt(id); });
    return;
  }
  const create = f.provider.createCharge.bind(f.provider);
  vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async request => {
    const intent = await create(request);
    if (path === 'billing paused') await f.enable(false);
    else await f.db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ revokedAt: f.clock.now(), isDefault: false })
      .where(eq(paymentMethods.processorId, request.paymentMethodId)));
    return intent;
  });
}
async function resume(f: Workflow, path: Path) {
  if (path === 'card removed') await f.setCard('pm_3155'); else await f.enable(true);
}
/** The March 1 charge is declined; retries follow on days 3 and 7 (March 4 and 8). */
async function declined(f: Workflow) {
  await f.runJob(dailyRunJob);
  expect((await f.read()).invoices).toMatchObject([{ status: 'past_due' }]);
}
/** Declines March 1 and on day 3, then the day-7 (last) retry cancels its own charge. */
async function lastDayAbandoned(f: Workflow, path: Path) {
  await declined(f);
  f.clock.set(nine(f, '2028-03-04')); await f.drain();
  await f.setCard('pm_4242'); abandonNextCharge(f, path);
  f.clock.set(nine(f, '2028-03-08')); await f.drain();
  const state = await f.read();
  expect(state.attempts.map(row => row.declineCode)).toEqual([null, null, abandoned(path)]);
  expect(state.invoices).toMatchObject([{ status: 'past_due' }]);
  // Each decline sent its dunning email; the cancelled charge sent none.
  expect(f.email.messages).toHaveLength(2);
  return state;
}
const retries = (state: Awaited<ReturnType<Workflow['read']>>) => state.jobs.filter(job => job.name === retryJob);
const extensions = (state: Awaited<ReturnType<Workflow['read']>>) =>
  state.audits.filter(row => row.action === 'billing.runner.retry_extended');

describe('a retry that cancels its own charge on the last retry day', () => {
  it.each(paths)('%s: queues one more retry the next day, which collects the invoice once it can', async path => {
    const f = await workflowFixture(db, { card: 'pm_0341' });
    const state = await lastDayAbandoned(f, path);
    expect(retries(state)).toMatchObject([{ status: 'pending', runAt: nine(f, '2028-03-09') }]);
    expect(extensions(state)).toMatchObject([{ targetId: state.invoices[0]!.id }]);
    await resume(f, path);
    f.clock.set(nine(f, '2028-03-09')); await f.drain();
    const after = await f.read();
    expect(after.invoices).toMatchObject([{ status: 'paid' }]);
    expect(after.attempts.map(row => row.status)).toEqual(['failed', 'failed', 'failed', 'succeeded']);
    expect(after.payments).toHaveLength(1);
    expect(f.email.messages.slice(2)).toMatchObject([{ subject: expect.stringContaining('Receipt') }]);
  });

  it.each(paths)('%s: the extra retry stops while the card is still removed or billing still paused', async path => {
    const f = await workflowFixture(db, { card: 'pm_0341' });
    await lastDayAbandoned(f, path);
    const create = vi.spyOn(f.provider, 'createCharge'); create.mockClear();
    f.clock.set(nine(f, '2028-03-09')); await f.drain();
    const state = await f.read();
    expect(create).not.toHaveBeenCalled();
    expect(state.invoices).toMatchObject([{ status: 'past_due' }]);
    expect(state.attempts).toHaveLength(3);
    expect(retries(state).map(job => job.status)).toEqual(['succeeded']);
    expect(extensions(state)).toHaveLength(1);
    expect(f.email.messages).toHaveLength(2);
    // Nothing else is queued for the invoice: it stays past due for the front desk.
    f.clock.set(nine(f, '2028-03-20')); await f.drain();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(paths)('%s: an extra retry that cancels its own charge again queues no other', async path => {
    const f = await workflowFixture(db, { card: 'pm_0341' });
    await lastDayAbandoned(f, path);
    await resume(f, path); abandonNextCharge(f, path);
    f.clock.set(nine(f, '2028-03-09')); await f.drain();
    const state = await f.read();
    expect(state.attempts.map(row => row.declineCode).slice(2)).toEqual([abandoned(path), abandoned(path)]);
    expect(state.invoices).toMatchObject([{ status: 'past_due' }]);
    expect(retries(state).map(job => job.status)).toEqual(['succeeded']);
    expect(extensions(state)).toHaveLength(1);
    expect(f.email.messages).toHaveLength(2);
  });

  it.each(['a pay link', 'a review hold'] as const)('queues none for an invoice given %s during the charge', async change => {
    const f = await workflowFixture(db, { card: 'pm_0341' });
    await declined(f);
    f.clock.set(nine(f, '2028-03-04')); await f.drain();
    await f.setCard('pm_4242');
    const create = f.provider.createCharge.bind(f.provider);
    vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async request => {
      const intent = await create(request);
      // Staff or the member now collect it: the runner cancels its charge (`collection_changed`).
      await f.db.forGym(f.gymId, tx => tx.update(invoices).set(change === 'a pay link' ? { checkoutSessionId: 'cs_meanwhile' }
        : { needsReview: true }).where(eq(invoices.id, request.invoiceId)));
      return intent;
    });
    f.clock.set(nine(f, '2028-03-08')); await f.drain();
    const state = await f.read();
    expect(state.attempts.map(row => row.declineCode)).toEqual([null, null, 'confirm_abandoned']);
    expect(retries(state)).toEqual([]);
    expect(extensions(state)).toEqual([]);
  });

  it('queues none for a retry that billing, paused since, stops before it reserves anything', async () => {
    const f = await workflowFixture(db, { card: 'pm_0341' });
    await declined(f);
    f.clock.set(nine(f, '2028-03-04')); await f.drain();
    await f.setCard('pm_4242');
    const [invoice] = (await f.read()).invoices, context = { jobId: uuidv7(), gymId: f.gymId, timezone: f.timezone, attempt: 1, clock: f.clock };
    // The last-day retry's confirm never reaches Stripe, and the hourly reconcile cancels its intent.
    vi.spyOn(f.provider, 'confirmCharge').mockRejectedValueOnce(new Error('Network error before the request was sent'));
    f.clock.set(nine(f, '2028-03-08'));
    await expect(f.runner.retry(invoice!.id, context)).rejects.toThrow('Network error');
    f.clock.advance(16 * 60_000); await f.runner.reconcile(f.gymId);
    expect((await f.read()).attempts.map(row => row.declineCode)).toEqual([null, null, 'confirm_abandoned']);
    // Its continuation finds billing paused: it skips before reserving, and the attempt it finds isn't its own.
    await f.enable(false);
    await f.runner.retry(invoice!.id, { ...context, jobId: uuidv7() });
    const state = await f.read();
    expect(state.attempts).toHaveLength(3);
    expect(extensions(state)).toEqual([]);
    // Only the first retry's continuation is queued, not a retry the next morning.
    expect(retries(state).map(job => job.runAt)).not.toContainEqual(nine(f, '2028-03-09'));
  });

  it.each(paths)('%s on an earlier retry day: nothing extra is queued, and the next retry day collects it', async path => {
    const f = await workflowFixture(db, { card: 'pm_0341' });
    await declined(f);
    await f.setCard('pm_4242'); abandonNextCharge(f, path);
    f.clock.set(nine(f, '2028-03-04')); await f.drain();
    let state = await f.read();
    expect(state.attempts.map(row => row.declineCode)).toEqual([null, abandoned(path)]);
    expect(retries(state)).toEqual([]);
    expect(extensions(state)).toEqual([]);
    await resume(f, path);
    f.clock.set(nine(f, '2028-03-08')); await f.drain();
    state = await f.read();
    expect(state.invoices).toMatchObject([{ status: 'paid' }]);
    expect(state.attempts.map(row => row.status)).toEqual(['failed', 'failed', 'succeeded']);
    expect(retries(state)).toEqual([]);
    expect(f.email.messages).toHaveLength(2);
  });
});
