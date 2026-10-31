// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Assembly test inspects gym settings and queued jobs in real PostgreSQL.
import { auditEvents, emailOutbox, gyms, invoices, jobs, memberships, paymentAttempts, paymentMethods, payments, uuidv7 } from '@plaingym/db';
import * as stripeAdapter from '../infra/payments/stripe.js';
import { StripeFixtures } from '../infra/payments/stripe-fixtures.js';
import { clock, TestClock } from './clock.js';
import { setLogSink } from './log.js';
import { demoStripeEnv, useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database, factory } = app;

it('collects assigned invoices, retries a declined cycle, serves staff billing, and detaches cards through the runtime', async () => {
  const sandbox = app.sandbox, cookie = await app.login('owner'), headers = app.headers(sandbox, cookie);
  // Create the isolation fixture without billing seed data, as in the initial sandbox.
  const other = await app.createSandbox(), otherOrigin = other.origin;
  const [gym] = await database.forGym(sandbox.gymId, tx => tx.select().from(gyms).where(eq(gyms.id, sandbox.gymId)));
  const testClock = new TestClock('2028-03-01T12:00:00Z');
  const now = vi.spyOn(clock, 'now').mockImplementation(() => testClock.now());
  const transport = new StripeFixtures(sandbox.gymId, Math.floor(testClock.now().getTime() / 1000));
  const provider = vi.spyOn(stripeAdapter, 'stripeTransport').mockReturnValue(transport);
  const logs: unknown[] = [], previousLog = setLogSink(entry => { logs.push(JSON.parse(entry)); });
  const run = (name: string, payload: unknown = {}) => {
    const handler = app.handlers.get(name);
    expect(handler, name).toBeDefined();
    return handler!(payload, { gymId: sandbox.gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
  };
  const post = (path: string, body: unknown, base: string, extra: Record<string, string> = {}) => app.post(path, body, base, extra);
  try {
    await app.restart(demoStripeEnv);
    await database.forGym(sandbox.gymId, tx => tx.update(gyms).set({ timezone: 'UTC', billingEnabled: true, memberEmailsEnabled: true,
      // Keep this sandbox active while the fixed billing clock advances through day three.
      settings: { ...gym!.settings as Record<string, unknown>, demo: { sandbox: true, ready: true, expiresAt: '2028-03-05T12:00:00Z' } },
    }).where(eq(gyms.id, sandbox.gymId)));
    const home = await factory('households', sandbox.gymId, { email: 'runtime.payer@example.invalid', stripeCustomerId: 'cus_fixture' });
    const member = await factory('members', sandbox.gymId, { householdId: home.id });
    const plan = await factory('plans', sandbox.gymId, { amountCents: 10000, signupFeeCents: 2500 });
    const existingMember = await factory('members', sandbox.gymId, { householdId: home.id });
    await factory('memberships', sandbox.gymId, { householdId: home.id, memberId: existingMember.id, planId: plan.id,
      status: 'active', amountCents: 0, startsOn: '2028-02-01', nextDueOn: '2028-04-01' });
    const card = await factory('paymentMethods', sandbox.gymId, { householdId: home.id, processorId: 'pm_4242', isDefault: true });
    const assigned = await post('/api/billing/memberships', { householdId: home.id, memberId: member.id, planId: plan.id,
      startsOn: '2028-03-01', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' }, sandbox.origin, { cookie });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const assignedId = (await assigned.json()).data.id as string;
    const read = () => database.forGym(sandbox.gymId, tx => tx.select().from(invoices).where(eq(invoices.householdId, home.id)));
    const initial = await read();
    expect(initial).toHaveLength(2);
    expect(initial.every(invoice => invoice.status === 'paid')).toBe(true);
    // These effects were durably published by the same transitions used by the API and runner.
    const effectJobs = await database.forSystem(tx => tx.select().from(jobs).where(and(eq(jobs.gymId, sandbox.gymId), eq(jobs.name, 'billing.transitions.effect'))));
    for (const job of effectJobs) await run(job.name, (job.payload as { value: unknown }).value);
    expect((await database.forGym(sandbox.gymId, tx => tx.select().from(memberships).where(eq(memberships.id, assignedId))))[0]!.status).toBe('active');
    const listed = await app.runtime.app.request(sandbox.origin + '/api/billing/invoices?householdId=' + home.id, { headers });
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.map((invoice: { id: string }) => invoice.id).sort()).toEqual(initial.map(invoice => invoice.id).sort());
    const beforeReceipt = await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox));
    await run('billing.payments.receipt', { invoiceId: initial[0]!.id });
    const afterReceipt = await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox));
    expect(afterReceipt).toHaveLength(beforeReceipt.length + 1);
    expect(afterReceipt.at(-1)!.text).toContain(String(initial[0]!.number));
    // The day-three transition effect must reach the real attached retry handler.
    await database.forGym(sandbox.gymId, tx => tx.update(memberships).set({ nextDueOn: '2028-03-01' }).where(eq(memberships.id, assignedId)));
    await database.forGym(sandbox.gymId, tx => tx.update(paymentMethods).set({ processorId: 'pm_0341' }).where(eq(paymentMethods.id, card.id)));
    await run('billing.runner.daily');
    const cycle = (await read()).find(invoice => invoice.kind === 'cycle')!;
    expect(cycle.status).toBe('past_due');
    const billingDashboard = await app.runtime.app.request(sandbox.origin + '/api/dashboard/billing', { headers });
    expect(billingDashboard.status).toBe(200);
    expect((await billingDashboard.json()).data.widgets.map((widget: { id: string }) => widget.id).sort())
      .toEqual(['disputes', 'mrr', 'past_due', 'upcoming_charges']);
    const health = await app.runtime.app.request(sandbox.origin + '/api/health', { headers });
    expect(health.status).toBe(200);
    expect((await health.json()).data.tiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stripe_webhooks', status: 'warning', details: expect.objectContaining({ failed: 0, pending: 0 }) }),
      expect.objectContaining({ id: 'last_charge_run', status: 'healthy', details: expect.objectContaining({ result: 'succeeded', lastCompletedAt: testClock.now().toISOString() }) }),
    ]));
    const retry = (await database.forGym(sandbox.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.transition.effect.created'))))
      .find(event => (event.after as { kind?: string; invoiceId?: string; retryDay?: number })?.kind === 'retry'
        && (event.after as { invoiceId: string }).invoiceId === cycle.id && (event.after as { retryDay: number }).retryDay === 3);
    expect(retry).toBeDefined();
    testClock.set('2028-03-04T12:00:00Z');
    await database.forGym(sandbox.gymId, tx => tx.update(paymentMethods).set({ processorId: 'pm_4242' }).where(eq(paymentMethods.id, card.id)));
    await run('billing.transitions.effect', { effectId: retry!.targetId });
    expect((await read()).find(invoice => invoice.id === cycle.id)!.status).toBe('paid');
    expect(await database.forGym(sandbox.gymId, tx => tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, cycle.id)))).toHaveLength(2);
    // A failed provider call cannot turn the already-committed assignment into an API error.
    const another = await factory('members', sandbox.gymId, { householdId: home.id });
    const request = transport.request.bind(transport);
    const fail = vi.spyOn(transport, 'request').mockRejectedValue(new Error('synthetic provider outage'));
    const committed = await post('/api/billing/memberships', { householdId: home.id, memberId: another.id, planId: plan.id,
      startsOn: '2028-03-04', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' }, sandbox.origin, { cookie });
    expect(committed.status).toBe(201);
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'billing.collect_assigned' })]));
    fail.mockImplementation(request);
    const remove = () => post(`/api/billing/households/${home.id}/payment-methods/${card.id}/revoke`, {}, sandbox.origin, { cookie });
    expect((await remove()).status).toBe(200);
    expect(transport.requests.filter(input => input.path.endsWith('/detach'))).toHaveLength(1);
    const revoked = (await database.forGym(sandbox.gymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.id, card.id))))[0]!;
    expect(revoked.revokedAt).not.toBeNull(); expect(revoked.isDefault).toBe(false);
    expect((await remove()).status).toBe(200);
    await run('billing.payments.detach', { paymentMethodId: card.id });
    expect(transport.requests.filter(input => input.path.endsWith('/detach'))).toHaveLength(1);
    expect(await database.forGym(sandbox.gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, card.id), eq(auditEvents.action, 'billing.card.revoked'))))).toHaveLength(1);
    // Erasing a household's last member revokes its card and detaches it through the runtime's queue and provider.
    const erased = await factory('households', sandbox.gymId, { email: 'erased.payer@example.invalid' });
    const leaving = await factory('members', sandbox.gymId, { householdId: erased.id });
    const erasedCard = await factory('paymentMethods', sandbox.gymId, { householdId: erased.id, processorId: 'pm_3155', isDefault: true });
    const erasure = await post(`/api/members/${leaving.id}/anonymize`, { revision: leaving.revision }, sandbox.origin, { cookie });
    expect(erasure.status, await erasure.clone().text()).toBe(200);
    const detachJobs = await database.forGym(sandbox.gymId, tx => tx.select().from(jobs).where(eq(jobs.name, 'billing.payments.detach')));
    expect(detachJobs.map(job => (job.payload as { value: { paymentMethodId: string } }).value.paymentMethodId)).toContain(erasedCard.id);
    expect(transport.requests.filter(input => input.path.endsWith('/payment_methods/pm_3155/detach'))).toHaveLength(1);
    expect((await database.forGym(sandbox.gymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.id, erasedCard.id))))[0]!.revokedAt).not.toBeNull();
    // A dispute webhook records the dispute and queues the owner's alert at once, under the hourly scan's key.
    const [paid] = await database.forGym(sandbox.gymId, tx => tx.select().from(payments).where(eq(payments.invoiceId, cycle.id)));
    transport.objects.set('dp_runtime', { id: 'dp_runtime', object: 'dispute', payment_intent: paid!.paymentIntentId, amount: cycle.amountCents,
      currency: cycle.currency.toLowerCase(), status: 'needs_response', metadata: { gym_id: sandbox.gymId }, created: transport.now, livemode: false });
    const disputeEvent = JSON.stringify({ id: 'evt_runtime_dispute', object: 'event', type: 'charge.dispute.created', livemode: false,
      data: { object: { id: 'dp_runtime', object: 'dispute', metadata: { gym_id: sandbox.gymId } } } });
    const signedAt = Math.floor(testClock.now().getTime() / 1000);
    const disputed = await app.runtime.app.request(sandbox.origin + '/webhooks/stripe', { method: 'POST', body: disputeEvent,
      headers: { host: new URL(sandbox.origin).host, 'content-type': 'application/json', 'stripe-signature':
        `t=${signedAt},v1=${createHmac('sha256', demoStripeEnv.DEMO_STRIPE_WEBHOOK_SECRET).update(`${signedAt}.${disputeEvent}`).digest('hex')}` } });
    expect(disputed.status, await disputed.clone().text()).toBe(200);
    await run('billing.webhooks.dispatch', { eventId: 'evt_runtime_dispute' });
    expect((await read()).find(invoice => invoice.id === cycle.id)).toMatchObject({ disputeId: 'dp_runtime', disputeStatus: 'open' });
    const disputeAlerts = async () => (await database.forSystem(tx => tx.select().from(jobs).where(and(eq(jobs.gymId, sandbox.gymId),
      eq(jobs.name, 'billing.alerts.send'))))).filter(job => (job.payload as { value: { disputeId?: string } }).value.disputeId === 'dp_runtime');
    expect(await disputeAlerts()).toHaveLength(1);
    // Alerts use the real configured mail resolver and dashboard provider; the scan reuses the webhook's key.
    await run('billing.alerts.card_expiry'); await run('billing.alerts.disputes');
    expect(await disputeAlerts()).toHaveLength(1);
    const dashboard = await app.runtime.app.request(sandbox.origin + '/api/dashboard', { headers });
    expect(dashboard.status).toBe(200);
    expect((await dashboard.json()).data.widgets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'billing.disputes', count: 1 })]));
    // Another gym's authenticated staff can neither list nor read these invoices.
    // Return to the real clock so the other sandbox's 24-hour login remains valid.
    now.mockRestore();
    const otherHeaders = app.headers(other, await app.login('owner', other));
    const otherInvoices = await app.runtime.app.request(otherOrigin + '/api/billing/invoices', { headers: otherHeaders });
    expect(otherInvoices.status).toBe(200);
    expect((await otherInvoices.json()).data).toEqual([]);
    expect((await app.runtime.app.request(otherOrigin + '/api/billing/invoices/' + cycle.id, { headers: otherHeaders })).status).toBe(404);
  } finally {
    await database.forGym(sandbox.gymId, tx => tx.update(gyms).set({ settings: gym!.settings, billingEnabled: false }).where(eq(gyms.id, sandbox.gymId)));
    setLogSink(previousLog); now.mockRestore(); provider.mockRestore();
    await app.restart();
  }
}, 90_000);
