// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { auditEvents, emailDeliveries, emailOutbox, households, members, memberships, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { createServerRegistry } from '../../core/registry.js';
import { areaContributions } from '../../core/registry-areas.js';
import { DeliveryError, FakeEmail } from '../../infra/email/index.js';
import { OutboxEmail } from '../../infra/email/outbox.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createGoLiveService } from '../settings/go-live.js';
import { createMembershipJobs } from './memberships.jobs.js';
import { configurePriceNotice, createPriceNotice, priceNoticeJob, priceNoticePayload } from './memberships.price-notice.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-11-12T12:00:00Z');
  await factory('gyms', gymId, { name: 'Cedar Gym', timezone: 'America/Los_Angeles', memberEmailsEnabled: true });
  const household = await factory('households', gymId, { email: 'payer@example.test' });
  const payer = await factory('members', gymId, { householdId: household.id, email: household.email, firstName: 'Mia', lastName: 'First' });
  const plan = await factory('plans', gymId, { name: 'All classes', amountCents: 10000, currency: 'USD', interval: 'monthly' });
  const membership = await factory('memberships', gymId, { householdId: household.id, memberId: payer.id, planId: plan.id,
    status: 'active', amountCents: 10000, currency: 'USD', interval: 'monthly', scheduledPlanId: plan.id,
    scheduledAmountCents: 12500, scheduledInterval: 'monthly', scheduledOn: '2026-12-01' });
  const payload = { requestKey: uuidv7(), planId: plan.id, householdId: household.id, membershipIds: [membership.id],
    amountCents: 12500, currency: 'USD', effectiveOn: '2026-12-01' };
  const email = new FakeEmail(), jobs = new FakeJobs(clock);
  const options = { scope: db.forGym, clock, demoMode: false,
    mailer: vi.fn(async (): Promise<FakeEmail | null> => { expect(isInTransaction()).toBe(false); return email; }) };
  const notice = createPriceNotice(options);
  createServerRegistry({ jobs: createMembershipJobs(undefined, () => notice) }).registerJobs(jobs, new Set());
  const run = () => notice.run(payload, gymId);
  return { gymId, clock, household, payer, plan, membership, payload, email, jobs, options, notice, run };
}

it('runs the registered job, sends once outside a transaction and retains the stable household key on replay', async () => {
  const f = await fixture();
  await f.jobs.enqueue(priceNoticeJob, f.payload, { gymId: f.gymId, timezone: 'America/Los_Angeles' });
  await f.jobs.runNext(); await f.run();
  expect(f.jobs.jobs[0]!.status).toBe('completed');
  expect(f.email.messages).toHaveLength(1);
  expect(f.email.messages[0]).toMatchObject({ to: 'payer@example.test' });
  expect(f.email.messages[0]!.text).toContain('December 1, 2026');
  expect(f.email.messages[0]!.listUnsubscribe).toBeUndefined();
  expect(await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries))).toMatchObject([
    { key: `plan-price:${f.payload.requestKey}:${f.household.id}`, state: 'accepted', attempts: 1 },
  ]);
});
it('groups only the listed household memberships and quotes their own old prices', async () => {
  const f = await fixture();
  const second = await factory('members', f.gymId, { householdId: f.household.id, firstName: 'Noa', lastName: 'Second' });
  const extra = await factory('memberships', f.gymId, { ...f.membership, id: uuidv7(), memberId: second.id, amountCents: 8750 });
  const unlisted = await factory('members', f.gymId, { householdId: f.household.id, firstName: 'Unlisted' });
  await factory('memberships', f.gymId, { ...f.membership, id: uuidv7(), memberId: unlisted.id });
  f.payload.membershipIds.push(extra.id);
  await f.run();
  expect(f.email.messages).toHaveLength(1);
  for (const value of ['Mia First', 'Noa Second', '$100.00 per month', '$87.50 per month', '$125.00 per month'])
    expect(f.email.messages[0]!.text).toContain(value);
  expect(f.email.messages[0]!.text).not.toContain('Unlisted');
});
it('dispatches through the production area registrations and configured service', async () => {
  const f = await fixture(), queue = new FakeJobs(f.clock);
  configurePriceNotice(f.notice);
  const registry = createServerRegistry(areaContributions);
  expect(registry.emails.all().some(entry => entry.id === priceNoticeJob)).toBe(true);
  registry.registerJobs(queue, new Set());
  await queue.enqueue(priceNoticeJob, f.payload, { gymId: f.gymId, timezone: 'America/Los_Angeles' });
  await queue.runNext(); expect(f.email.messages).toHaveLength(1);
  expect(queue.jobs[0]!.status).toBe('completed');
});
it.each(['no_address', 'invalid_address', 'erased', 'opt_out', 'undeliverable', 'cancelled', 'replaced_amount', 'replaced_date', 'switch', 'applied'] as const)('completes without sending for %s and logs the reason without personal data', async reason => {
  const f = await fixture();
  if (reason === 'no_address' || reason === 'invalid_address')
    await db.forGym(f.gymId, tx => tx.update(households).set({ email: reason === 'no_address' ? null : 'not-an-address' }).where(eq(households.id, f.household.id)));
  else if (reason === 'erased' || reason === 'opt_out' || reason === 'undeliverable')
    await db.forGym(f.gymId, tx => tx.update(members).set(reason === 'erased' ? { anonymizedAt: f.clock.now() }
      : reason === 'opt_out' ? { emailOptOut: true } : { emailDeliverable: false }).where(eq(members.id, f.payer.id)));
  else {
    const anotherPlan = await factory('plans', f.gymId);
    await db.forGym(f.gymId, tx => tx.update(memberships).set(reason === 'cancelled' ? { status: 'cancelled' }
      : reason === 'replaced_amount' ? { scheduledAmountCents: 13000 }
      : reason === 'replaced_date' ? { scheduledOn: '2027-01-01' }
      : reason === 'switch' ? { scheduledPlanId: anotherPlan.id }
      : { scheduledPlanId: null, scheduledAmountCents: null, scheduledInterval: null, scheduledOn: null }).where(eq(memberships.id, f.membership.id)));
  }
  const lines: string[] = [], previous = setLogSink(line => lines.push(line));
  try {
    await f.jobs.enqueue(priceNoticeJob, f.payload, { gymId: f.gymId, timezone: 'America/Los_Angeles' });
    await f.jobs.runNext();
  } finally { setLogSink(previous); }
  expect(f.jobs.jobs[0]!.status).toBe('completed'); expect(f.email.messages).toHaveLength(0);
  const expected = reason === 'no_address' || reason === 'invalid_address' ? 'no_address' : reason === 'erased' ? 'payer_erased'
    : reason === 'opt_out' || reason === 'undeliverable' ? 'recipient_suppressed' : 'change_replaced';
  expect(lines.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: priceNoticeJob, reason: expected }));
  expect(lines.join('')).not.toContain('payer@example.test');
});
it('rejects an erased explicitly linked payer even after its email is cleared', async () => {
  const f = await fixture();
  await factory('householdUsers', f.gymId, { householdId: f.household.id, memberId: f.payer.id, scope: 'payer' });
  await db.forGym(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now(), email: null }).where(eq(members.id, f.payer.id)));
  await f.run(); expect(f.email.messages).toHaveLength(0);
});
it('sends nothing for another gym’s household or membership, or another household in the same gym', async () => {
  const a = await fixture(), b = await fixture();
  await a.notice.run(b.payload, a.gymId);
  await a.notice.run({ ...a.payload, householdId: b.household.id }, a.gymId);
  await a.notice.run({ ...a.payload, membershipIds: [b.membership.id] }, a.gymId);
  const other = await factory('households', a.gymId, { email: 'other@example.test' });
  await a.notice.run({ ...a.payload, householdId: other.id }, a.gymId);
  expect(a.email.messages).toHaveLength(0); expect(b.email.messages).toHaveLength(0);
});
it('does not resolve SMTP when member mail is off and retries missing SMTP after releasing the reservation', async () => {
  const f = await fixture();
  const disabledId = uuidv7(); await factory('gyms', disabledId, { memberEmailsEnabled: false });
  await f.notice.run(f.payload, disabledId); expect(f.options.mailer).not.toHaveBeenCalled();
  f.options.mailer.mockResolvedValueOnce(null);
  await expect(f.run()).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.email.messages).toHaveLength(0);
  await f.run(); expect(f.email.messages).toHaveLength(1);
});
it('rechecks member mail switch after SMTP preparation and releases the unused reservation', async () => {
  const f = await fixture();
  const user = await factory('authUser', f.gymId);
  const actor = { gymId: f.gymId, actor: { kind: 'user' as const, userId: user.id } };
  const goLive = createGoLiveService({ scope: db.forGym, clock: f.clock, smtpConfigured: async () => true });
  const emailSwitch = async (enabled: boolean) => goLive.update(actor,
    { revision: (await goLive.checklist(f.gymId)).revision, memberEmailsEnabled: enabled });
  f.options.mailer.mockImplementationOnce(async () => {
    expect(isInTransaction()).toBe(false);
    await emailSwitch(false);
    return f.email;
  });
  await f.jobs.enqueue(priceNoticeJob, f.payload, { gymId: f.gymId, timezone: 'America/Los_Angeles' });
  await f.jobs.runNext();
  expect(f.options.mailer).toHaveBeenCalledOnce();
  expect(f.jobs.jobs[0]!.status).toBe('completed');
  expect(f.email.messages).toHaveLength(0);
  expect(await db.forGym(f.gymId, tx => tx.select().from(emailDeliveries))).toMatchObject([
    { key: `plan-price:${f.payload.requestKey}:${f.household.id}`, state: 'not_accepted', attempts: 1 },
  ]);
  await emailSwitch(true);
  await f.run();
  expect(f.email.messages).toHaveLength(1);
});
it('rechecks erasure and a replaced change after SMTP preparation', async () => {
  for (const erase of [true, false]) {
    const f = await fixture();
    f.options.mailer.mockImplementation(async () => {
      if (erase) await db.forGym(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.payer.id)));
      else await db.forGym(f.gymId, tx => tx.update(memberships).set({ scheduledAmountCents: 13000 }).where(eq(memberships.id, f.membership.id)));
      return f.email;
    });
    await f.run(); expect(f.email.messages).toHaveLength(0);
  }
});
it('does not duplicate concurrent jobs or follow a payer address change with a second notice', async () => {
  const f = await fixture();
  await Promise.allSettled([f.run(), f.run()]); await f.run();
  await db.forGym(f.gymId, tx => tx.update(households).set({ email: 'new@example.test' }).where(eq(households.id, f.household.id)));
  await f.run(); expect(f.email.messages).toHaveLength(1);
});
it.each(['not_accepted', 'unknown'] as const)('retries only a proven non-send after %s', async acceptance => {
  const f = await fixture(); f.email.respondNext(new DeliveryError(acceptance, 'Transport failure'));
  await expect(f.run()).rejects.toMatchObject({ acceptance });
  await f.run(); expect(f.email.messages).toHaveLength(acceptance === 'not_accepted' ? 1 : 0);
  const audits = await db.forGym(f.gymId, tx => tx.select({ after: auditEvents.after }).from(auditEvents)
    .where(eq(auditEvents.action, 'billing.memberships.price_notice_decided')).orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id)));
  expect(audits.map(row => row.after)).toEqual([{ householdId: f.household.id, status: 'failed', reason: acceptance },
    ...(acceptance === 'not_accepted' ? [{ householdId: f.household.id, status: 'sent' }] : [])]);
});
it('uses only the demo outbox and refuses to fall through to SMTP when it is missing', async () => {
  const f = await fixture();
  const notice = createPriceNotice({ ...f.options, demoMode: true, demoEmailFor: gymId => new OutboxEmail(gymId, f.clock, db.forGym) });
  await notice.run(f.payload, f.gymId); expect(f.options.mailer).not.toHaveBeenCalled(); expect(f.email.messages).toHaveLength(0);
  expect(await db.forGym(f.gymId, tx => tx.select().from(emailOutbox))).toMatchObject([{ recipient: 'payer@example.test' }]);
  const missing = createPriceNotice({ ...f.options, demoMode: true });
  await expect(missing.run({ ...f.payload, requestKey: uuidv7() }, f.gymId)).rejects.toMatchObject({ code: 'unavailable' });
});
it('validates the stored payload and tolerates extra keys for rollback', async () => {
  const f = await fixture();
  expect(priceNoticePayload.safeParse({}).success).toBe(false);
  expect(priceNoticePayload.parse({ ...f.payload, futureField: true })).toEqual(f.payload);
  expect(priceNoticePayload.safeParse({ ...f.payload, effectiveOn: '2026-02-30' }).success).toBe(false);
});
