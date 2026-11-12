// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { discountContracts } from '@plaingym/shared/contracts';
import type { StaffRole } from '@plaingym/shared';
import type { Principal, RequestEnvironment } from '../../../core/context.js';
import { createServerRegistry } from '../../../core/registry.js';
import { errorHandler } from '../../../core/errors.js';
import { TestClock } from '../../../core/clock.js';
import { authorize } from '../../staff/auth.permissions.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createDiscountCatalogService } from './catalog.js';
import { createDiscountCatalogRoutes } from './catalog.routes.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-12T12:00:00Z');
const operations = ['listDiscounts', 'getDiscount', 'createDiscount', 'updateDiscount'] as const;
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const user = await factory('authUser', gymId), discount = await factory('discounts', gymId), plan = await factory('plans', gymId);
  const service = createDiscountCatalogService({ scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) });
  return { gymId, user, discount, plan, service };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function server(f: Fixture, principal: Principal) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (ctx, next) => {
    ctx.set('context', { gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() }, principal, clock, requestId: 'discount-test' });
    await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createDiscountCatalogRoutes(f.service) }).mount(app, authorize, new Set());
  return app;
}
const staff = (f: Fixture, role: StaffRole): Principal => ({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role] });
function request(app: ReturnType<typeof server>, operation: typeof operations[number], f: Fixture, override?: unknown) {
  const contract = discountContracts[operation];
  const body = operation === 'createDiscount' ? { name: 'Family', percentBasisPoints: 1000, duration: 'once', currency: f.discount.currency, planIds: [f.plan.id] }
    : { revision: 1, name: 'Updated' };
  return app.request(contract.path.replace('{discountId}', f.discount.id), { method: contract.method.toUpperCase(),
    ...(contract.method === 'get' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(override ?? body) }) });
}
describe('discount catalog routes', () => {
  for (const operation of operations) {
    for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) it(operation + ' enforces ' + role, async () => {
      const f = await fixture(), response = await request(server(f, staff(f, role)), operation, f);
      const allowed = role === 'owner' || role === 'admin';
      expect(response.status, await response.clone().text()).toBe(allowed ? discountContracts[operation].successStatus : 403);
      if (allowed) {
        const awaitJson = await response.json();
        expect(() => discountContracts[operation].response.parse(awaitJson)).not.toThrow();
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      }
    });
    it(operation + ' denies anonymous, member and device identities before body validation', async () => {
      const f = await fixture();
      for (const [principal, status] of [
        [{ kind: 'anonymous' }, 401], [{ kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }, 403],
        [{ kind: 'member', userId: f.user.id, scope: { gymId: f.gymId, householdId: uuidv7(), role: 'payer' } }, 403],
      ] as const) expect((await request(server(f, principal), operation, f, { invalid: true })).status).toBe(status);
    });
    it(operation + ' isolates foreign gym resources and plan links', async () => {
      const f = await fixture(), other = await fixture(), app = server(f, staff(f, 'owner'));
      const response = await request(app, operation, other);
      if (operation === 'listDiscounts') {
        expect(response.status).toBe(200);
        expect((await response.json()).data.map((row: { id: string }) => row.id)).toEqual([f.discount.id]);
      } else expect(response.status).toBe(404);
    });
  }
  it('maps stale revisions, used terms and uniqueness to clear conflicts', async () => {
    const f = await fixture(), app = server(f, staff(f, 'admin'));
    expect((await request(app, 'updateDiscount', f, { revision: 1, active: false })).status).toBe(200);
    expect((await request(app, 'updateDiscount', f, { revision: 1, active: true })).status).toBe(409);
    await factory('membershipDiscounts', f.gymId, { discountId: f.discount.id });
    const terms = await request(app, 'updateDiscount', f, { revision: 2, percentBasisPoints: 2000 });
    expect(terms.status).toBe(409);
    expect(await terms.text()).toContain('has been used');
    expect((await request(app, 'updateDiscount', f, { revision: 2, name: 'Renamed' })).status).toBe(200);
    const duplicate = await request(app, 'createDiscount', f, { name: 'renamed', currency: 'USD', waivesSignupFee: true });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toContain('name or code');
  });
  it('rejects invalid merged terms, counters and foreign plans without changing revision', async () => {
    const f = await fixture(), other = await fixture(), app = server(f, staff(f, 'owner'));
    expect((await request(app, 'updateDiscount', f, { revision: 1, amountCents: 500 })).status).toBe(400);
    expect((await request(app, 'updateDiscount', f, { revision: 1, uses: 1 })).status).toBe(400);
    expect((await request(app, 'updateDiscount', f, { revision: 1, planIds: [other.plan.id] })).status).toBe(404);
    const response = await request(app, 'getDiscount', f);
    expect((await response.json()).data).toMatchObject({ revision: 1, uses: 0, planIds: [] });
  });
});
