// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The test counts the alert's permanent queue key in its isolated database.
import { auditEvents, invoices, jobs, paymentAttempts, payments, refunds, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeGymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs, PostgresJobs } from '../../infra/jobs/index.js';
import { FakePayments, type PaymentObjectReference } from '../../infra/payments/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createBillingAlerts, sendAlertJob } from './alerts/index.js';
import { createBillingAlertJobs } from './alerts/alerts.jobs.js';
import { createChargeRunner } from './runner/index.js';
import { createInvoiceTransitions } from './transitions/index.js';
import type { WebhookHandler } from './webhooks/inbox.js';
import { registerBillingWebhookHandlers } from './webhooks/handlers/index.js';
import { processorRefundId } from './disputes-refunds.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2028-03-01T17:00:00Z'), timezone = 'America/Vancouver';
  await factory('gyms', gymId, { currency: 'CAD', timezone, billingEnabled: true });
  const home = await factory('households', gymId, { billingDay: 1, stripeCustomerId: 'cus_test' });
  const member = await factory('members', gymId, { householdId: home.id });
  const plan = await factory('plans', gymId, { interval: 'monthly', amountCents: 10000 });
  await factory('memberships', gymId, { householdId: home.id, memberId: member.id, planId: plan.id, status: 'active',
    interval: 'monthly', amountCents: 10000, startsOn: '2028-01-01', nextDueOn: '2028-03-01' });
  await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_test', isDefault: true });
  const settings = new FakeGymSettingsAccessor([await createGymSettingsAccessor({ scope: db.forGym }).get(gymId)]);
  const provider = new FakePayments(gymId, clock);
  provider.seedCustomer({ id: 'cus_test', email: 'payer@example.invalid' });
  // Alerts use the real queue, whose gym-scoped unique key is what sends a dispute notice once.
  const queue = new PostgresJobs({ database: db, clock, listGyms: async () => [{ gymId, timezone }] });
  const email = new FakeEmail(), mail = { ready: true, owners: async (): Promise<string[]> => ['owner@example.invalid'] };
  const alerts = createBillingAlerts({ scope: db.forGym, clock, jobs: queue, settings,
    accounts: { staffEmails: () => mail.owners() },
    async prepare() {
      if (!mail.ready) throw new Error('SMTP is not configured');
      return { email, origin: 'https://gym.example.invalid' };
    } });
  createServerRegistry({ jobs: createBillingAlertJobs(() => alerts) }).registerJobs(queue, new Set());
  const options = { scope: db.forGym, clock, settings, jobs: new FakeJobs(clock) };
  const transitions = createInvoiceTransitions(options);
  const runner = createChargeRunner({ ...options, transitions, disputeAlerts: alerts, async payments() { return provider; } });
  const handlers = new Map<string, WebhookHandler>();
  registerBillingWebhookHandlers({ register(type, handler) { handlers.set(type, handler); } },
    { scope: db.forGym, clock, transitions, disputeAlerts: alerts });
  const webhook = (type: string, reference: PaymentObjectReference) => handlers.get(type)!(
    { id: 'evt_' + uuidv7(), type, gymId, objectId: reference.id, objectKind: reference.kind },
    { gymId, clock, timezone, attempt: 1, jobId: uuidv7(), payments: provider });
  const restore = () => runner.postRestore(gymId, clock.now());
  const pause = async () => settings.set({ ...await settings.get(gymId), billingEnabled: false });
  const read = () => db.forGym(gymId, async tx => ({
    invoice: (await tx.select().from(invoices))[0]!,
    attempt: (await tx.select().from(paymentAttempts))[0]!,
    payments: await tx.select().from(payments), refunds: await tx.select().from(refunds),
    audits: await tx.select().from(auditEvents).orderBy(asc(auditEvents.id)),
    alertJobs: await tx.select().from(jobs).where(and(eq(jobs.gymId, gymId), eq(jobs.name, sendAlertJob))),
  }));
  const drain = async () => { for (let n = 0; n < 10 && await queue.runNext(); n++) { /* bounded */ } };
  return { gymId, provider, email, mail, alerts, runner, webhook, restore, pause, read, drain };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function charged(f: Fixture, options: { lost?: boolean } = {}) {
  if (options.lost) f.provider.loseNextResponse('confirmCharge');
  await f.runner.daily(f.gymId);
  await f.pause();
  return (await f.read()).attempt.paymentIntentId!;
}

describe('one dispute and refund writer for webhooks and restore', () => {
  it('raises the owner alert for a dispute found during restore once, under the webhook path key', async () => {
    const f = await fixture(), intentId = await charged(f);
    f.provider.recordDispute({ id: 'dp_restore', chargeId: intentId, amount: 10000, status: 'open' });
    expect(await f.restore()).toMatchObject({ readyForOwnerReview: true, issues: [] });
    expect((await f.read()).alertJobs).toHaveLength(1);
    // Rerunning restore, the dispute webhook and the hourly scan all reuse the same permanent key.
    await f.restore();
    await f.webhook('charge.dispute.created', { kind: 'dispute', id: 'dp_restore' });
    await f.alerts.disputes(f.gymId);
    await f.drain();
    await f.restore(); await f.alerts.disputes(f.gymId); await f.drain();
    const rows = await f.read();
    expect(rows.invoice).toMatchObject({ status: 'paid', disputeId: 'dp_restore', disputeStatus: 'open' });
    expect(rows.alertJobs).toHaveLength(1);
    expect(f.email.messages).toHaveLength(1);
    expect(f.email.messages[0]!.to).toBe('owner@example.invalid');
    expect(rows.audits.filter(row => row.action === 'billing.alert.dispute.sent')).toHaveLength(1);
    expect(rows.audits.filter(row => row.action === 'billing.invoice.disputed')).toHaveLength(1);
  });
  it('leaves the alert key unused while mail is unavailable, so the hourly scan still sends it', async () => {
    const f = await fixture(), intentId = await charged(f);
    f.provider.recordDispute({ id: 'dp_no_mail', chargeId: intentId, amount: 10000, status: 'open' });
    f.mail.ready = false;
    expect(await f.restore()).toMatchObject({ readyForOwnerReview: true });
    expect((await f.read()).alertJobs).toHaveLength(0);
    f.mail.ready = true;
    await f.alerts.disputes(f.gymId); await f.drain();
    expect((await f.read()).alertJobs).toHaveLength(1);
    expect(f.email.messages).toHaveLength(1);
  });
  it('keeps a recorded dispute when its alert cannot be queued, leaving it to the hourly scan', async () => {
    const f = await fixture(), intentId = await charged(f);
    f.provider.recordDispute({ id: 'dp_owner_lookup', chargeId: intentId, amount: 10000, status: 'open' });
    f.mail.owners = async () => { throw new Error('Owner lookup failed'); };
    await f.webhook('charge.dispute.created', { kind: 'dispute', id: 'dp_owner_lookup' });
    expect(await f.restore()).toMatchObject({ readyForOwnerReview: true, issues: [] });
    expect((await f.read()).invoice).toMatchObject({ disputeId: 'dp_owner_lookup', disputeStatus: 'open' });
    expect((await f.read()).alertJobs).toHaveLength(0);
    f.mail.owners = async () => ['owner@example.invalid'];
    await f.alerts.disputes(f.gymId); await f.drain();
    expect(f.email.messages).toHaveLength(1);
  });
  it('publishes the alert when a dispute is first recorded, not on its later status changes', async () => {
    const f = await fixture(), intentId = await charged(f);
    const publish = vi.spyOn(f.alerts, 'publishDispute');
    f.provider.recordDispute({ id: 'dp_status', chargeId: intentId, amount: 10000, status: 'open' });
    await f.webhook('charge.dispute.created', { kind: 'dispute', id: 'dp_status' });
    f.provider.recordDispute({ id: 'dp_status', chargeId: intentId, amount: 10000, status: 'won' });
    await f.webhook('charge.dispute.closed', { kind: 'dispute', id: 'dp_status' });
    expect((await f.read()).invoice).toMatchObject({ disputeId: 'dp_status', disputeStatus: 'won' });
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it('records the succeeded payment before a dispute webhook that arrives first', async () => {
    const f = await fixture(), intentId = await charged(f, { lost: true });
    expect((await f.read()).invoice.status).toBe('open');
    f.provider.recordDispute({ id: 'dp_early', chargeId: intentId, amount: 10000, status: 'open' });
    await f.webhook('charge.dispute.created', { kind: 'dispute', id: 'dp_early' });
    await f.webhook('charge.dispute.created', { kind: 'dispute', id: 'dp_early' });
    const rows = await f.read();
    expect(rows.invoice).toMatchObject({ status: 'paid', disputeId: 'dp_early', disputeStatus: 'open' });
    expect(rows.attempt.status).toBe('succeeded');
    expect(rows.payments).toHaveLength(1);
    expect(rows.payments[0]!.paymentIntentId).toBe(intentId);
    const actions = rows.audits.map(row => row.action);
    expect(actions.indexOf('billing.invoice.paid')).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf('billing.invoice.paid')).toBeLessThan(actions.indexOf('billing.invoice.disputed'));
    expect(actions.filter(action => action === 'billing.invoice.disputed')).toHaveLength(1);
    expect(rows.alertJobs).toHaveLength(1);
  });
  it('rejects a dispute on a payment that has not succeeded without writing it', async () => {
    const f = await fixture();
    f.provider.respondNextConfirmation('declined');
    await f.runner.daily(f.gymId);
    const before = await f.read();
    expect(before.invoice.status).toBe('past_due');
    f.provider.recordDispute({ id: 'dp_unpaid', chargeId: before.attempt.paymentIntentId!, amount: 10000, status: 'open' });
    await expect(f.webhook('charge.dispute.created', { kind: 'dispute', id: 'dp_unpaid' })).rejects.toThrow('Dispute payment is unresolved');
    expect((await f.read()).invoice.disputeId).toBeNull();
  });
  it.each(['webhook', 'restore'] as const)('records a dashboard refund as one row whichever path sees it first (%s)', async first => {
    const f = await fixture(), intentId = await charged(f);
    const refund = await f.provider.refund({ chargeId: intentId, amount: 2000, idempotencyKey: 'dashboard_refund' });
    const viaWebhook = () => f.webhook('refund.created', { kind: 'refund', id: refund.id });
    const viaRestore = async () => expect(await f.restore()).toMatchObject({ readyForOwnerReview: true });
    for (const step of first === 'webhook' ? [viaWebhook, viaRestore] : [viaRestore, viaWebhook]) await step();
    const rows = await f.read();
    expect(rows.refunds).toEqual([expect.objectContaining({ id: processorRefundId(f.gymId, refund.id), processorId: refund.id,
      amountCents: 2000, status: 'succeeded' })]);
    expect(rows.invoice.status).toBe('partially_refunded');
    expect(rows.audits.filter(row => row.action === 'billing.invoice.refunded')).toHaveLength(1);
  });
  it.each(['webhook', 'restore'] as const)('fills a duplicate-payment refund reservation from the %s path', async path => {
    const f = await fixture(), intentId = await charged(f), { payments: [payment] } = await f.read();
    const reservationId = uuidv7();
    await db.forGym(f.gymId, tx => tx.insert(refunds).values({ id: reservationId, gymId: f.gymId, paymentId: payment!.id,
      amountCents: 2000, currency: 'CAD', status: 'pending', createdAt: new Date('2028-03-01T17:00:00Z') }));
    const refund = await f.provider.refund({ chargeId: intentId, amount: 2000, idempotencyKey: 'duplicate_refund' });
    if (path === 'webhook') await f.webhook('refund.created', { kind: 'refund', id: refund.id });
    else expect(await f.restore()).toMatchObject({ readyForOwnerReview: true });
    expect((await f.read()).refunds).toEqual([expect.objectContaining({ id: reservationId, processorId: refund.id, status: 'succeeded' })]);
  });
  it.each(['webhook', 'restore'] as const)('records a refund that fails after success from the %s path', async path => {
    const f = await fixture(), intentId = await charged(f);
    const first = await f.provider.refund({ chargeId: intentId, amount: 2000, idempotencyKey: 'dashboard_refund' });
    const second = await f.provider.refund({ chargeId: intentId, amount: 3000, idempotencyKey: 'second_refund' });
    for (const refund of [first, second]) await f.webhook('refund.created', { kind: 'refund', id: refund.id });
    expect((await f.read()).invoice.status).toBe('partially_refunded');
    // Stripe now reports the second refund as failed.
    const read = f.provider.readPaymentObject.bind(f.provider);
    vi.spyOn(f.provider, 'readPaymentObject').mockImplementation(async reference => {
      const found = await read(reference);
      return found.status === 'found' && found.value.kind === 'refund' && found.value.object.id === second.id
        ? { status: 'found', value: { kind: 'refund', object: { ...found.value.object, status: 'failed' } } } : found;
    });
    if (path === 'webhook') await f.webhook('refund.failed', { kind: 'refund', id: second.id });
    else expect(await f.restore()).toMatchObject({ readyForOwnerReview: true });
    const rows = await f.read();
    expect(rows.refunds.map(row => [row.processorId, row.status]).sort()).toEqual([[first.id, 'succeeded'], [second.id, 'failed']].sort());
    expect(rows.invoice.status).toBe('partially_refunded');
    expect(rows.audits.filter(row => row.action === 'billing.refund.reversed')).toMatchObject([{ targetId: processorRefundId(f.gymId, second.id) }]);
    expect(rows.audits.filter(row => row.action === 'billing.transition.effect.created').map(row => row.after))
      .toContainEqual(expect.objectContaining({ kind: 'staff_notice', notice: 'refund_failed', refundId: processorRefundId(f.gymId, second.id) }));
    // The first refund fails as well: nothing is refunded any more.
    vi.mocked(f.provider.readPaymentObject).mockImplementation(async reference => {
      const found = await read(reference);
      return found.status === 'found' && found.value.kind === 'refund'
        ? { status: 'found', value: { kind: 'refund', object: { ...found.value.object, status: 'failed' } } } : found;
    });
    await f.webhook('refund.failed', { kind: 'refund', id: first.id });
    expect((await f.read()).invoice.status).toBe('paid');
  });
  /** Stripe reports these refunds with the given status from now on. */
  function report(f: Fixture, statuses: Map<string, 'pending' | 'failed'>) {
    const read = f.provider.readPaymentObject.bind(f.provider);
    vi.spyOn(f.provider, 'readPaymentObject').mockImplementation(async reference => {
      const found = await read(reference), status = found.status === 'found' && found.value.kind === 'refund'
        ? statuses.get(found.value.object.id) : undefined;
      return found.status === 'found' && found.value.kind === 'refund' && status
        ? { status: 'found', value: { kind: 'refund', object: { ...found.value.object, status } } } : found;
    });
  }
  const refundNotices = (rows: Awaited<ReturnType<Fixture['read']>>) => rows.audits
    .filter(row => row.action === 'billing.transition.effect.created' && (row.after as { notice?: string }).notice === 'refund_failed')
    .map(row => (row.after as { refundId: string }).refundId);
  it.each(['webhook', 'restore'] as const)('queues one staff notice for a refund first recorded as failed from the %s path', async first => {
    const f = await fixture(), intentId = await charged(f);
    const refund = await f.provider.refund({ chargeId: intentId, amount: 2000, idempotencyKey: 'dashboard_refund' });
    report(f, new Map([[refund.id, 'failed']]));
    const viaWebhook = () => f.webhook('refund.failed', { kind: 'refund', id: refund.id });
    const viaRestore = async () => expect(await f.restore()).toMatchObject({ readyForOwnerReview: true });
    // The first path records it; replaying either path afterwards changes nothing.
    for (const step of first === 'webhook' ? [viaWebhook, viaWebhook, viaRestore] : [viaRestore, viaRestore, viaWebhook]) await step();
    const rows = await f.read();
    expect(rows.refunds).toEqual([expect.objectContaining({ id: processorRefundId(f.gymId, refund.id), processorId: refund.id,
      status: 'failed' })]);
    expect(rows.invoice.status).toBe('paid');
    expect(refundNotices(rows)).toEqual([processorRefundId(f.gymId, refund.id)]);
    expect(rows.audits.filter(row => row.action === 'billing.refund.reversed')).toEqual([]);
  });
  it('queues one staff notice when a pending refund fails, however often the failure is replayed', async () => {
    const f = await fixture(), intentId = await charged(f);
    const refund = await f.provider.refund({ chargeId: intentId, amount: 2000, idempotencyKey: 'dashboard_refund' });
    const statuses = new Map<string, 'pending' | 'failed'>([[refund.id, 'pending']]);
    report(f, statuses);
    await f.webhook('refund.created', { kind: 'refund', id: refund.id });
    expect((await f.read()).refunds).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(refundNotices(await f.read())).toEqual([]);
    statuses.set(refund.id, 'failed');
    await f.webhook('refund.failed', { kind: 'refund', id: refund.id });
    await f.webhook('refund.failed', { kind: 'refund', id: refund.id });
    await f.webhook('refund.updated', { kind: 'refund', id: refund.id });
    expect(await f.restore()).toMatchObject({ readyForOwnerReview: true });
    const rows = await f.read();
    expect(rows.refunds).toEqual([expect.objectContaining({ processorId: refund.id, status: 'failed' })]);
    expect(rows.invoice.status).toBe('paid');
    expect(refundNotices(rows)).toEqual([processorRefundId(f.gymId, refund.id)]);
  });
  it('reads no processor intent during restore for a refund whose payment is recorded', async () => {
    const f = await fixture(), intentId = await charged(f), reads = vi.spyOn(f.provider, 'findCharge');
    const intentReads = async () => { reads.mockClear(); await f.restore(); return reads.mock.calls.filter(([reference]) => reference.id === intentId).length; };
    // The restore's own charge checks read the intent; the refund adds no read of its own.
    const baseline = await intentReads();
    const refund = await f.provider.refund({ chargeId: intentId, amount: 2000, idempotencyKey: 'dashboard_refund' });
    expect(await intentReads()).toBe(baseline);
    expect((await f.read()).refunds).toEqual([expect.objectContaining({ processorId: refund.id })]);
  });
});
