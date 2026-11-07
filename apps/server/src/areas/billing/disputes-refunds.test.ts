// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line database/system-tables -- One test reads backend PIDs to see the dispute writer wait on the gym row lock.
import { and, asc, eq, sql } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The test counts the alert's permanent queue key in its isolated database.
import { auditEvents, gyms, invoices, jobs, paymentAttempts, payments, refunds, uuidv7 } from '@plaingym/db';
import { stripeTestPaymentReference } from '@plaingym/shared/contracts';
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
  return { gymId, provider, email, mail, alerts, runner, transitions, webhook, restore, pause, read, drain };
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
  it('leaves a dispute of a payment a switch to live marked as test unrecorded, and restore never reads one', async () => {
    const f = await fixture(), intentId = await charged(f);
    await db.forGym(f.gymId, tx => tx.update(payments).set({ reference: stripeTestPaymentReference }).where(eq(payments.paymentIntentId, intentId)));
    const publish = vi.spyOn(f.alerts, 'publishDispute');
    f.provider.recordDispute({ id: 'dp_marked', chargeId: intentId, amount: 10000, status: 'open' });
    await f.webhook('charge.dispute.created', { kind: 'dispute', id: 'dp_marked' });
    expect((await f.read()).invoice).toMatchObject({ disputeId: null, disputeStatus: null });
    expect(publish).not.toHaveBeenCalled();
    // One recorded before the payment was marked, which the live key can't read: restore skips it.
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ disputeId: 'dp_test_account', disputeStatus: 'open' }));
    const reads = vi.spyOn(f.provider, 'readPaymentObject');
    const checked = await f.restore();
    expect(reads.mock.calls.some(([reference]) => reference.id === 'dp_test_account')).toBe(false);
    expect(checked.issues).not.toContainEqual(expect.objectContaining({ id: 'dp_test_account' }));
    expect((await f.read()).invoice).toMatchObject({ disputeId: 'dp_test_account', disputeStatus: 'open' });
  });
  it('waits for a switch to live that holds the gym row before recording a dispute, then leaves the marked payment’s dispute out', async () => {
    const f = await fixture(), intentId = await charged(f);
    f.provider.recordDispute({ id: 'dp_racing', chargeId: intentId, amount: 10000, status: 'open' });
    const locked = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    // The switch's save: it holds the gym row and marks the card payment as test, then waits to commit.
    const saving = db.forGym(f.gymId, async tx => {
      // eslint-disable-next-line database/system-tables -- The holder's backend PID, for the lock-wait probe.
      const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
      await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, f.gymId)).for('update');
      await tx.update(payments).set({ reference: stripeTestPaymentReference }).where(eq(payments.paymentIntentId, intentId));
      locked.resolve(pid); await release.promise;
    });
    const pid = await locked.promise;
    const recording = f.webhook('charge.dispute.created', { kind: 'dispute', id: 'dp_racing' });
    let finished = false;
    void recording.then(() => { finished = true; }, () => { finished = true; });
    try {
      let sawWait = false;
      // From the system connection: the switch and the waiting writer hold both of the gym pool's connections.
      for (let tries = 0; tries < 5_000 && !sawWait && !finished; tries++)
        // eslint-disable-next-line database/system-tables -- The lock-wait probe.
        sawWait = (await db.system.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`))[0]!.n > 0;
      expect(sawWait).toBe(true);
      expect(finished).toBe(false);
    } finally { release.resolve(); await saving; }
    await recording;
    expect((await f.read()).invoice).toMatchObject({ disputeId: null, disputeStatus: null });
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

describe('matching a processor refund to a refund reservation', () => {
  const system = (f: Fixture) => ({ gymId: f.gymId, actor: { kind: 'system' as const } });
  /** A reservation committed by the app; `tagged: false` is one from before the marker. */
  async function reserve(f: Fixture, amountCents: number, tagged = true) {
    const { invoice, payments: [payment] } = await f.read(), refundId = uuidv7();
    await f.transitions.refund(system(f), { invoiceId: invoice.id, paymentId: payment!.id, refundId, amountCents,
      currency: payment!.currency, status: 'pending', ...(tagged ? { tagged } : {}) });
    return refundId;
  }
  const row = async (f: Fixture, id: string) => (await f.read()).refunds.find(refund => refund.id === id);
  const dashboard = (f: Fixture, intentId: string, amount: number) => f.provider.refund({ chargeId: intentId, amount, idempotencyKey: `dashboard:${uuidv7()}` });
  const delivered = (f: Fixture, id: string) => f.webhook('refund.updated', { kind: 'refund', id });

  it('records a dashboard refund of the same amount as external and leaves the reservation pending', async () => {
    const f = await fixture(), intentId = await charged(f), reservation = await reserve(f, 2000);
    const refund = await dashboard(f, intentId, 2000);
    await delivered(f, refund.id); await delivered(f, refund.id);
    expect(await row(f, reservation)).toMatchObject({ status: 'pending', processorId: null });
    expect(await row(f, processorRefundId(f.gymId, refund.id))).toMatchObject({ status: 'succeeded', processorId: refund.id, taggedAt: null });
    expect((await f.read()).refunds).toHaveLength(2);
    expect((await f.read()).invoice.status).toBe('partially_refunded');
  });
  it('matches the app’s own refund to its reservation by row ID, beside a dashboard refund of the same amount', async () => {
    const f = await fixture(), intentId = await charged(f), first = await reserve(f, 2000), second = await reserve(f, 2000);
    const external = await dashboard(f, intentId, 2000), own = await f.provider.refund({ chargeId: intentId, amount: 2000, idempotencyKey: `refund:${second}`, reservationId: second });
    await delivered(f, own.id); await delivered(f, external.id);
    expect(await row(f, second)).toMatchObject({ status: 'succeeded', processorId: own.id });
    expect(await row(f, first)).toMatchObject({ status: 'pending', processorId: null });
    expect(await row(f, processorRefundId(f.gymId, external.id))).toMatchObject({ status: 'succeeded', processorId: external.id });
    expect((await f.read()).refunds).toHaveLength(3);
  });
  it('matches the reservation of a refund whose response was lost when restore finds it', async () => {
    const f = await fixture(), intentId = await charged(f), reservation = await reserve(f, 2000);
    const own = await f.provider.refund({ chargeId: intentId, amount: 2000, idempotencyKey: `refund:${reservation}`, reservationId: reservation });
    await f.restore();
    expect((await f.read()).refunds).toMatchObject([{ id: reservation, status: 'succeeded', processorId: own.id }]);
  });
  it('keeps the old match for a reservation from before the marker', async () => {
    const f = await fixture(), intentId = await charged(f), reservation = await reserve(f, 2000, false);
    const other = await dashboard(f, intentId, 1500);
    await expect(delivered(f, other.id)).rejects.toThrow('Refund reservation is ambiguous');
    expect((await f.read()).refunds).toMatchObject([{ id: reservation, status: 'pending', processorId: null, taggedAt: null }]);
    const same = await dashboard(f, intentId, 2000);
    await delivered(f, same.id);
    expect((await f.read()).refunds).toMatchObject([{ id: reservation, status: 'succeeded', processorId: same.id, taggedAt: null }]);
  });
  it.each(['failed', 'canceled'] as const)('still releases a reservation from before the marker when a refund ends %s', async status => {
    const f = await fixture(), intentId = await charged(f), reservation = await reserve(f, 2000, false);
    f.provider.respondNextRefund('pending');
    const refund = await dashboard(f, intentId, 2000);
    f.provider.setRefundStatus(refund.id, status);
    await delivered(f, refund.id);
    expect((await f.read()).refunds).toMatchObject([{ id: reservation, status, processorId: refund.id }]);
  });
  it.each(['failed', 'canceled'] as const)('releases a reservation when the app’s own refund ends %s', async status => {
    const f = await fixture(), intentId = await charged(f), reservation = await reserve(f, 10000);
    f.provider.respondNextRefund('pending');
    const own = await f.provider.refund({ chargeId: intentId, amount: 10000, idempotencyKey: `refund:${reservation}`, reservationId: reservation });
    f.provider.setRefundStatus(own.id, status);
    await delivered(f, own.id); await delivered(f, own.id);
    expect((await f.read()).refunds).toMatchObject([{ id: reservation, status, processorId: own.id }]);
    expect((await f.read()).invoice.status).toBe('paid');
    // The amount is free again, for a new reservation of all of it.
    await reserve(f, 10000);
  });
  it.each(['failed', 'canceled'] as const)('leaves a reservation pending when a dashboard refund ends %s', async status => {
    const f = await fixture(), intentId = await charged(f), reservation = await reserve(f, 10000);
    f.provider.respondNextRefund('pending');
    const refund = await dashboard(f, intentId, 10000);
    f.provider.setRefundStatus(refund.id, status);
    await delivered(f, refund.id);
    expect(await row(f, reservation)).toMatchObject({ status: 'pending', processorId: null });
    expect(await row(f, processorRefundId(f.gymId, refund.id))).toMatchObject({ status, processorId: refund.id });
  });
  it('releases only as many of the newest reservations as a dashboard refund leaves no room for, without a staff notice', async () => {
    const f = await fixture(), intentId = await charged(f);
    const older = await reserve(f, 4000), newer = await reserve(f, 4000), refund = await dashboard(f, intentId, 4000);
    await delivered(f, refund.id); await delivered(f, refund.id);
    expect(await row(f, older)).toMatchObject({ status: 'pending', processorId: null });
    expect(await row(f, newer)).toMatchObject({ status: 'failed', processorId: null });
    expect(await row(f, processorRefundId(f.gymId, refund.id))).toMatchObject({ status: 'succeeded', amountCents: 4000 });
    const effects = (await f.read()).audits.filter(audit => audit.action === 'billing.invoice.effect_created');
    expect(effects.filter(audit => (audit.after as { notice?: string }).notice === 'refund_failed')).toEqual([]);
  });
  it('records as external a refund that reached the processor after its reservation was released', async () => {
    const f = await fixture(), intentId = await charged(f), reservation = await reserve(f, 2000);
    await f.transitions.refund(system(f), { invoiceId: (await f.read()).invoice.id, paymentId: (await f.read()).payments[0]!.id,
      refundId: reservation, amountCents: 2000, currency: 'CAD', status: 'failed' });
    const own = await f.provider.refund({ chargeId: intentId, amount: 2000, idempotencyKey: `refund:${reservation}`, reservationId: reservation });
    await delivered(f, own.id);
    expect(await row(f, reservation)).toMatchObject({ status: 'failed', processorId: null });
    expect(await row(f, processorRefundId(f.gymId, own.id))).toMatchObject({ status: 'succeeded', processorId: own.id });
  });
  it('doesn’t attach a refund naming a reservation of another amount, an untagged row, or another payment', async () => {
    const f = await fixture(), intentId = await charged(f), reservation = await reserve(f, 2000), legacy = await reserve(f, 500, false);
    const { invoice } = await f.read();
    const otherPayment = await factory('payments', f.gymId, { invoiceId: invoice.id, currency: 'CAD', amountCents: 3000 });
    const elsewhere = uuidv7();
    await db.forGym(f.gymId, tx => tx.insert(refunds).values({ id: elsewhere, gymId: f.gymId, paymentId: otherPayment.id, amountCents: 1000,
      currency: 'CAD', taggedAt: new Date(), createdAt: new Date() }));
    for (const [named, amount] of [[reservation, 1500], [legacy, 500], [elsewhere, 1000]] as const) {
      const refund = await f.provider.refund({ chargeId: intentId, amount, idempotencyKey: `tagged:${named}`, reservationId: named });
      await delivered(f, refund.id);
      expect(await row(f, processorRefundId(f.gymId, refund.id))).toMatchObject({ status: 'succeeded', processorId: refund.id, amountCents: amount });
    }
    for (const id of [reservation, legacy, elsewhere]) expect(await row(f, id)).toMatchObject({ status: 'pending', processorId: null });
  });
  it('never takes another gym’s reservation, whatever the refund’s metadata says', async () => {
    const f = await fixture(), other = await fixture(), intentId = await charged(f);
    await charged(other);
    const theirs = await reserve(other, 2000), ours = await reserve(f, 2000);
    const refund = await f.provider.refund({ chargeId: intentId, amount: 2000, idempotencyKey: 'foreign', reservationId: theirs });
    await delivered(f, refund.id);
    expect(await row(other, theirs)).toMatchObject({ status: 'pending', processorId: null });
    expect(await row(f, ours)).toMatchObject({ status: 'pending', processorId: null });
    expect(await row(f, processorRefundId(f.gymId, refund.id))).toMatchObject({ status: 'succeeded', processorId: refund.id });
  });
});
