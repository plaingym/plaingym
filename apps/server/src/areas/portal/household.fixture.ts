// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import type { useTestDatabase } from '@plaingym/db/testing/database';
import type { createFactories } from '@plaingym/db/testing/factories';
import { createApp } from '../../core/app.js';
import type { Clock } from '@plaingym/shared';
import type { Principal } from '../../core/context.js';
import type { RouteRegistration } from '../../core/registry.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createPortalAuthorization } from './auth.permissions.js';

type Database = ReturnType<typeof useTestDatabase>;
type Factory = ReturnType<typeof createFactories>;
/**
 * One gym with a payer household (payer, child and an adult with their own member login) and a second household.
 * The adult login is the "adult non-payer" every portal route must restrict to their own data.
 */
export async function portalFixture(factory: Factory, gym: Record<string, unknown> = {}) {
  const gymId = uuidv7(); await factory('gyms', gymId, gym);
  const payerUser = await factory('authUser', gymId), adultUser = await factory('authUser', gymId), otherUser = await factory('authUser', gymId);
  const staffUser = await factory('authUser', gymId);
  const household = await factory('households', gymId, { name: 'Rivera household', email: 'payer@example.test', stripeCustomerId: 'cus_' + uuidv7() });
  const payer = await factory('members', gymId, { householdId: household.id, firstName: 'Pat', lastName: 'Rivera', dateOfBirth: '1980-04-02' });
  const child = await factory('members', gymId, { householdId: household.id, firstName: 'Kim', lastName: 'Rivera', dateOfBirth: '2016-06-01',
    emergencyContacts: [{ name: 'Grandparent', relationship: null, phone: '555-0100', email: null }] });
  const adult = await factory('members', gymId, { householdId: household.id, firstName: 'Alex', lastName: 'Rivera', dateOfBirth: '1990-01-01' });
  const otherHousehold = await factory('households', gymId, { name: 'Other household' });
  const outsider = await factory('members', gymId, { householdId: otherHousehold.id, firstName: 'Out', lastName: 'Sider', dateOfBirth: '2015-01-01' });
  await factory('householdUsers', gymId, { householdId: household.id, userId: payerUser.id, memberId: payer.id, scope: 'payer' });
  await factory('householdUsers', gymId, { householdId: household.id, userId: adultUser.id, memberId: adult.id, scope: 'member' });
  await factory('householdUsers', gymId, { householdId: otherHousehold.id, userId: otherUser.id, memberId: outsider.id, scope: 'payer' });
  return { gymId, household, otherHousehold, payer, child, adult, outsider, payerUser, adultUser, otherUser, staffUser };
}
export type PortalFixture = Awaited<ReturnType<typeof portalFixture>>;
export const payerPrincipal = (f: PortalFixture): Principal => ({ kind: 'member', userId: f.payerUser.id,
  scope: { gymId: f.gymId, householdId: f.household.id, memberId: f.payer.id, role: 'payer' } });
export const adultPrincipal = (f: PortalFixture): Principal => ({ kind: 'member', userId: f.adultUser.id,
  scope: { gymId: f.gymId, householdId: f.household.id, memberId: f.adult.id, role: 'member' } });
export const otherPayerPrincipal = (f: PortalFixture): Principal => ({ kind: 'member', userId: f.otherUser.id,
  scope: { gymId: f.gymId, householdId: f.otherHousehold.id, memberId: f.outsider.id, role: 'payer' } });
export const outsidePrincipals = (f: PortalFixture): Principal[] => [{ kind: 'anonymous' },
  { kind: 'staff', gymId: f.gymId, userId: f.staffUser.id, roles: ['owner'] }, { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }];

/**
 * Links the payer's login to the second household as well, as its payer, and returns a principal for each: one login whose
 * session can have either household open. A portal answer must name the one the session has open.
 */
export async function bothHouseholds(factory: Factory, f: PortalFixture) {
  await factory('householdUsers', f.gymId, { householdId: f.otherHousehold.id, userId: f.payerUser.id, memberId: null, scope: 'payer' });
  const other: Principal = { kind: 'member', userId: f.payerUser.id, scope: { gymId: f.gymId, householdId: f.otherHousehold.id, role: 'payer' } };
  return { home: payerPrincipal(f), other };
}
/** Reads a 200 answer and checks it names the household the session had open. */
export async function answerFor(response: Response, householdId: string, label = '') {
  if (response.status !== 200) throw new Error(`${label}: expected 200, got ${response.status}`);
  const body = await response.json() as { householdId?: unknown };
  if (body.householdId !== householdId) throw new Error(`${label}: answered for ${String(body.householdId)}, not ${householdId}`);
  return body;
}
/** Mounts routes the way the runtime does: the gym from the request, the principal from the session, portal authorization. */
export function portalApp(db: Database, f: PortalFixture, principal: Principal, routes: readonly RouteRegistration[], clock: Clock) {
  return rememberPortalApp(createApp({ clock, skipSetup: true, origin: 'http://localhost', contributions: { routes },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); },
    authorize: createPortalAuthorization(createMemberHouseholdContext(db.forGym)),
  }), principal);
}
type App = ReturnType<typeof createApp>;
const expectedHouseholds = new WeakMap<App, string>();
/** The fixture's page names the household it opened, just like the browser. */
export function rememberPortalApp(app: App, principal: Principal): App {
  if (principal.kind === 'member') expectedHouseholds.set(app, principal.scope.householdId);
  return app;
}
export const portalTestHeaders = (app: App) => ({ 'X-Portal-Household': expectedHouseholds.get(app) ?? '' });
export const send = (server: App, method: string, path: string, body?: unknown) => server.request(path, { method,
  headers: { 'content-type': 'application/json', origin: 'http://localhost', ...portalTestHeaders(server) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
