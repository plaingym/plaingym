// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { uuidv7 } from '@plaingym/db';
import { createApp } from '../../../app.js';
import { authorize } from '../../staff/auth.permissions.js';
import { createMembershipRoutes } from '../memberships.routes.js';
import { dailyRunJob } from '../runner/index.js';
import { clearJobs, origin, workflowFixture } from './workflow-fixture.js';

const db = useTestDatabase();
beforeEach(() => clearJobs(db));

describe('plan switch now through the membership routes, the composed runner and synthetic Stripe', () => {
  it('charges an upgrade\'s prorated difference once, with the new plan\'s tax, and the next cycle bills the new price', async () => {
    const f = await workflowFixture(db);
    const tax = await f.factory('taxRates', f.gymId, { name: 'Sales tax', rateMillionths: 50_000, inclusive: false });
    const unlimited = await f.factory('plans', f.gymId, { name: 'Unlimited', amountCents: 15_000, currency: 'USD' });
    await f.factory('planTaxRates', f.gymId, { planId: unlimited.id, taxRateId: tax.id });
    await f.runJob(dailyRunJob);
    const app = createApp({ clock: f.clock, authorize, skipSetup: true,
      contributions: { routes: createMembershipRoutes(f.lifecycle, { assigned: f.runner.collectAssigned }) },
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: f.timezone, enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: ['admin'] } }); await next(); } });
    const call = async (path: string, body?: object) => {
      const response = await app.request(origin + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json() as { data: { invoiceId: string | null; membership: { planId: string }; proration: { totalCents: number } } }).data;
    };
    f.clock.set('2028-03-16T17:00:00Z');
    const membership = (await f.read()).memberships[0]!, path = `/api/billing/memberships/${membership.id}/switch`;
    const preview = await call(`${path}/preview?planId=${unlimited.id}&timing=now`);
    const request = { revision: membership.revision, requestId: uuidv7(), planId: unlimited.id, timing: 'now' };
    const switched = await call(path, request);
    // A retry replays: the same invoice, nothing issued or charged again.
    expect(await call(path, request)).toEqual(switched);
    await f.drain();
    let state = await f.read();
    // $50 more a month for 16 of March's 31 days, then 5% tax on it.
    expect(state.invoices.map(i => [i.dueOn, i.kind, i.status, i.amountCents])).toEqual([
      ['2028-03-01', 'cycle', 'paid', 10_000], ['2028-03-16', 'one_off', 'paid', 2_710]]);
    const upgrade = state.invoices[1]!;
    expect(upgrade.id).toBe(switched.invoiceId);
    expect(preview.proration.totalCents).toBe(upgrade.amountCents);
    expect(state.lines.filter(line => line.invoiceId === upgrade.id).map(line => [line.kind, line.planId, line.amountCents]).sort())
      .toEqual([['membership', unlimited.id, 2_581], ['tax', null, 129]]);
    expect(state.attempts.filter(attempt => attempt.invoiceId === upgrade.id)).toHaveLength(1);
    expect(state.payments.map(payment => payment.amountCents).sort((x, y) => x - y)).toEqual([2_710, 10_000]);
    expect(state.memberships[0]).toMatchObject({ status: 'active', planId: unlimited.id, amountCents: 15_000, nextDueOn: '2028-04-01' });
    f.clock.set('2028-04-01T17:00:00Z');
    await f.runJob(dailyRunJob); await f.runJob(dailyRunJob);
    state = await f.read();
    expect(state.invoices.map(i => [i.dueOn, i.kind, i.status, i.amountCents])).toEqual([
      ['2028-03-01', 'cycle', 'paid', 10_000], ['2028-03-16', 'one_off', 'paid', 2_710], ['2028-04-01', 'cycle', 'paid', 15_750]]);
    expect(state.payments).toHaveLength(3);
  });
});
