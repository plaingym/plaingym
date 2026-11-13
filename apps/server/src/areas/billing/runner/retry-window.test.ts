// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { paymentAttempts } from '@plaingym/db';
import { eligibility, nextRetryDeadline, retryDeadlines } from './eligibility.js';
import { useRunnerFixture } from './runner.fixture.test-helper.js';

const { db, factory, fixture, invoice } = useRunnerFixture();
it.each([
  { offset: -1, declineCode: null, status: 'failed', used: false },
  { offset: 0, declineCode: null, status: 'failed', used: true },
  { offset: 1, declineCode: null, status: 'failed', used: true },
  { offset: 0, declineCode: 'create_abandoned', status: 'failed', used: false },
  { offset: 0, declineCode: 'confirm_abandoned', status: 'failed', used: false },
  { offset: -1, declineCode: null, status: 'pending', used: true },
])('shares retry window boundaries: $offset ms, $declineCode, $status', async ({ offset, declineCode, status, used }) => {
  const f = await fixture({ timezone: 'UTC', now: '2028-03-01T09:00:00.001Z' }), bill = await invoice(f);
  const gym = await f.settings.get(f.gymId);
  await factory('auditEvents', f.gymId, { action: 'billing.invoice.dunning_started', targetType: 'invoice', targetId: bill.id,
    occurredAt: new Date('2028-02-27T12:00:00Z'), after: { retryDays: [3] } });
  const [deadline] = await db.forGym(f.gymId, tx => retryDeadlines(tx, gym, bill.id));
  expect(deadline).toEqual(new Date('2028-03-01T09:00:00Z'));
  await factory('paymentAttempts', f.gymId, { invoiceId: bill.id, status, declineCode,
    createdAt: new Date(deadline!.getTime() + offset) });
  const result = await db.forGym(f.gymId, async tx => {
    const attempts = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, bill.id));
    return { next: await nextRetryDeadline(tx, gym, bill.id, attempts),
      decision: await eligibility(tx, gym, f.clock, bill.id, 'retry') };
  });
  expect(result.next).toEqual(used ? undefined : deadline);
  expect(result.decision).toMatchObject(used
    ? { status: 'skipped', reason: status === 'pending' ? 'pending_attempt' : 'outside_retry_window' }
    : { status: 'eligible' });
});
