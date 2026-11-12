// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { authAccount, authSession, authUser, authVerification, auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { TestClock } from '../../core/clock.js';
import { FakeEmail } from '../email/index.js';
import { assertOwnerRecovery } from '../../areas/staff/auth.reset.js';
import { createEmailChangeService, emailChangeLifetimeMs, maskAddress, type EmailChangeMail } from './email-change.js';

const db = useTestDatabase(), factory = createFactories(db), t = createTranslator(locales.en ?? {});
const service = (tenancy: 'single' | 'multi' = 'single', limit = { window: 3600, max: 100 }) =>
  createEmailChangeService({ config: { tenancy }, database: () => db.system.db, limit });
function mailer() {
  const email = new FakeEmail();
  const mail: EmailChangeMail = async () => ({ origin: 'https://gym.example.test', email, gymName: 'Test Gym', t });
  return { email, mail };
}
const tokenOf = (message: { text: string }) => new URL(/https?:\/\/\S+/.exec(message.text)![0]).hash.slice(1);
async function fixture() {
  const gymId = uuidv7(), otherGymId = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGymId);
  const role = await factory('staffRoles', gymId, { role: 'owner' });
  const [user] = await db.system.db.select().from(authUser).where(eq(authUser.id, role.userId));
  const current = await factory('authSession', gymId, { userId: role.userId });
  const other = await factory('authSession', gymId, { userId: role.userId });
  return { gymId, otherGymId, userId: role.userId, email: user!.email, current, other };
}
const sessionsOf = (userId: string) => db.system.db.select({ id: authSession.id }).from(authSession).where(eq(authSession.userId, userId));
const emailOf = async (userId: string) => (await db.system.db.select().from(authUser).where(eq(authUser.id, userId)))[0]!;
const audits = (gymId: string) => db.forGym(gymId, tx => tx.select().from(auditEvents));

describe('sign-in email change', () => {
  it('applies only when the link sent to the new address is opened, then notifies the old address', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    await factory('authAccount', f.gymId, { userId: f.userId, providerId: 'google', accountId: 'google-' + uuidv7() });
    const sent = await changes.request({ gymId: f.gymId, userId: f.userId, sessionId: f.current.id, newEmail: ' New.Owner@Example.test ', clock, mail });
    expect(sent).toMatchObject({ email: 'new.owner@example.test', from: f.email, expiresAt: new Date(clock.now().getTime() + emailChangeLifetimeMs).toISOString() });
    // Nothing changes on request: the login keeps its address, sessions and Google link.
    expect((await emailOf(f.userId)).email).toBe(f.email);
    expect(await sessionsOf(f.userId)).toHaveLength(2);
    expect(email.messages).toHaveLength(1);
    expect(email.messages[0]).toMatchObject({ to: 'new.owner@example.test', subject: expect.stringContaining('Test Gym') });
    const link = new URL(/https?:\/\/\S+/.exec(email.messages[0]!.text)![0]);
    expect(link.origin + link.pathname).toBe('https://gym.example.test/account-email');
    // The row holds a hash under the gym's prefix, never the token.
    const rows = await db.system.db.select().from(authVerification);
    expect(rows.some(row => row.identifier.includes(link.hash.slice(1)) || row.value.includes(link.hash.slice(1)))).toBe(false);
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ email: f.email, googleLinked: true, pendingEmail: { email: 'new.owner@example.test' } });

    const applied = await changes.confirm({ gymId: f.gymId, token: link.hash.slice(1), sessionUserId: null, clock, mail });
    expect(applied).toEqual({ userId: f.userId, from: f.email, to: 'new.owner@example.test', googleUnlinked: true });
    expect(await emailOf(f.userId)).toMatchObject({ email: 'new.owner@example.test', emailVerified: true });
    // The requesting session stays; every other session of the login in the gym ends.
    expect((await sessionsOf(f.userId)).map(row => row.id)).toEqual([f.current.id]);
    expect(await db.system.db.select().from(authAccount).where(and(eq(authAccount.userId, f.userId), eq(authAccount.providerId, 'google')))).toEqual([]);
    expect(email.messages[1]).toMatchObject({ to: f.email, subject: expect.stringContaining('was changed') });
    expect(email.messages[1]!.text).toContain(maskAddress('new.owner@example.test'));
    expect(email.messages[1]!.text).not.toContain('new.owner@example.test');
    expect((await audits(f.gymId)).filter(row => row.action.startsWith('auth.email_change')).sort((a, b) => a.action < b.action ? -1 : 1).map(row => ({ action: row.action, actor: row.actorUserId, after: row.after })))
      .toEqual([{ action: 'auth.email_change_requested', actor: f.userId, after: null },
        { action: 'auth.email_changed', actor: f.userId, after: { googleUnlinked: true, sessionsEnded: 1 } }]);
    // One use only.
    await expect(changes.confirm({ gymId: f.gymId, token: link.hash.slice(1), sessionUserId: null, clock })).rejects.toMatchObject({ code: 'not_found' });
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ email: 'new.owner@example.test', googleLinked: false, pendingEmail: null });
  });

  it('refuses an expired link, a link from another gym, and another login\'s session', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    await changes.request({ gymId: f.gymId, userId: f.userId, sessionId: f.current.id, newEmail: 'moved@example.test', clock, mail });
    const token = tokenOf(email.messages[0]!);
    // The token is looked up under the resolved gym's prefix: gym B never finds gym A's link.
    await expect(changes.confirm({ gymId: f.otherGymId, token, sessionUserId: null, clock })).rejects.toMatchObject({ code: 'not_found' });
    const stranger = await factory('householdUsers', f.gymId);
    await expect(changes.confirm({ gymId: f.gymId, token, sessionUserId: stranger.userId, clock })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(changes.confirm({ gymId: f.gymId, token: 'not-a-token', sessionUserId: null, clock })).rejects.toMatchObject({ code: 'not_found' });
    clock.advance(emailChangeLifetimeMs);
    await expect(changes.confirm({ gymId: f.gymId, token, sessionUserId: f.userId, clock })).rejects.toMatchObject({ code: 'not_found' });
    expect((await emailOf(f.userId)).email).toBe(f.email);
    expect(await sessionsOf(f.userId)).toHaveLength(2);
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ pendingEmail: null });
  });

  it('refuses an address another login uses, on request and when the link is opened', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    const member = await factory('householdUsers', f.gymId), memberEmail = (await emailOf(member.userId)).email;
    await expect(changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: memberEmail.toUpperCase(), clock, mail })).rejects.toMatchObject({ code: 'conflict' });
    await expect(changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: f.email, clock, mail })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(email.messages).toEqual([]);
    await changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'contested@example.test', clock, mail });
    // Another login takes the address before the link is opened.
    await factory('authUser', f.gymId, { email: 'contested@example.test' });
    await expect(changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[0]!), sessionUserId: null, clock })).rejects.toMatchObject({ code: 'conflict' });
    expect((await emailOf(f.userId)).email).toBe(f.email);
  });

  it('applies only one of two logins\' changes to the same address opened at once; the other is refused as in use', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    const member = await factory('householdUsers', f.gymId);
    await changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'race@example.test', clock, mail });
    await changes.request({ gymId: f.gymId, userId: member.userId, sessionId: null, newEmail: 'race@example.test', clock, mail });
    const results = await Promise.allSettled(email.messages.map(message => changes.confirm({ gymId: f.gymId, token: tokenOf(message), sessionUserId: null, clock })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason)).toEqual([expect.objectContaining({ code: 'conflict' })]);
    const winner = results[0]!.status === 'fulfilled' ? f.userId : member.userId;
    expect((await emailOf(winner)).email).toBe('race@example.test');
  });

  it('replaces an outstanding link when asked again, and withdraws a link whose email failed', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    await changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'first@example.test', clock, mail });
    await changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'second@example.test', clock, mail });
    await expect(changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[0]!), sessionUserId: null, clock })).rejects.toMatchObject({ code: 'not_found' });
    email.respondNext(new Error('smtp down'));
    await expect(changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'third@example.test', clock, mail })).rejects.toMatchObject({ code: 'unavailable' });
    // The failed request replaced the second link and was withdrawn itself, so nothing is pending.
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ pendingEmail: null });
  });

  it('limits change requests per login', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { mail } = mailer(), changes = service('single', { window: 3600, max: 2 });
    for (const address of ['a@example.test', 'b@example.test'])
      await changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: address, clock, mail });
    await expect(changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'c@example.test', clock, mail })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('is refused in multi tenancy, where a login\'s address belongs to every gym it is in', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service('multi');
    await expect(changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'multi@example.test', clock, mail })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(changes.changeByOperator({ gymId: f.gymId, from: f.email, to: 'multi@example.test', clock, authorize: async () => undefined })).rejects.toMatchObject({ code: 'forbidden' });
    expect(email.messages).toEqual([]);
  });

  it('lets the server change a current owner\'s address at once, ending every session', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), changes = service();
    const applied = await changes.changeByOperator({ gymId: f.gymId, from: f.email.toUpperCase(), to: 'Recovered@Example.test', clock,
      authorize: (tx, userId) => assertOwnerRecovery(tx, f.gymId, userId) });
    expect(applied).toMatchObject({ userId: f.userId, to: 'recovered@example.test' });
    expect(await sessionsOf(f.userId)).toEqual([]);
    const [audit] = (await audits(f.gymId)).filter(row => row.action === 'auth.email_changed');
    expect(audit).toMatchObject({ actorKind: 'system', actorUserId: null, targetId: f.userId });
    // Only an owner: a coach's login is not moved.
    const coach = await factory('staffRoles', f.gymId, { role: 'coach' }), coachEmail = (await emailOf(coach.userId)).email;
    await expect(changes.changeByOperator({ gymId: f.gymId, from: coachEmail, to: 'coach-new@example.test', clock,
      authorize: (tx, userId) => assertOwnerRecovery(tx, f.gymId, userId) })).rejects.toMatchObject({ code: 'not_found' });
    expect((await emailOf(coach.userId)).email).toBe(coachEmail);
  });

  it('masks the new address for the notice', () => {
    expect(maskAddress('person@example.test')).toBe('p***@example.test');
    expect(maskAddress('broken')).toBe('***');
  });
});
