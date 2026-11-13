// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, classCreditEntries, classPackSales, classPacks, invoices, leads, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { FakePayments } from '../../../infra/payments/index.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createMembershipService } from '../memberships.js';
import { createInvoiceTransitions } from '../transitions/index.js';
import { createTransitionEffects } from '../transitions/effects.js';
import { applyChargeOutcome } from '../transitions/outcomes.js';
import { effectCompleted, effectCreated, type TransitionEffect } from '../transitions/store.js';
import { createTransitionJobs } from '../transitions/transitions.jobs.js';
import { createPackCredits } from './credits.js';
import { isPackHolder, returnCredit } from './ledger.js';
import { createPackSalesService } from './sales.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(amountCents = 10000, expiryDays: number | null = 3, paidAt = '2028-03-10T17:00:00Z') {
  const gymId = uuidv7(), timezone = 'America/New_York', clock = new TestClock(paidAt);
  await factory('gyms', gymId, { timezone, currency: 'CAD' });
  const member = await factory('members', gymId), pack = await factory('classPacks', gymId, { amountCents, expiryDays });
  const context = { gymId, actor: { kind: 'system' as const } }, settings = createGymSettingsAccessor({ scope: db.forGym });
  const options = { scope: db.forGym, clock, settings }, sales = createPackSalesService(options);
  const invoice = await sales.sell(context, pack.id, { memberId: member.id, dueOn: '2028-03-10' });
  const transitions = createInvoiceTransitions(options), provider = new FakePayments(gymId, clock);
  const afterInvoicePaid = vi.fn(async () => {});
  const effectOptions = { ...options, jobs: new FakeJobs(clock), transitions, memberships: createMembershipService(options),
    payments: async () => provider, notifications: { receipt: vi.fn(async () => {}), dunning: vi.fn(async () => {}), staffNotice: vi.fn(async () => {}) },
    retry: vi.fn(async () => {}), afterInvoicePaid };
  const effects = createTransitionEffects(effectOptions), credits = createPackCredits(options);
  const job = { jobId: uuidv7(), gymId, timezone, clock, attempt: 1 };
  const manual = { invoiceId: invoice.id, paymentId: uuidv7(), amountCents, currency: 'CAD', paidAt, method: 'cash' as const };
  const work = async (kind: TransitionEffect['kind']) => (await db.forGym(gymId, tx => tx.select().from(auditEvents)
    .where(eq(auditEvents.action, effectCreated)))).filter(row => (row.after as TransitionEffect).kind === kind);
  const run = async (kind: TransitionEffect['kind']) => { for (const row of await work(kind)) await effects.run(row.targetId, job); };
  const ledger = () => db.forGym(gymId, tx => tx.select().from(classCreditEntries).where(eq(classCreditEntries.memberId, member.id)));
  const audits = (action: string) => db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, action)));
  const refund = (amount = amountCents) => ({ invoiceId: invoice.id, paymentId: manual.paymentId,
    refundId: uuidv7(), amountCents: amount, currency: 'CAD', status: 'succeeded' as const });
  return { gymId, clock, context, member, pack, invoice, options, transitions, provider, effectOptions, effects, credits,
    job, manual, work, run, ledger, audits, refund, afterInvoicePaid };
}

describe('class pack invoice effects', () => {
  it('suppresses a delayed grant from its durable reversal command without a refund audit snapshot', async () => {
    const f = await fixture();
    await f.transitions.manualPayment(f.context, f.manual);
    await factory('auditEvents', f.gymId, { action: effectCreated,
      after: { kind: 'reverse_credits', invoiceId: f.invoice.id } });
    await f.run('activate_memberships');
    expect(await f.ledger()).toEqual([]);
  });

  it('skips credit grant work and full-refund effects for an invoice without a pack sale', async () => {
    const f = await fixture(), invoice = await factory('invoices', f.gymId,
      { householdId: f.member.householdId, amountCents: f.manual.amountCents, currency: 'CAD', status: 'open', number: 2 });
    const paymentId = uuidv7();
    await f.transitions.manualPayment(f.context, { ...f.manual, invoiceId: invoice.id, paymentId });
    const settings = vi.spyOn(f.options.settings, 'get');
    settings.mockClear();
    await f.run('activate_memberships');
    expect(settings).not.toHaveBeenCalled();
    await f.transitions.refund(f.context, { ...f.refund(), invoiceId: invoice.id, paymentId });
    expect(await f.work('reverse_credits')).toEqual([]);
    expect(await f.ledger()).toEqual([]);
  });

  it('recovers an interrupted zero-price sale through the hourly job and grants once', async () => {
    const f = await fixture(0), settleZero = vi.fn(f.transitions.settleZero).mockRejectedValueOnce(new Error('lost connection'));
    const sales = createPackSalesService({ ...f.options, transitions: { settleZero } });
    await expect(sales.sell(f.context, f.pack.id, { memberId: f.member.id, dueOn: '2028-03-10' })).rejects.toThrow('lost connection');
    const invoiceId = settleZero.mock.calls[0]![1].invoiceId;
    expect((await db.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, invoiceId))))[0]!.status).toBe('open');
    const job = createTransitionJobs(() => f.effects).find(job => job.id === 'billing.transitions.publish')!;
    await job.handler({}, f.job);
    await f.run('activate_memberships');
    await job.handler({}, f.job);
    await f.run('activate_memberships');
    expect((await db.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, invoiceId))))[0]!.status).toBe('paid');
    const [sale] = await db.forGym(f.gymId, tx => tx.select().from(classPackSales).where(eq(classPackSales.invoiceId, invoiceId)));
    expect((await f.ledger()).filter(row => row.saleId === sale!.id)).toMatchObject([{ kind: 'grant', credits: f.pack.credits }]);
  });
  it('leaves held zero one-offs for staff and still settles and publishes past one that fails', async () => {
    const f = await fixture(), zero = { householdId: f.member.householdId, amountCents: 0, currency: 'CAD', status: 'open', dueOn: '2028-03-10' };
    const held = await factory('invoices', f.gymId, { ...zero, number: 2, needsReview: true });
    const failing = await factory('invoices', f.gymId, { ...zero, number: 3 });
    const due = await factory('invoices', f.gymId, { ...zero, number: 4 });
    const settleZero = vi.fn(f.transitions.settleZero);
    settleZero.mockImplementation(async (context, request) => {
      if (request.invoiceId === failing.id) throw new Error('lost connection');
      return f.transitions.settleZero(context, request);
    });
    const effects = createTransitionEffects({ ...f.effectOptions, transitions: { ...f.transitions, settleZero } });
    const publish = vi.spyOn(effects, 'publish');
    const job = createTransitionJobs(() => effects).find(job => job.id === 'billing.transitions.publish')!;
    await expect(job.handler({}, f.job)).rejects.toThrow('lost connection');
    expect(publish).toHaveBeenCalledWith(f.gymId);
    const status = async (id: string) => (await db.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, id))))[0]!.status;
    expect([await status(held.id), await status(failing.id), await status(due.id)]).toEqual(['open', 'open', 'paid']);
    expect(settleZero.mock.calls.map(call => call[1].invoiceId)).not.toContain(held.id);
  });
  it.each(['same event', 'webhook after runner', 'runner after webhook'])('grants once for card success: %s', async replay => {
    const f = await fixture(), attemptId = uuidv7();
    const intent = await f.provider.createCharge({ amount: f.invoice.amountCents, currency: 'cad', customerId: 'cus_test',
      paymentMethodId: 'pm_test', invoiceId: f.invoice.id, attemptId, idempotencyKey: f.invoice.id + ':create' });
    await factory('paymentAttempts', f.gymId, { id: attemptId, invoiceId: f.invoice.id, paymentIntentId: intent.id, currency: 'CAD' });
    const outcome = await f.provider.confirmCharge(intent.id, { idempotencyKey: f.invoice.id + ':confirm' });
    const identity = { invoiceId: f.invoice.id, paymentId: uuidv7(), attemptId, paidAt: f.clock.now().toISOString() };
    expect((await applyChargeOutcome(f.transitions, f.context, identity, outcome))?.outcome).toBe('applied');
    await f.run('activate_memberships');
    expect((await applyChargeOutcome(f.transitions, f.context, { ...identity,
      paymentId: replay === 'same event' ? identity.paymentId : uuidv7() }, outcome))?.outcome).toBe('ignored');
    await f.run('activate_memberships');
    expect(await f.ledger()).toMatchObject([{ kind: 'grant', credits: 10 }]);
    expect(await f.audits('billing.credits.granted')).toHaveLength(1);
  });

  it('manual payment replay and concurrent grant execution write one grant and audit before the paid hook', async () => {
    const f = await fixture();
    await f.transitions.manualPayment(f.context, f.manual);
    expect((await f.transitions.manualPayment(f.context, f.manual)).outcome).toBe('ignored');
    f.afterInvoicePaid.mockImplementation(async () => { expect(await f.ledger()).toHaveLength(1); });
    await Promise.all([f.run('activate_memberships'), f.run('activate_memberships')]);
    expect(await f.ledger()).toHaveLength(1);
    expect(await f.audits('billing.credits.granted')).toHaveLength(1);
    expect(await f.work('activate_memberships')).toHaveLength(1);
  });

  it('restarts after a crash between the grant commit and effect completion without granting again', async () => {
    const f = await fixture();
    await f.transitions.manualPayment(f.context, f.manual);
    f.afterInvoicePaid.mockRejectedValueOnce(new Error('crash after grant'));
    await expect(f.run('activate_memberships')).rejects.toThrow('crash after grant');
    expect(await f.ledger()).toHaveLength(1);
    expect(await f.audits(effectCompleted)).toHaveLength(0);
    const restarted = createTransitionEffects(f.effectOptions), [work] = await f.work('activate_memberships');
    await restarted.run(work!.targetId, f.job);
    expect(await f.ledger()).toHaveLength(1);
    expect(await f.audits('billing.credits.granted')).toHaveLength(1);
    expect(await f.audits(effectCompleted)).toHaveLength(1);
  });

  it('partial refunds preserve credits; a full refund reverses eight unused credits after two uses exactly once', async () => {
    const f = await fixture();
    await f.transitions.manualPayment(f.context, f.manual); await f.run('activate_memberships');
    const [grant] = await f.ledger();
    await db.forGym(f.gymId, tx => tx.insert(classCreditEntries).values([1, 2].map(() => ({ id: uuidv7(), gymId: f.gymId,
      memberId: f.member.id, kind: 'use', credits: -1, lotId: grant!.id, attendanceId: uuidv7() }))));
    await f.transitions.refund(f.context, f.refund(2000));
    expect(await f.work('reverse_credits')).toHaveLength(0);
    expect((await f.ledger()).reduce((sum, row) => sum + row.credits, 0)).toBe(8);
    const rest = f.refund(8000);
    await f.transitions.refund(f.context, rest); await f.transitions.refund(f.context, rest);
    expect(await f.work('reverse_credits')).toHaveLength(1);
    await Promise.all([f.run('reverse_credits'), f.run('reverse_credits')]);
    expect((await f.ledger()).filter(row => row.kind === 'reverse')).toMatchObject([{ credits: -8, lotId: grant!.id, saleId: grant!.saleId }]);
    expect(await f.audits('billing.credits.reversed')).toHaveLength(1);
    await f.credits.grant(f.gymId, f.invoice.id);
    expect((await f.ledger()).reduce((sum, row) => sum + row.credits, 0)).toBe(0);
  });

  it.each(['grant first', 'reversal first'])('a refund committed before activation grants nothing (%s)', async order => {
    const f = await fixture();
    await f.transitions.manualPayment(f.context, f.manual); await f.transitions.refund(f.context, f.refund());
    const kinds = order === 'grant first' ? ['activate_memberships', 'reverse_credits'] as const : ['reverse_credits', 'activate_memberships'] as const;
    for (const kind of kinds) await f.run(kind);
    expect(await f.ledger()).toEqual([]);
    expect(await f.audits(effectCompleted)).toHaveLength(2);
  });

  it.each([false, true])('a full refund that later fails never restores credits (grant already ran: %s)', async activated => {
    const f = await fixture();
    const success = { ...f.manual, paymentIntentId: 'pi_' + uuidv7(), chargeId: 'ch_' + uuidv7() };
    await f.transitions.cardSucceeded(f.context, success);
    if (activated) await f.run('activate_memberships');
    const refund = { ...f.refund(), processorId: 're_' + uuidv7() };
    await f.transitions.refund(f.context, refund);
    await f.transitions.refund(f.context, { ...refund, status: 'failed' });
    await f.run('activate_memberships'); await f.run('reverse_credits');
    await f.credits.grant(f.gymId, f.invoice.id);
    expect((await f.ledger()).reduce((sum, row) => sum + row.credits, 0)).toBe(0);
    expect((await f.ledger()).filter(row => row.kind === 'grant')).toHaveLength(activated ? 1 : 0);
  });

  it('a fully consumed lot completes reversal without a zero entry', async () => {
    const f = await fixture();
    await f.transitions.manualPayment(f.context, f.manual); await f.run('activate_memberships');
    const [grant] = await f.ledger();
    await db.forGym(f.gymId, tx => tx.insert(classCreditEntries).values({ id: uuidv7(), gymId: f.gymId, memberId: f.member.id,
      kind: 'expire', credits: -10, lotId: grant!.id }));
    await f.transitions.refund(f.context, f.refund()); await f.run('reverse_credits');
    expect(await f.ledger()).toHaveLength(2);
    expect(await f.audits(effectCompleted)).toHaveLength(2);
    expect(await f.audits('billing.credits.reversed')).toHaveLength(0);
  });

  it('replaying reversal after its ledger commit does not double reverse', async () => {
    const f = await fixture();
    await f.transitions.manualPayment(f.context, f.manual); await f.run('activate_memberships');
    await f.transitions.refund(f.context, f.refund());
    await f.credits.reverse(f.gymId, f.invoice.id); // Simulate a crash before the effect writes completion.
    await f.run('reverse_credits');
    expect(await f.ledger()).toMatchObject([{ kind: 'grant' }, { kind: 'reverse', credits: -10 }]);
    expect(await f.audits('billing.credits.reversed')).toHaveLength(1);
  });

  it('a zero-price sale settles itself and its effect grants once without a collection action', async () => {
    const f = await fixture(0, null);
    expect(f.invoice).toMatchObject({ status: 'paid', amountCents: 0, paidAt: f.clock.now().toISOString() });
    expect(await f.work('activate_memberships')).toHaveLength(1);
    await f.run('activate_memberships');
    expect(await f.ledger()).toMatchObject([{ kind: 'grant', credits: 10, expiresAt: null }]);
    await f.transitions.settleZero(f.context, { invoiceId: f.invoice.id }); await f.run('activate_memberships');
    expect(await f.ledger()).toHaveLength(1);
    expect(await f.audits('billing.credits.granted')).toHaveLength(1);
    expect(await f.audits('billing.invoice.settled_zero')).toHaveLength(1);
    expect(await f.work('activate_memberships')).toHaveLength(1);
  });

  it('never grants an unpaid invoice', async () => {
    const f = await fixture();
    await f.credits.grant(f.gymId, f.invoice.id);
    expect(await f.ledger()).toHaveLength(0);
  });

  it.each([
    ['2028-03-10T17:00:00Z', '2028-03-13T04:00:00.000Z'],
    ['2028-11-03T17:00:00Z', '2028-11-06T05:00:00.000Z'],
    ['2028-03-11T02:00:00Z', '2028-03-13T04:00:00.000Z'],
  ])('expires at local midnight after the local payment date, across DST (%s)', async (paidAt, expiry) => {
    const f = await fixture(10000, 3, paidAt);
    await f.transitions.manualPayment(f.context, f.manual);
    await f.run('activate_memberships');
    expect((await f.ledger())[0]!.expiresAt?.toISOString()).toBe(expiry);
  });

  it('counts expiry from the grant\'s own date when it is later than the payment\'s, so no credit starts expired', async () => {
    // Paid (or recorded as paid) on 10 March, granted on 20 March: three days from the grant.
    const f = await fixture(10000, 3, '2028-03-10T17:00:00Z');
    await f.transitions.manualPayment(f.context, f.manual);
    f.clock.advance(10 * 86_400_000);
    await f.run('activate_memberships');
    expect((await f.ledger())[0]!.expiresAt?.toISOString()).toBe('2028-03-23T04:00:00.000Z');
  });

  it('grants nothing to a member erased before the pack was paid, and tells staff once', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.member.id)));
    await f.transitions.manualPayment(f.context, f.manual);
    await f.run('activate_memberships');
    await f.credits.grant(f.gymId, f.invoice.id);
    expect(await f.ledger()).toEqual([]);
    expect(await f.audits('billing.credits.not_granted')).toMatchObject([{ targetType: 'class_pack_sale', after: { invoiceId: f.invoice.id, credits: 10 } }]);
    const notices = (await f.work('staff_notice')).filter(row => (row.after as TransitionEffect).notice === 'credits_not_granted');
    expect(notices).toHaveLength(1);
    await f.run('staff_notice');
    expect(f.effectOptions.notifications.staffNotice).toHaveBeenCalledWith(expect.objectContaining({ reason: 'credits_not_granted', credits: 10 }));
  });

  it('names the credits a full refund reversed in the notice when that refund later fails', async () => {
    const f = await fixture();
    const success = { ...f.manual, paymentIntentId: 'pi_' + uuidv7(), chargeId: 'ch_' + uuidv7() };
    await f.transitions.cardSucceeded(f.context, success);
    await f.run('activate_memberships');
    const refund = { ...f.refund(), processorId: 're_' + uuidv7() };
    await f.transitions.refund(f.context, refund);
    await f.run('reverse_credits');
    await f.transitions.refund(f.context, { ...refund, status: 'failed' });
    await f.run('staff_notice');
    expect(f.effectOptions.notifications.staffNotice).toHaveBeenCalledWith(expect.objectContaining({ reason: 'refund_failed', reversedCredits: 10 }));
  });

  it('returns no credit for a visit undone after a full refund, and a refunded pack no longer makes a pack holder', async () => {
    const f = await fixture();
    await f.transitions.manualPayment(f.context, f.manual); await f.run('activate_memberships');
    const [grant] = await f.ledger(), kept = uuidv7(), undone = uuidv7();
    await db.forGym(f.gymId, tx => tx.insert(classCreditEntries).values([kept, undone].map(attendanceId => ({ id: uuidv7(), gymId: f.gymId,
      memberId: f.member.id, kind: 'use', credits: -1, lotId: grant!.id, attendanceId }))));
    expect(await db.forGym(f.gymId, tx => isPackHolder(tx, f.member.id))).toBe(true);
    // Before the refund an undone visit gets its credit back.
    expect(await db.forGym(f.gymId, tx => returnCredit(tx, { gymId: f.gymId, memberId: f.member.id, attendanceId: kept, now: f.clock.now() }))).toBe(true);
    await f.transitions.refund(f.context, f.refund()); await f.run('reverse_credits');
    expect((await f.ledger()).reduce((sum, row) => sum + row.credits, 0)).toBe(0);
    expect(await db.forGym(f.gymId, tx => returnCredit(tx, { gymId: f.gymId, memberId: f.member.id, attendanceId: undone, now: f.clock.now() }))).toBe(false);
    expect((await f.ledger()).reduce((sum, row) => sum + row.credits, 0)).toBe(0);
    expect(await db.forGym(f.gymId, tx => returnCredit(tx, { gymId: f.gymId, memberId: f.member.id, attendanceId: uuidv7(), now: f.clock.now() }))).toBeNull();
    expect(await db.forGym(f.gymId, tx => isPackHolder(tx, f.member.id))).toBe(false);
    // Credits staff add by adjustment still make a pack holder.
    await factory('classCreditEntries', f.gymId, { memberId: f.member.id, credits: 1 });
    expect(await db.forGym(f.gymId, tx => isPackHolder(tx, f.member.id))).toBe(true);
  });

  it('marks the buyer\'s lead won when the pack is paid', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'prospect' }).where(eq(members.id, f.member.id)));
    await f.transitions.manualPayment(f.context, f.manual);
    await f.run('activate_memberships');
    expect(await db.forGym(f.gymId, tx => tx.select().from(leads).where(eq(leads.memberId, f.member.id))))
      .toMatchObject([{ stage: 'won', wonAt: f.clock.now() }]);
  });

  it('uses sale snapshots after catalog edits, follows the member after a household move, and isolates gyms', async () => {
    const f = await fixture(), other = await fixture();
    const home = await factory('households', f.gymId);
    await db.forGym(f.gymId, async tx => {
      await tx.update(classPacks).set({ credits: 99, expiryDays: 100 }).where(eq(classPacks.id, f.pack.id));
      await tx.update(members).set({ householdId: home.id }).where(eq(members.id, f.member.id));
    });
    await f.transitions.manualPayment(f.context, f.manual); await f.run('activate_memberships');
    expect(await f.ledger()).toMatchObject([{ memberId: f.member.id, credits: 10, expiresAt: new Date('2028-03-13T04:00:00Z') }]);
    expect(await db.forGym(f.gymId, tx => tx.select().from(classPackSales))).toMatchObject([{ householdId: f.member.householdId }]);
    await expect(f.credits.grant(f.gymId, other.invoice.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.credits.reverse(f.gymId, other.invoice.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await other.ledger()).toHaveLength(0);
    expect(await db.forGym(f.gymId, tx => tx.select().from(invoices).where(and(eq(invoices.id, f.invoice.id),
      eq(invoices.householdId, f.member.householdId))))).toHaveLength(1);
  });
  it('grants the full pack when a partial refund precedes activation', async () => {
    const f = await fixture();
    await f.transitions.manualPayment(f.context, f.manual);
    await f.transitions.refund(f.context, f.refund(2000)); await f.run('activate_memberships');
    expect(await f.ledger()).toMatchObject([{ kind: 'grant', credits: 10 }]);
  });

  it('serializes a grant racing a full refund, leaving no usable credits', async () => {
    const f = await fixture();
    await f.transitions.manualPayment(f.context, f.manual);
    await Promise.all([f.run('activate_memberships'), f.transitions.refund(f.context, f.refund())]);
    await f.run('reverse_credits');
    expect((await f.ledger()).reduce((sum, row) => sum + row.credits, 0)).toBe(0);
    expect((await f.ledger()).filter(row => row.kind === 'grant').length).toBeLessThanOrEqual(1);
  });

  it('counts adjustments, undone attendance and expiry on only the refunded lot', async () => {
    const f = await fixture();
    await f.transitions.manualPayment(f.context, f.manual); await f.run('activate_memberships');
    const [grant] = await f.ledger(), attendanceId = uuidv7();
    await db.forGym(f.gymId, tx => tx.insert(classCreditEntries).values([
      { id: uuidv7(), gymId: f.gymId, memberId: f.member.id, kind: 'use', credits: -1, lotId: grant!.id, attendanceId },
      { id: uuidv7(), gymId: f.gymId, memberId: f.member.id, kind: 'reverse', credits: 1, lotId: grant!.id, attendanceId },
      { id: uuidv7(), gymId: f.gymId, memberId: f.member.id, kind: 'adjust', credits: -2, lotId: grant!.id, adjustmentId: uuidv7(), reason: 'Correction' },
      { id: uuidv7(), gymId: f.gymId, memberId: f.member.id, kind: 'expire', credits: -3, lotId: grant!.id },
      { id: uuidv7(), gymId: f.gymId, memberId: f.member.id, kind: 'adjust', credits: 7, adjustmentId: uuidv7(), reason: 'Separate lot' },
    ]));
    await f.transitions.refund(f.context, f.refund()); await f.run('reverse_credits');
    const ledger = await f.ledger();
    expect(ledger.filter(row => row.kind === 'reverse' && row.saleId)).toMatchObject([{ credits: -5 }]);
    expect(ledger.reduce((sum, row) => sum + row.credits, 0)).toBe(7);
  });
});
