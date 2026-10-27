// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createApp } from '../../../app.js';
import { createAccountService } from '../../../infra/auth/accounts.js';
import { authConfig } from '../../../infra/auth/config.js';
import { authorize } from '../../staff/auth.permissions.js';
import { createPaymentRoutes } from '../payments.routes.js';
import { createBillingAlerts, createDisputeAlertProvider } from '../alerts/index.js';
import { createBillingAlertJobs } from '../alerts/alerts.jobs.js';
import { clearJobs, origin, workflowFixture } from './workflow-fixture.js';

const db = useTestDatabase();
beforeEach(() => clearJobs(db));

describe('refunds, disputes and access through composed billing services', () => {
  it('dashboard refunds without invoice metadata resolve through the payment; pending and failed never refund it', async () => {
    const f = await workflowFixture(db); await f.runJob('billing.runner.daily');
    const paid = (await f.read()).payments[0]!;
    for (const status of ['failed', 'pending', 'succeeded']) {
      const id = status === 'failed' ? 're_failed' : 're_dashboard';
      f.transport.objects.set(id, { id, object: 'refund', charge: paid.chargeId,
        amount: 2500, currency: 'usd', status, metadata: {}, created: f.transport.now });
      const event = await f.deliver('refund.updated', id); await f.drain();
      await f.inbox.replay(f.gymId, event); await f.drain();
      expect((await f.read()).invoices[0]!.status).toBe(status === 'succeeded' ? 'partially_refunded' : 'paid');
      expect((await f.read()).refunds.find(r => r.processorId === id)).toMatchObject({ status });
    }
    await f.service.refund(f.context, paid.id, { amountCents: 7500, currency: 'USD', reason: 'Remaining balance' }); await f.drain();
    expect((await f.read()).invoices[0]!.status).toBe('refunded');
    expect((await f.read()).refunds.filter(r => r.status === 'succeeded').reduce((sum, r) => sum + r.amountCents, 0)).toBe(10000);
    expect((await f.read()).refunds.filter(r => r.status === 'succeeded')).toHaveLength(2);
    expect(f.email.messages.filter(m => m.subject.startsWith('Receipt'))).toHaveLength(1);
  });

  it('dispute webhook replay sends one owner email, shows one alert and cannot regress a terminal outcome', async () => {
    const f = await workflowFixture(db); await f.runJob('billing.runner.daily');
    await f.factory('staffRoles', f.gymId, { userId: f.user.id, role: 'owner' });
    const accounts = createAccountService(authConfig({ AUTH_SECRET: 'scenario-auth-secret-at-least-32-characters' }, false), () => db.system.db);
    const alerts = createBillingAlerts({ ...f.common, accounts, prepare: async () => ({ email: f.email, origin, gymName: 'Test Gym' }) });
    for (const job of createBillingAlertJobs(() => alerts)) f.queue.handle(job.id, job.handler);
    const paid = (await f.read()).payments[0]!;
    const dispute = { id: 'dp_scenario', object: 'dispute', charge: paid.chargeId, amount: 10000, currency: 'usd',
      status: 'needs_response', metadata: {}, created: f.transport.now };
    f.transport.objects.set(dispute.id, dispute);
    const event = await f.deliver('charge.dispute.created', dispute.id); await f.drain();
    await f.runJob('billing.alerts.disputes'); await f.inbox.replay(f.gymId, event); await f.drain();
    await f.runJob('billing.alerts.disputes');
    expect(f.email.messages.filter(m => m.to === f.user.email)).toHaveLength(1);
    const widget = createDisputeAlertProvider({ scope: db.forGym });
    const readWidget = () => widget.read({ gymId: f.gymId, roles: ['owner'], clock: f.clock });
    expect(await readWidget()).toHaveProperty('count', 1);
    dispute.status = 'won'; await f.deliver('charge.dispute.closed', dispute.id); await f.drain();
    // A delayed creation event refetches the current provider object.
    await f.inbox.replay(f.gymId, event); await f.drain(); await f.runJob('billing.alerts.disputes');
    expect(await readWidget()).toHaveProperty('count', 0);
    expect((await f.read()).invoices[0]).toMatchObject({ status: 'paid', disputeId: dispute.id, disputeStatus: 'won' });
    expect(f.email.messages.filter(m => m.to === f.user.email)).toHaveLength(1);
  });

  it('front desk records cash but cannot refund, and foreign gym or household cannot read or mutate the invoice', async () => {
    const f = await workflowFixture(db, { empty: true }), foreign = await workflowFixture(db, { empty: true });
    const invoice = await f.service.createOneOff(f.context, { source: 'custom', householdId: f.home.id, dueOn: '2028-03-01',
      description: 'Private lesson', amountCents: 10000, currency: 'USD' });
    const app = createApp({ clock: f.clock, origin, authorize, skipSetup: true, contributions: { routes: createPaymentRoutes(f.service) },
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: f.timezone, enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: ['front_desk'] } }); await next(); } });
    const post = (path: string, body: object) => app.request(origin + path, { method: 'POST',
      headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    const cash = await post(`/api/billing/invoices/${invoice.id}/payments`, { method: 'cash', amountCents: 10000,
      currency: 'USD', paidAt: f.clock.now().toISOString() });
    expect(cash.status, await cash.clone().text()).toBe(201); await f.drain();
    const payment = (await f.read()).payments[0]!;
    expect((await post(`/api/billing/payments/${payment.id}/refunds`, { amountCents: 10000, currency: 'USD', reason: null })).status).toBe(403);
    await expect(f.service.getInvoice(foreign.gymId, invoice.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.manualPayment(foreign.context, invoice.id, { method: 'cash', amountCents: 10000,
      currency: 'USD', paidAt: f.clock.now().toISOString() })).rejects.toMatchObject({ code: 'not_found' });
    const otherHome = await f.factory('households', f.gymId);
    await expect(f.links.create(f.context, { purpose: 'pay_invoice', householdId: otherHome.id, invoiceId: invoice.id,
      expiresAt: '2028-04-01T00:00:00Z' })).rejects.toMatchObject({ code: 'not_found' });
    const otherInvoice = await f.service.createOneOff(f.context, { source: 'custom', householdId: otherHome.id, dueOn: '2028-03-01',
      description: 'Other private lesson', amountCents: 2500, currency: 'USD' });
    const pay = await f.links.create(f.context, { purpose: 'pay_invoice', householdId: otherHome.id, invoiceId: otherInvoice.id,
      expiresAt: '2028-04-01T00:00:00Z' });
    await db.forHousehold({ kind: 'signed_link', gymId: f.gymId, linkId: pay.link.id, now: f.clock.now() }, async scope => {
      expect((await scope.invoices()).map(row => row.id)).toEqual([otherInvoice.id]);
      expect(await scope.invoice(invoice.id)).toEqual([]);
    });
    // Purpose check: an update-card link grants no invoice access, even for its own household.
    const link = await f.links.create(f.context, { purpose: 'update_card', householdId: otherHome.id, expiresAt: '2028-04-01T00:00:00Z' });
    await expect(db.forHousehold({ kind: 'signed_link', gymId: f.gymId, linkId: link.link.id, now: f.clock.now() },
      scope => scope.invoices())).rejects.toThrow('Payer access required');
    expect((await f.read()).payments).toHaveLength(1); expect((await f.read()).refunds).toEqual([]);
  });
});
