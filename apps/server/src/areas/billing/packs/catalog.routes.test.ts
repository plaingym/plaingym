// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { billingContracts } from '@plaingym/shared/contracts';
import type { StaffRole } from '@plaingym/shared';
import type { Principal, RequestEnvironment } from '../../../core/context.js';
import { createServerRegistry } from '../../../core/registry.js';
import { errorHandler } from '../../../core/errors.js';
import { TestClock } from '../../../core/clock.js';
import { authorize } from '../../staff/auth.permissions.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createPackCatalogService } from './catalog.js';
import { createPackCatalogRoutes } from './catalog.routes.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-10T12:00:00Z');
const operations = ['listClassPacks', 'getClassPack', 'createClassPack', 'updateClassPack'] as const;
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const user = await factory('authUser', gymId), pack = await factory('classPacks', gymId), tax = await factory('taxRates', gymId);
  const service = createPackCatalogService({ scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) });
  return { gymId, user, pack, tax, service };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function server(f: Fixture, principal: Principal) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (ctx, next) => {
    ctx.set('context', { gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() }, principal, clock, requestId: 'packs-test' });
    await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createPackCatalogRoutes(f.service) }).mount(app, authorize, new Set());
  return app;
}
const staff = (f: Fixture, role: StaffRole): Principal => ({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role] });
function request(app: ReturnType<typeof server>, operation: typeof operations[number], f: Fixture, override?: unknown) {
  const contract = billingContracts[operation];
  const body = operation === 'createClassPack' ? { name: 'Classes', amountCents: 100, currency: f.pack.currency, credits: 10, taxRateIds: [f.tax.id] }
    : { revision: 1, name: 'Updated' };
  return app.request(contract.path.replace('{packId}', f.pack.id), { method: contract.method.toUpperCase(),
    ...(contract.method === 'get' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(override ?? body) }) });
}
describe('pack catalog routes', () => {
  for (const operation of operations) {
    for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) it(operation + ' enforces ' + role, async () => {
      const f = await fixture(), response = await request(server(f, staff(f, role)), operation, f);
      const allowed = role === 'owner' || role === 'admin';
      expect(response.status, await response.clone().text()).toBe(allowed ? billingContracts[operation].successStatus : 403);
      if (allowed) {
        const awaitJson = await response.json();
        expect(() => billingContracts[operation].response.parse(awaitJson)).not.toThrow();
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
    it(operation + ' isolates foreign gym resources and links', async () => {
      const f = await fixture(), other = await fixture(), app = server(f, staff(f, 'owner'));
      const response = await request(app, operation, other);
      if (operation === 'listClassPacks') {
        expect(response.status).toBe(200);
        expect((await response.json()).data.map((row: { id: string }) => row.id)).toEqual([f.pack.id]);
      } else expect(response.status).toBe(404);
    });
  }
  it('maps stale revisions to 409 and archives/restores with revision checks', async () => {
    const f = await fixture(), app = server(f, staff(f, 'admin'));
    expect((await request(app, 'updateClassPack', f, { revision: 1, active: false })).status).toBe(200);
    expect((await request(app, 'updateClassPack', f, { revision: 1, active: true })).status).toBe(409);
    const restored = await request(app, 'updateClassPack', f, { revision: 2, active: true });
    expect(restored.status).toBe(200);
    expect((await restored.json()).data).toMatchObject({ active: true, revision: 3 });
  });
});
