// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { billingContracts } from '@plaingym/shared/contracts';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import { TestClock } from '../../core/clock.js';
import { authorize } from '../staff/auth.permissions.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createCatalogService } from './catalog.js';
import { createCatalogRoutes } from './catalog.routes.js';
import { createMembershipService } from './memberships.js';
import { createMembershipRoutes } from './memberships.routes.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2028-01-15T12:00:00Z');
const operations = ['listTaxRates', 'getTaxRate', 'createTaxRate', 'updateTaxRate', 'listPlans', 'getPlan', 'createPlan', 'updatePlan',
  'listChargeTypes', 'getChargeType', 'createChargeType', 'updateChargeType', 'listMemberships', 'getMembership', 'assignMembership',
  'updateMembership', 'activateMembership', 'freezeMembership', 'resumeMembership', 'cancelMembership'] as const;
type Operation = typeof operations[number];
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId, { currency: 'CAD' });
  const user = await factory('authUser', gymId), home = await factory('households', gymId, { billingDay: 31 });
  const member = await factory('members', gymId, { householdId: home.id }), plan = await factory('plans', gymId);
  const tax = await factory('taxRates', gymId), charge = await factory('chargeTypes', gymId);
  const base = { householdId: home.id, memberId: member.id, planId: plan.id, startsOn: '2028-01-31', nextDueOn: '2028-01-31' };
  const pending = await factory('memberships', gymId, { ...base, status: 'pending' });
  const active = await factory('memberships', gymId, { ...base, status: 'active' });
  const frozen = await factory('memberships', gymId, { ...base, status: 'frozen', nextDueOn: '2028-02-29', frozenAt: clock.now() });
  const options = { scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) };
  return { gymId, user, home, member, plan, tax, charge, pending, active, frozen,
    catalog: createCatalogService(options), memberships: createMembershipService(options) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function server(f: Fixture, principal: Principal) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (ctx, next) => {
    ctx.set('context', { gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() }, principal, clock, requestId: 'billing-test' });
    await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: [...createCatalogRoutes(f.catalog), ...createMembershipRoutes(f.memberships)] }).mount(app, authorize, new Set());
  return app;
}
function request(app: ReturnType<typeof server>, name: Operation, f: Fixture, override?: unknown) {
  const contract = billingContracts[name];
  const membershipId = name === 'freezeMembership' ? f.active.id : name === 'resumeMembership' ? f.frozen.id : f.pending.id;
  const path = contract.path.replace('{taxRateId}', f.tax.id).replace('{planId}', f.plan.id).replace('{chargeTypeId}', f.charge.id).replace('{membershipId}', membershipId);
  const bodies: Partial<Record<Operation, unknown>> = {
    createTaxRate: { name: 'Tax', rateMillionths: 50_000, inclusive: false }, updateTaxRate: { revision: 1, name: 'Updated' },
    createPlan: { name: 'Plan', amountCents: 100, currency: 'CAD', interval: 'monthly', taxRateIds: [f.tax.id] }, updatePlan: { revision: 1, name: 'Updated' },
    createChargeType: { name: 'Charge', amountCents: 100, currency: 'CAD', taxRateIds: [f.tax.id] }, updateChargeType: { revision: 1, name: 'Updated' },
    assignMembership: { householdId: f.home.id, memberId: f.member.id, planId: f.plan.id, startsOn: '2028-01-31', nextDueOn: '2028-01-31' },
    updateMembership: { revision: 1, nextDueOn: '2028-02-29' }, activateMembership: { revision: 1 },
    freezeMembership: { revision: 1, resumesOn: null }, resumeMembership: { revision: 1, nextDueOn: '2028-02-29' }, cancelMembership: { revision: 1 },
  };
  // A GET request can't carry a body.
  const body = contract.method === 'get' ? undefined : override ?? bodies[name];
  return app.request(path + (name === 'listMemberships' ? '?memberId=' + f.member.id : ''), { method: contract.method.toUpperCase(),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
}
const staff = (f: Fixture, role: StaffRole): Principal => ({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role] });
describe('all billing catalog and membership routes', () => {
  for (const operation of operations) {
    for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) {
      it(operation + ' declares and enforces access for ' + role, async () => {
        const f = await fixture(), contract = billingContracts[operation];
        const response = await request(server(f, staff(f, role)), operation, f);
        const allowed = canStaff([role], contract.permission.capability);
        expect(response.status, await response.clone().text()).toBe(allowed ? contract.successStatus : 403);
        if (allowed) { const data = await response.json(); expect(() => contract.response.parse(data)).not.toThrow(); }
      });
    }
    it(operation + ' denies anonymous and kiosk access before validation', async () => {
      const f = await fixture();
      for (const [principal, status] of [[{ kind: 'anonymous' }, 401], [{ kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }, 403]] as const) {
        const response = await request(server(f, principal), operation, f, { invalid: 'body' });
        expect(response.status).toBe(status);
      }
    });
  }
  let own: Fixture, other: Fixture;
  beforeAll(async () => { own = await fixture(); other = await fixture(); });
  for (const operation of operations.filter(name => name.startsWith('get') || name.startsWith('update') || name.endsWith('Membership') && name !== 'assignMembership')) {
    it(operation + ' returns 404 for a different gym resource', async () => {
      expect((await request(server(own, staff(own, 'owner')), operation, other)).status).toBe(404);
    });
  }
  it('does not leak a different gym through list filters or catalog results', async () => {
    const app = server(own, staff(own, 'owner'));
    for (const name of ['listPlans', 'listTaxRates', 'listChargeTypes'] as const) {
      const response = await request(app, name, own), parsed = billingContracts[name].response.parse(await response.json());
      const foreign = [other.plan.id, other.tax.id, other.charge.id];
      expect(parsed.data.every(row => !foreign.includes(row.id))).toBe(true);
    }
    expect((await app.request('/api/billing/memberships?householdId=' + other.home.id)).status).toBe(404);
    expect((await app.request('/api/billing/memberships?memberId=' + other.member.id)).status).toBe(404);
  });
  for (const operation of ['createPlan', 'createChargeType', 'assignMembership'] as const) {
    it(operation + ' rejects references to a different gym', async () => {
      expect((await request(server(own, staff(own, 'owner')), operation, other)).status).toBe(404);
    });
  }
  it('maps stale catalog and membership revisions to 409 and uses private responses', async () => {
    const f = await fixture(), app = server(f, staff(f, 'owner'));
    for (const operation of ['updatePlan', 'updateTaxRate', 'updateChargeType', 'updateMembership'] as const) {
      const response = await request(app, operation, f);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect((await request(app, operation, f)).status).toBe(409);
    }
  });
});
