// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
/** A household with an address and its first member, which hasn't asked for confirmation yet. */
async function unrequested(gymId: string, name: string, overrides: { email?: string | null } = {}) {
  const home = await factory('households', gymId, { name, email: 'email' in overrides ? overrides.email : `${uuidv7()}@example.invalid` });
  const member = await factory('members', gymId, { householdId: home.id });
  return { home, member };
}
/** A household whose password-mode join awaits staff confirmation, with its first member. */
async function waiting(gymId: string, name: string, overrides: { email?: string | null } = {}) {
  const created = await unrequested(gymId, name, overrides);
  await database.forGym(gymId, (tx) => requestPortalConfirmation(tx, gymId, created.home.id, clock));
  return created;
}
const requests = (gymId: string, householdId: string) => database.forGym(gymId, (tx) => tx.select({ id: auditEvents.id }).from(auditEvents)
  .where(and(eq(auditEvents.action, confirmationRequested), eq(auditEvents.targetType, 'household'), eq(auditEvents.targetId, householdId))));
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

  it('lists a household again when a confirmation request follows its payer invitation, until staff invite after it', async () => {
    const gymId = await gym(), other = await gym(), origin = 'https://gym.example.test';
    const owner = await factory('staffRoles', gymId, { role: 'owner' }), theirOwner = await factory('staffRoles', other, { role: 'owner' });
    const at = (time: string) => new TestClock(`2026-10-30T${time}:00Z`), printed = { scope: 'payer' as const, delivery: 'print' as const };
    const readAt = (id: string, time: string) => provider().read({ gymId: id, roles: ['owner'], clock: at(time) });
    const retried = await unrequested(gymId, 'Retried household');
    // Another gym's household, invited before its request, is listed there once it asks and never counts here.
    const theirs = await unrequested(other, 'Their household');
    await invitations.invite({ gymId: other, userId: theirOwner.userId, clock: at('12:00') }, theirs.home.id, { ...printed, email: `${uuidv7()}@example.test` }, origin);
    // Staff invite before the household's first request (while its join's invoice was unpaid, say).
    await invitations.invite({ gymId, userId: owner.userId, clock: at('12:00') }, retried.home.id, { ...printed, email: `${uuidv7()}@example.test` }, origin);
    expect(await readAt(gymId, '12:00')).toBeNull();
    // Its first request, later than that invitation, lists it despite the invitation.
    expect(await database.forGym(gymId, (tx) => requestPortalConfirmation(tx, gymId, retried.home.id, at('12:01')))).toBe(true);
    expect(await readAt(gymId, '12:02')).toEqual({ id: portalConfirmationWidgetId, titleKey: 'portal/access:waitingTitle', status: 'ready', kind: 'count', count: 1,
      items: [{ label: 'Retried household', href: href(retried.member.id) }] });
    expect(await readAt(other, '12:02')).toBeNull();
    // Staff inviting after the request take it off the list again.
    await invitations.invite({ gymId, userId: owner.userId, clock: at('12:03') }, retried.home.id, { ...printed, email: `${uuidv7()}@example.test` }, origin);
    expect(await readAt(gymId, '12:04')).toBeNull();
    // Another gym's later request, even one naming this household, never brings it back.
    expect(await database.forGym(other, (tx) => requestPortalConfirmation(tx, other, theirs.home.id, at('12:05')))).toBe(true);
    await database.forGym(other, (tx) => requestPortalConfirmation(tx, other, retried.home.id, at('12:05')));
    expect(await readAt(gymId, '12:06')).toBeNull();
    expect(await readAt(other, '12:06')).toMatchObject({ count: 1, items: [{ label: 'Their household' }] });
  });

  it('writes no second request for a household already awaiting confirmation, so a retry after staff invited it leaves it out', async () => {
    const gymId = await gym(), origin = 'https://gym.example.test', owner = await factory('staffRoles', gymId, { role: 'owner' });
    const at = (time: string) => new TestClock(`2026-10-30T${time}:00Z`);
    const retried = await waiting(gymId, 'Retried household');
    await invitations.invite({ gymId, userId: owner.userId, clock: at('12:01') }, retried.home.id,
      { scope: 'payer', delivery: 'print', email: `${uuidv7()}@example.test` }, origin);
    // A sign-in retry asks again: its earlier request stands, so staff's invitation still counts.
    expect(await database.forGym(gymId, (tx) => requestPortalConfirmation(tx, gymId, retried.home.id, at('12:02')))).toBe(false);
    expect(await provider().read({ gymId, roles: ['owner'], clock: at('12:03') })).toBeNull();
    expect(await requests(gymId, retried.home.id)).toHaveLength(1);
  });

  it('writes a request once while the household awaits confirmation, and again once it has a payer login', async () => {
    const gymId = await gym(), other = await gym(), { home } = await unrequested(gymId, 'Asking household');
    // Another gym's request naming this household never makes it await confirmation here.
    expect(await database.forGym(other, (tx) => requestPortalConfirmation(tx, other, home.id, clock))).toBe(true);
    expect(await database.forGym(gymId, (tx) => requestPortalConfirmation(tx, gymId, home.id, clock))).toBe(true);
    expect(await requests(gymId, home.id)).toHaveLength(1);
    expect(await database.forGym(gymId, (tx) => requestPortalConfirmation(tx, gymId, home.id, clock))).toBe(false);
    expect(await requests(gymId, home.id)).toHaveLength(1);
    // With a payer login it no longer awaits confirmation, so a request is written.
    await factory('householdUsers', gymId, { householdId: home.id, scope: 'payer', memberId: null });
    expect(await database.forGym(gymId, (tx) => requestPortalConfirmation(tx, gymId, home.id, clock))).toBe(true);
    expect(await requests(gymId, home.id)).toHaveLength(2);
    expect(await requests(other, home.id)).toHaveLength(1);
  });

  describe('a sign-in invitation after the latest request', () => {
    const at = (time: string) => new TestClock(`2026-10-30T${time}:00Z`);
    /** A payer invitation issued at `time` as a join's sign-in job issues one: an invitee account, then the invitation row. */
    async function issueAt(gymId: string, householdId: string, time: string) {
      const userId = uuidv7();
      await database.system.db.insert(authUser).values({ id: userId, name: 'Invitee', email: `${uuidv7()}@example.test` });
      await store.withPayerInvitations(gymId, at(time), tx => store.issue(tx, gymId, { userId, householdId, scope: 'payer', memberId: null }, at(time)));
      return userId;
    }
    const invitedAudit = (gymId: string, householdId: string, time: string, actor: { actorKind: 'system' } | { actorKind: 'user'; actorUserId: string }) =>
      database.forGym(gymId, (tx) => writeAudit(tx, { gymId, ...actor, action: 'household_user.invited', targetType: 'household', targetId: householdId,
        occurredAt: at(time).now() }));
    const ask = (gymId: string, householdId: string, time: string) => database.forGym(gymId, (tx) => requestPortalConfirmation(tx, gymId, householdId, at(time)));
    const readAt = (gymId: string, time: string) => provider().read({ gymId, roles: ['owner'], clock: at(time) });

    it('writes a new request when the join issued it, so its unsent invitation no longer hides the household', async () => {
      const gymId = await gym(), { home, member } = await waiting(gymId, 'Retried household');
      await issueAt(gymId, home.id, '12:01');
      await invitedAudit(gymId, home.id, '12:01', { actorKind: 'system' });
      expect(await readAt(gymId, '12:01')).toBeNull();
      expect(await ask(gymId, home.id, '12:02')).toBe(true);
      expect(await requests(gymId, home.id)).toHaveLength(2);
      expect(await readAt(gymId, '12:03')).toEqual({ id: portalConfirmationWidgetId, titleKey: 'portal/access:waitingTitle', status: 'ready', kind: 'count', count: 1,
        items: [{ label: 'Retried household', href: href(member.id) }] });
    });

    it('writes none when staff issued it', async () => {
      const gymId = await gym(), owner = await factory('staffRoles', gymId, { role: 'owner' }), { home } = await waiting(gymId, 'Invited household');
      await issueAt(gymId, home.id, '12:01');
      await invitedAudit(gymId, home.id, '12:01', { actorKind: 'user', actorUserId: owner.userId });
      expect(await ask(gymId, home.id, '12:02')).toBe(false);
      expect(await requests(gymId, home.id)).toHaveLength(1);
      expect(await readAt(gymId, '12:03')).toBeNull();
    });

    it('writes none when staff invited after the join did, so the retry leaves the household out', async () => {
      const gymId = await gym(), owner = await factory('staffRoles', gymId, { role: 'owner' }), { home } = await waiting(gymId, 'Invited household');
      await issueAt(gymId, home.id, '12:01');
      await invitedAudit(gymId, home.id, '12:01', { actorKind: 'system' });
      await issueAt(gymId, home.id, '12:02');
      await invitedAudit(gymId, home.id, '12:02', { actorKind: 'user', actorUserId: owner.userId });
      expect(await ask(gymId, home.id, '12:03')).toBe(false);
      expect(await requests(gymId, home.id)).toHaveLength(1);
      expect(await readAt(gymId, '12:04')).toBeNull();
    });

    it('writes none for another gym\'s invitation audit naming the household', async () => {
      const gymId = await gym(), other = await gym(), { home } = await waiting(gymId, 'Retried household');
      await invitedAudit(other, home.id, '12:01', { actorKind: 'system' });
      expect(await ask(gymId, home.id, '12:02')).toBe(false);
      expect(await requests(gymId, home.id)).toHaveLength(1);
    });

    it('writes none for a join invitation before the latest request, or at the same instant', async () => {
      const gymId = await gym(), { home } = await waiting(gymId, 'Retried household');
      await invitedAudit(gymId, home.id, '11:59', { actorKind: 'system' });
      expect(await ask(gymId, home.id, '12:02')).toBe(false);
      // The request was written at 12:00; a join invitation audited then counts as earlier.
      await invitedAudit(gymId, home.id, '12:00', { actorKind: 'system' });
      expect(await ask(gymId, home.id, '12:02')).toBe(false);
      expect(await requests(gymId, home.id)).toHaveLength(1);
    });
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
      ranks: createRanksService({ scope: database.forGym, clock, criteria: createPromotionCriteria(attendance) }) }, [widget]);
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
