// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { forGym, householdUsers, staffRoles as staffRolesTable, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Initialize the real database pools for this isolated composition test.
import { closeDatabase, initializeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse } from '@plaingym/shared';
import { shellBootstrapResponseSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { createAuthService } from '../../infra/auth/service.js';
import { authConfig } from '../../infra/auth/config.js';
import { sessionMiddleware } from '../../infra/auth/middleware.js';
import { passwordAdapter } from '../../infra/auth/password.js';
import { authorize } from './auth.permissions.js';
import { createAuthBootstrapRoutes } from './auth.bootstrap.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-11-01T16:00:00Z');
const secret = 'bootstrap-identity-test-secret-at-least-32-characters';
const config = authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'on' }, false);
const password = 'identity-password-123';
let hash: string, address = 1;
beforeAll(async () => {
  await initializeDatabase(database.appUrl);
  vi.stubEnv('AUTH_SECRET', secret); vi.stubEnv('AUTH_PASSWORD_LOGIN', 'on'); vi.stubEnv('TENANCY', 'single');
  hash = await passwordAdapter.hash(password);
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

/** Two gyms and one login (named at gym B, as `multi` mode's first provisioning would) that signs in to both. */
async function fixture() {
  const gymId = uuidv7(), otherGymId = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGymId);
  const user = await factory('authUser', gymId, { name: 'Named At Another Gym', emailVerified: true });
  await factory('authAccount', gymId, { userId: user.id, accountId: user.id, password: hash });
  const origins = { [gymId]: `https://${gymId}.example.test`, [otherGymId]: `https://${otherGymId}.example.test` };
  const clientIp = `192.0.3.${address++}`;
  const newService = (tenancy: 'single' | 'multi') => createAuthService({ config: { ...config, tenancy }, database: () => database.system.db, sendMagicLink: async () => undefined });
  const service = newService('single'), services = { single: service, multi: newService('multi') };
  const signIn = async (gym: string) => {
    const response = await service.bind({ gymId: gym, origin: origins[gym]!, clientIp }).handler(new Request(new URL('/api/auth/sign-in/email', origins[gym]), {
      method: 'POST', headers: { origin: origins[gym]!, 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) }));
    expect(response.status).toBe(200);
    return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  };
  return { gymId, otherGymId, user, origins, clientIp, services, signIn };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Counts the tables the bootstrap reads, so a test can say how many queries one load runs. */
function counting(reads: unknown[]): typeof forGym {
  return (gymId, fn) => forGym(gymId, tx => fn(new Proxy(tx, {
    get(target, key) {
      if (key !== 'select') return Reflect.get(target, key) as unknown;
      return (...args: unknown[]) => {
        const builder = (target.select as (...selection: unknown[]) => object)(...args);
        return new Proxy(builder, { get(source, name) {
          const value = Reflect.get(source, name) as unknown;
          return name === 'from' ? (table: unknown) => { reads.push(table); return (value as (table: unknown) => unknown).call(source, table); } : value;
        } });
      };
    },
  })));
}
type Options = { tenancy: 'single' | 'multi'; principal?: (userId: string, gymId: string) => Principal; reads?: unknown[]; session?: boolean };
function routeApp(f: Fixture, { tenancy, principal, reads = [], session = true }: Options) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.onError((error, context) => context.json(errorResponse(error, 'test'), error instanceof AppError ? error.status : 500));
  const gymOf = (url: string) => Object.entries(f.origins).find(([, origin]) => new URL(url).origin === origin)![0];
  app.use('*', async (context, next) => {
    context.set('context', { requestId: 'test', gym: { gymId: gymOf(context.req.url), timezone: 'UTC', enabledModules: new Set() }, principal: { kind: 'anonymous' }, clock });
    await next();
  });
  const resolve = (context: Parameters<Parameters<typeof app.use>[1]>[0]) => ({ gymId: gymOf(context.req.url), origin: f.origins[gymOf(context.req.url)]!, clientIp: f.clientIp });
  if (session) app.use('*', sessionMiddleware({ auth: f.services[tenancy], resolve: context => resolve(context as never),
    ...(principal ? { principal: async (userId, context) => principal(userId, context.get('context').gym.gymId) } : {}) }));
  else app.use('*', async (context, next) => { // A principal with no request session behind it
    context.set('context', { ...context.get('context'), principal: { kind: 'staff', gymId: gymOf(context.req.url), userId: f.user.id, roles: ['coach'] } });
    await next();
  });
  for (const route of createAuthBootstrapRoutes({ scope: counting(reads), login: () => ({ password: true, magicLink: false }) })) route.mount(app, authorize);
  return app;
}
async function bootstrap(app: ReturnType<typeof routeApp>, f: Fixture, gymId: string, signedIn = true) {
  const cookie = signedIn ? await f.signIn(gymId) : '';
  const response = await app.request(f.origins[gymId] + '/api/auth/bootstrap', { headers: cookie ? { cookie } : {} });
  expect(response.status).toBe(200);
  return shellBootstrapResponseSchema.parse(await response.json()).data.session;
}
const memberOf = (gymId: string, householdId: string, memberId?: string) => (userId: string): Principal =>
  ({ kind: 'member', userId, scope: memberId ? { gymId, householdId, role: 'member', memberId } : { gymId, householdId, role: 'payer' } });

describe('bootstrap session identity', () => {
  it('names a staff login by its profile, with the roles the request already resolved', async () => {
    const f = await fixture();
    await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'coach' });
    const profile = await factory('staffProfiles', f.gymId, { userId: f.user.id, displayName: 'Coach Alpha' });
    expect(await bootstrap(routeApp(f, { tenancy: 'single' }), f, f.gymId)).toEqual({ userId: f.user.id, staffProfileId: profile.id, displayName: 'Coach Alpha', roles: ['coach'], member: false });
  });
  it('returns no profile for an unlinked coach and different profile IDs for one login in two gyms', async () => {
    const f = await fixture();
    await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'coach' });
    await factory('staffRoles', f.otherGymId, { userId: f.user.id, role: 'coach' });
    expect(await bootstrap(routeApp(f, { tenancy: 'single' }), f, f.gymId)).toMatchObject({ roles: ['coach'], staffProfileId: null });
    const first = await factory('staffProfiles', f.gymId, { userId: f.user.id });
    const second = await factory('staffProfiles', f.otherGymId, { userId: f.user.id });
    for (const tenancy of ['single', 'multi'] as const) {
      const app = routeApp(f, { tenancy });
      expect(await bootstrap(app, f, f.gymId)).toMatchObject({ staffProfileId: first.id });
      expect(await bootstrap(app, f, f.otherGymId)).toMatchObject({ staffProfileId: second.id });
    }
  });
  it('names a member login by the member it is linked to in the open household, and no other', async () => {
    const f = await fixture();
    const first = await factory('households', f.gymId), second = await factory('households', f.gymId);
    const mia = await factory('members', f.gymId, { householdId: first.id, firstName: 'Mia', lastName: 'First' });
    const noa = await factory('members', f.gymId, { householdId: second.id, firstName: 'Noa', lastName: 'Second' });
    await factory('householdUsers', f.gymId, { userId: f.user.id, householdId: first.id, memberId: mia.id, scope: 'member' });
    await factory('householdUsers', f.gymId, { userId: f.user.id, householdId: second.id, memberId: noa.id, scope: 'member' });
    expect(await bootstrap(routeApp(f, { tenancy: 'single', principal: memberOf(f.gymId, second.id, noa.id) }), f, f.gymId))
      .toEqual({ userId: f.user.id, staffProfileId: null, displayName: 'Noa Second', roles: [], member: true });
    expect(await bootstrap(routeApp(f, { tenancy: 'single', principal: memberOf(f.gymId, first.id, mia.id) }), f, f.gymId))
      .toMatchObject({ displayName: 'Mia First', roles: [], member: true });
  });
  it('knows a login in two gyms by each gym\'s own record', async () => {
    const f = await fixture();
    await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'owner' });
    await factory('staffProfiles', f.gymId, { userId: f.user.id, displayName: 'Owner Alpha' });
    const household = await factory('households', f.otherGymId);
    const member = await factory('members', f.otherGymId, { householdId: household.id, firstName: 'Bea', lastName: 'Beta' });
    await factory('householdUsers', f.otherGymId, { userId: f.user.id, householdId: household.id, memberId: member.id, scope: 'member' });
    for (const tenancy of ['single', 'multi'] as const) {
      const app = routeApp(f, { tenancy, principal: (userId, gymId) => gymId === f.gymId ? { kind: 'staff', gymId, userId, roles: ['owner'] } : memberOf(gymId, household.id, member.id)(userId) });
      expect(await bootstrap(app, f, f.gymId)).toMatchObject({ displayName: 'Owner Alpha', roles: ['owner'], member: false });
      expect(await bootstrap(app, f, f.otherGymId)).toMatchObject({ displayName: 'Bea Beta', roles: [], member: true });
    }
  });
  it('falls back to the login\'s own name in single mode, and to its address in multi mode, where another gym may have set the name', async () => {
    const f = await fixture();
    await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'front_desk' });
    expect(await bootstrap(routeApp(f, { tenancy: 'single' }), f, f.gymId)).toMatchObject({ displayName: 'Named At Another Gym' });
    expect(await bootstrap(routeApp(f, { tenancy: 'multi' }), f, f.gymId)).toMatchObject({ displayName: f.user.email });
    // An erased member never names the login, in either mode.
    const household = await factory('households', f.gymId);
    const erased = await factory('members', f.gymId, { householdId: household.id, firstName: 'Anonymized', lastName: 'Member', anonymizedAt: clock.now() });
    await factory('householdUsers', f.gymId, { userId: f.user.id, householdId: household.id, memberId: erased.id, scope: 'member' });
    expect(await bootstrap(routeApp(f, { tenancy: 'single' }), f, f.gymId)).toMatchObject({ displayName: 'Named At Another Gym', member: true });
    expect(await bootstrap(routeApp(f, { tenancy: 'multi' }), f, f.gymId)).toMatchObject({ displayName: f.user.email, member: true });
  });
  it('has no name, and never the user ID, for a principal without a request session', async () => {
    const f = await fixture();
    const session = await bootstrap(routeApp(f, { tenancy: 'single', session: false }), f, f.gymId, false);
    expect(session).toEqual({ userId: f.user.id, staffProfileId: null, displayName: null, roles: ['coach'], member: false });
    expect(await bootstrap(routeApp(f, { tenancy: 'multi', session: false }), f, f.gymId, false)).toMatchObject({ displayName: null });
  });
  it('runs one household query and no staff role query for a staff login and a member login', async () => {
    const f = await fixture();
    await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'admin' });
    const household = await factory('households', f.otherGymId);
    await factory('householdUsers', f.otherGymId, { userId: f.user.id, householdId: household.id, scope: 'payer', memberId: null });
    for (const [gymId, principal] of [[f.gymId, undefined], [f.otherGymId, memberOf(f.otherGymId, household.id)]] as const) {
      const reads: unknown[] = [];
      await bootstrap(routeApp(f, { tenancy: 'single', reads, ...(principal ? { principal } : {}) }), f, gymId);
      expect(reads.filter(table => table === householdUsers)).toHaveLength(1);
      expect(reads).not.toContain(staffRolesTable);
    }
  });
});
