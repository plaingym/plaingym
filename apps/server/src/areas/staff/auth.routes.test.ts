// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Registered-route test verifies password credentials and session side effects in real PostgreSQL.
import { authAccount, authSession, auditEvents, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Initialize the real registrations' database pools for this isolated composition test.
import { closeDatabase, initializeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { shellBootstrapResponseSchema } from '@plaingym/shared/contracts';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig, passwordLogin, type AuthConfig } from '../../infra/auth/config.js';
import { passwordAdapter } from '../../infra/auth/password.js';
import { authorize } from './auth.permissions.js';
import { configureStaffAuth } from './auth.routes.js';
import { configureLoginMethods } from './auth.bootstrap.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-27T00:30:00Z');
const config = authConfig({ AUTH_SECRET: 'staff-route-test-secret-at-least-32-characters' }, false);
const accounts = createAccountService(config, () => db.system.db);
beforeAll(() => initializeDatabase(db.appUrl));
afterAll(() => closeDatabase());
async function fixture(actorRole: StaffRole = 'admin', targetRole?: StaffRole) {
  const gymId = uuidv7();
  await factory('gyms', gymId, { timezone: 'America/Vancouver', currency: 'CAD' });
  const actor = await factory('staffRoles', gymId, { role: actorRole });
  const target = await factory('householdUsers', gymId);
  if (targetRole) await factory('staffRoles', gymId, { userId: target.userId, role: targetRole });
  const session = await factory('authSession', gymId, { userId: target.userId });
  return { gymId, actor, target, session, actorRole };
}
function app(f: Awaited<ReturnType<typeof fixture>>, smtp = false, mode: AuthConfig = config) {
  configureStaffAuth({ config: mode, accounts, smtpConfigured: async gymId => { expect(gymId).toBe(f.gymId); return smtp; } });
  configureLoginMethods(() => ({ password: passwordLogin(mode, smtp), magicLink: smtp }));
  return createApp({ clock, contributions: areaContributions, authorize, origin: 'http://localhost',
    resolveGym: async (c, next) => {
      c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'America/Vancouver', enabledModules: new Set() } }); await next();
    },
    session: async (c, next) => {
      c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId: f.gymId, userId: f.actor.userId, roles: [f.actorRole] } }); await next();
    },
  });
}
const post = (server: ReturnType<typeof app>, path: string, body: unknown) => server.request(path, {
  method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const resetPath = (userId: string) => '/api/staff/users/' + userId + '/reset-password';
const resetBody = { newPassword: 'replacement-password' };
async function snapshot(gymId: string, userId: string) {
  return { accounts: await db.system.db.select().from(authAccount).where(eq(authAccount.userId, userId)),
    sessions: await db.system.db.select().from(authSession).where(eq(authSession.userId, userId)),
    audits: await db.forGym(gymId, tx => tx.select().from(auditEvents)) };
}

describe('registered staff password reset', () => {
  it.each(staffRoles)('enforces %s permission for member resets through the production registrations', async role => {
    const f = await fixture(role), server = app(f);
    const allowed = role === 'owner' || role === 'admin';
    const response = await post(server, resetPath(f.target.userId), resetBody);
    expect(response.status).toBe(allowed ? 200 : 403);
    const state = await snapshot(f.gymId, f.target.userId);
    if (allowed) {
      expect(await passwordAdapter.verify({ hash: state.accounts[0]!.password!, password: resetBody.newPassword })).toBe(true);
      expect(state.sessions).toEqual([]);
      expect(state.audits).toEqual([expect.objectContaining({ action: 'auth.password_reset', actorUserId: f.actor.userId })]);
    } else { expect(state.accounts).toEqual([]); expect(state.sessions).toHaveLength(1); expect(state.audits).toEqual([]); }
  });
  it.each(staffRoles)('protects %s staff from front-desk resets', async targetRole => {
    const f = await fixture('front_desk', targetRole), server = app(f);
    const before = await snapshot(f.gymId, f.target.userId);
    expect((await post(server, resetPath(f.target.userId), resetBody)).status).toBe(403);
    expect(await snapshot(f.gymId, f.target.userId)).toEqual(before);
  });
  it.each(['auto', 'off', 'multi'] as const)('refuses a reset when per-gym password login is disabled: %s', async mode => {
    const f = await fixture();
    const policy: AuthConfig = { ...config, passwordMode: mode === 'auto' ? 'auto' : 'off', ...(mode === 'multi' ? { tenancy: 'multi' } : {}) };
    const server = app(f, mode === 'auto', policy), before = await snapshot(f.gymId, f.target.userId);
    expect((await post(server, resetPath(f.target.userId), resetBody)).status).toBe(403);
    expect(await snapshot(f.gymId, f.target.userId)).toEqual(before);
  });
  it('permits explicit password mode with per-gym SMTP', async () => {
    const f = await fixture(), server = app(f, true, { ...config, passwordMode: 'on' });
    expect((await post(server, resetPath(f.target.userId), resetBody)).status).toBe(200);
  });
  it('returns 404 for a target belonging only to another gym, without changing credentials or sessions', async () => {
    const f = await fixture(), other = await fixture(), server = app(f);
    const before = await snapshot(other.gymId, other.target.userId);
    expect((await post(server, resetPath(other.target.userId), resetBody)).status).toBe(404);
    expect(await snapshot(other.gymId, other.target.userId)).toEqual(before);
  });
});

it('lets front desk read bootstrap billing fields and plan names and create an invoice while settings stay restricted', async () => {
  const f = await fixture('front_desk'), other = await fixture(), server = app(f);
  const plan = await factory('plans', f.gymId, { name: 'Unlimited classes' });
  await factory('plans', other.gymId, { name: 'Private foreign plan' });
  const response = await server.request('/api/auth/bootstrap');
  expect(response.status).toBe(200);
  const bootstrap = shellBootstrapResponseSchema.parse(await response.json()).data;
  expect(bootstrap.gym).toEqual({ id: f.gymId, name: 'Test Gym', timezone: 'America/Vancouver', currency: 'CAD', enabledModules: [] });
  expect(bootstrap.session?.roles).toEqual(['front_desk']);
  expect((await server.request('/api/settings')).status).toBe(403);
  const plans = await server.request('/api/billing/plans');
  expect(plans.status).toBe(200);
  expect((await plans.json()).data).toEqual([expect.objectContaining({ id: plan.id, name: plan.name })]);
  const body = { source: 'custom', householdId: f.target.householdId, description: 'Equipment', amountCents: 1029, currency: bootstrap.gym.currency, dueOn: '2026-10-27', taxRateIds: [] };
  const created = await post(server, '/api/billing/invoices/one-off', body);
  expect(created.status).toBe(201);
  expect((await created.json()).data).toMatchObject({ householdId: f.target.householdId, amountCents: 1029, currency: 'CAD' });
  expect((await post(server, '/api/billing/invoices/one-off', { ...body, householdId: other.target.householdId })).status).toBe(404);
});
