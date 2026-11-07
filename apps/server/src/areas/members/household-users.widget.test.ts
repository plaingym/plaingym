// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, householdUsers, households, members, uuidv7, writeAudit } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- The scale test writes a thousand invitees and their invitations in one statement each.
import { authUser, authVerification } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles } from '@plaingym/shared';
import { matDashboardResponseSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { FakeEmail } from '../../infra/email/index.js';
import { authConfig } from '../../infra/auth/config.js';
import { createPortalInvitationStore } from '../../infra/auth/portal-invitations.js';
import type { Principal } from '../../core/context.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createApp } from '../../app.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import { configureDashboard } from '../dashboard/dashboard.routes.js';
import { createNotSeenRead } from '../dashboard/not-seen.js';
import { createPromotionCriteria } from '../ranks/criteria.js';
import { createRanksService } from '../ranks/ranks.service.js';
import { authorize } from '../staff/auth.permissions.js';
import { createMembersService } from './members.js';
import { confirmationRequested, requestPortalConfirmation } from './household-users.js';
import { createPortalInvitationService } from './household-users.invitations.js';
import { createPortalConfirmationWidgetProvider, portalConfirmationWidgetId } from './household-users.widget.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-30T12:00:00Z');
const store = createPortalInvitationStore(() => database.system.db);
const provider = () => createPortalConfirmationWidgetProvider({ scope: database.forGym, invitations: store });
const invitations = createPortalInvitationService({ config: authConfig({ AUTH_SECRET: 'widget-test-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' }, false),
  database: () => database.system.db, smtpConfigured: async () => false, mailer: async () => new FakeEmail(), loginLink: async () => undefined,
  scope: database.forGym, householdScope: database.forHousehold });
const href = (memberId: string) => `/admin/members/${memberId}#memberTabs.portal-access`;

async function gym() {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  return gymId;
}
/** A household whose password-mode join awaits staff confirmation, with its first member. */
async function waiting(gymId: string, name: string, overrides: { email?: string | null } = {}) {
  const home = await factory('households', gymId, { name, email: 'email' in overrides ? overrides.email : `${uuidv7()}@example.invalid` });
  const member = await factory('members', gymId, { householdId: home.id });
  await database.forGym(gymId, (tx) => requestPortalConfirmation(tx, gymId, home.id, clock));
  return { home, member };
}
const read = (gymId: string, roles: readonly (typeof staffRoles)[number][] = ['owner']) => provider().read({ gymId, roles, clock });

describe('portal confirmation widget', () => {
  it('lists households awaiting confirmation with a link to each one\'s Portal access tab, and nothing when none wait', async () => {
    const gymId = await gym();
    expect(await read(gymId)).toBeNull();
    const b = await waiting(gymId, 'Brown household'), a = await waiting(gymId, 'Adams household');
    // A second, later member never changes the link: it opens the household's first member.
    await factory('members', gymId, { householdId: a.home.id });
    expect(await read(gymId)).toEqual({ id: portalConfirmationWidgetId, titleKey: 'portal/access:waitingTitle', status: 'ready', kind: 'count', count: 2,
      items: [{ label: 'Adams household', href: href(a.member.id) }, { label: 'Brown household', href: href(b.member.id) }] });
  });

  it('stops listing a household once it has a payer login; a member-only login or an invitation audit alone keeps it waiting', async () => {
    const gymId = await gym(), joined = await waiting(gymId, 'Joined household');
    await factory('householdUsers', gymId, { householdId: joined.home.id, scope: 'member', memberId: joined.member.id });
    await database.forGym(gymId, (tx) => writeAudit(tx, { gymId, actorKind: 'system', action: 'household_user.invited', targetType: 'household', targetId: joined.home.id, occurredAt: clock.now() }));
    expect(await read(gymId)).toHaveProperty('count', 1);
    const payer = await factory('householdUsers', gymId, { householdId: joined.home.id, scope: 'payer', memberId: null });
    expect(await read(gymId)).toBeNull();
    // Revoking the payer login offers confirmation again, as the household's Portal access tab does.
    await database.forGym(gymId, (tx) => tx.delete(householdUsers).where(eq(householdUsers.id, payer.id)));
    expect(await read(gymId)).toHaveProperty('count', 1);
  });

  it('leaves a household out while its payer invitation is outstanding, and lists it again after a revoke or expiry', async () => {
    const gymId = await gym(), other = await gym(), owner = await factory('staffRoles', gymId, { role: 'owner' });
    const theirOwner = await factory('staffRoles', other, { role: 'owner' }), origin = 'https://gym.example.test';
    const actor = { gymId, userId: owner.userId, clock }, printed = { scope: 'payer' as const, delivery: 'print' as const };
    const invited = await waiting(gymId, 'Invited household'), adult = await waiting(gymId, 'Adult household');
    const adultMember = await factory('members', gymId, { householdId: adult.home.id, dateOfBirth: '1990-01-01' });
    // Another gym's household with the same kind of invitation never changes this gym's widget.
    const theirs = await waiting(other, 'Their household');
    await invitations.invite({ gymId: other, userId: theirOwner.userId, clock }, theirs.home.id, { ...printed, email: `${uuidv7()}@example.test` }, origin);
    expect(await read(other)).toBeNull();
    expect(await read(gymId)).toMatchObject({ count: 2 });
    await invitations.invite(actor, invited.home.id, { ...printed, email: `${uuidv7()}@example.test` }, origin);
    // A member-scope invitation leaves the household waiting: it never makes a payer login.
    await invitations.invite(actor, adult.home.id, { scope: 'member', memberId: adultMember.id, delivery: 'print', email: `${uuidv7()}@example.test` }, origin);
    expect(await read(gymId)).toMatchObject({ count: 1, items: [{ label: 'Adult household' }] });
    const [row] = (await invitations.outstanding(actor, invited.home.id)).data;
    await invitations.revokeInvitation(actor, invited.home.id, row!.id);
    expect(await read(gymId)).toMatchObject({ count: 2 });
    await invitations.invite(actor, invited.home.id, { ...printed, email: `${uuidv7()}@example.test` }, origin);
    expect(await read(gymId)).toMatchObject({ count: 1 });
    const expired = new TestClock('2026-11-06T12:00:01Z');
    expect(await provider().read({ gymId, roles: ['owner'], clock: expired })).toMatchObject({ count: 2 });
    expect(await provider().read({ gymId: other, roles: ['owner'], clock: expired })).toMatchObject({ count: 1, items: [{ label: 'Their household' }] });
  });

  it('leaves out a thousand payer-invited households in one statement, never sending their list back', async () => {
    const gymId = await gym(), size = 1000;
    const homes = Array.from({ length: size + 2 }, (_, index) => ({ id: uuidv7(), gymId, name: `Household ${String(index).padStart(4, '0')}`,
      email: `${uuidv7()}@example.invalid` }));
    const people = homes.map(home => ({ id: uuidv7(), gymId, householdId: home.id, firstName: 'Test', lastName: 'Member' }));
    await database.forGym(gymId, async tx => {
      await tx.insert(households).values(homes);
      await tx.insert(members).values(people);
      await tx.insert(auditEvents).values(homes.map(home => ({ gymId, actorKind: 'system', action: confirmationRequested,
        targetType: 'household', targetId: home.id, occurredAt: clock.now() })));
    });
    const invitees = homes.slice(0, size).map(() => ({ id: uuidv7(), name: 'Invitee', email: `${uuidv7()}@example.test` }));
    await database.system.db.insert(authUser).values(invitees);
    // The rows `issue` writes, in one statement.
    const bindings = invitees.map((invitee, index) => ({ userId: invitee.id, householdId: homes[index]!.id, scope: 'payer' as const, memberId: null }));
    await database.system.db.insert(authVerification).values(bindings.map(binding => ({ value: JSON.stringify(binding),
      identifier: `portal-invitation:${gymId}:${'a'.repeat(32)}${uuidv7().replaceAll('-', '')}`, expiresAt: new Date('2026-11-06T12:00:00Z'),
      gymId, householdId: binding.householdId, userId: binding.userId, scope: binding.scope })));
    // The real writer replaces the first one with a row of the same shape.
    await store.withPayerInvitations(gymId, clock, tx => store.issue(tx, gymId, bindings[0]!, clock));
    expect(await database.system.db.select().from(authVerification).where(eq(authVerification.userId, bindings[0]!.userId))).toMatchObject([{
      value: JSON.stringify(bindings[0]), gymId, householdId: bindings[0]!.householdId, userId: bindings[0]!.userId, scope: 'payer' }]);
    const statements = { auth: [] as { text: string; parameters: unknown[] }[], app: [] as { text: string; parameters: unknown[] }[] };
    database.system.sql.options.debug = (_connection, text, parameters) => { statements.auth.push({ text, parameters }); };
    database.app.sql.options.debug = (_connection, text, parameters) => { statements.app.push({ text, parameters }); };
    let widget;
    try { widget = await read(gymId); } finally { database.system.sql.options.debug = false; database.app.sql.options.debug = false; }
    expect(widget).toMatchObject({ count: 2, items: [{ label: 'Household 1000', href: href(people[size]!.id) }, { label: 'Household 1001', href: href(people[size + 1]!.id) }] });
    const queries = (pool: { text: string; parameters: unknown[] }[]) => pool.filter(entry => !/^(begin|commit|rollback)/i.test(entry.text));
    // On the authentication pool, the gym and the shortlist with its count; on the app pool, the gym and the listed households' members.
    expect(queries(statements.auth)).toHaveLength(2);
    expect(queries(statements.auth).filter(entry => entry.text.includes('"auth_verification"'))).toHaveLength(1);
    expect(queries(statements.app)).toHaveLength(2);
    // A fixed handful of parameters each, never one per invited household.
    for (const entry of [...queries(statements.auth), ...queries(statements.app)]) expect(entry.parameters.length).toBeLessThan(50);
  });

  it('skips households without an address or a member to open, and households that never asked for confirmation', async () => {
    const gymId = await gym();
    await waiting(gymId, 'Erased household', { email: null });
    const anonymized = await waiting(gymId, 'Anonymized household');
    await database.forGym(gymId, (tx) => tx.update(members).set({ anonymizedAt: clock.now() }).where(eq(members.id, anonymized.member.id)));
    const plain = await factory('households', gymId, { email: 'plain@example.invalid' });
    await factory('members', gymId, { householdId: plain.id });
    const visible = await waiting(gymId, 'Visible household');
    expect(await read(gymId)).toMatchObject({ count: 1, items: [{ label: 'Visible household', href: href(visible.member.id) }] });
  });

  it('caps the shortlist at twenty and still counts every household', async () => {
    const gymId = await gym();
    for (let index = 0; index < 22; index++) await waiting(gymId, `Household ${String(index).padStart(2, '0')}`);
    const widget = await read(gymId);
    expect(widget).toHaveProperty('count', 22);
    expect(widget?.items).toHaveLength(20);
    expect(widget?.items?.[0]?.label).toBe('Household 00');
    expect(provider().schema.parse(widget)).toEqual(widget);
  });

  it('counts only its own gym and shows it only to staff with portal access', async () => {
    const gymId = await gym(), other = await gym();
    await waiting(gymId, 'Mine');
    await waiting(other, 'Theirs'); await waiting(other, 'Theirs too');
    expect(await read(gymId)).toMatchObject({ count: 1, items: [{ label: 'Mine' }] });
    expect(await read(other)).toHaveProperty('count', 2);
    for (const role of staffRoles) {
      if (role === 'coach') await expect(read(gymId, [role])).rejects.toMatchObject({ code: 'forbidden' });
      else await expect(read(gymId, [role])).resolves.toHaveProperty('count', 1);
    }
    expect(await database.forGym(gymId, (tx) => tx.select({ id: households.id }).from(households))).toHaveLength(1);
  });

  it('reaches the dashboard through createApp for staff with portal access only, and carries no email address', async () => {
    const gymId = await gym(), foreign = await gym(), joined = await waiting(gymId, 'Joined household');
    await waiting(foreign, 'Foreign household');
    const widget = provider(), spy = vi.spyOn(widget, 'read');
    const attendance = createAttendanceQueries({ scope: database.forGym, clock });
    configureDashboard({ notSeen: createNotSeenRead(database.forGym), members: createMembersService({ scope: database.forGym, clock }),
      ranks: createRanksService({ scope: database.forGym, clock, criteria: createPromotionCriteria(attendance) }), attendance }, [widget]);
    const user = await factory('authUser', gymId);
    let principal: Principal = { kind: 'anonymous' };
    const app = createApp({ contributions: areaContributions, clock, authorize, setupToken: 'test-setup-token',
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); } });
    for (const role of staffRoles) {
      spy.mockClear(); principal = { kind: 'staff', gymId, userId: user.id, roles: [role] };
      const response = await app.request('/api/dashboard');
      expect(response.status).toBe(200);
      const text = await response.text(), { data } = matDashboardResponseSchema.parse(JSON.parse(text));
      const found = data.widgets.find((entry) => entry.id === portalConfirmationWidgetId);
      if (role === 'coach') { expect(found).toBeUndefined(); expect(spy).not.toHaveBeenCalled(); }
      else expect(found).toMatchObject({ count: 1, items: [{ label: 'Joined household', href: href(joined.member.id) }] });
      expect(text).not.toContain('example.invalid');
    }
  });
});
