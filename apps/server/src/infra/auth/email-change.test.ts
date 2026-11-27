// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { authAccount, authSession, authUser, authVerification, auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { TestClock } from '../../core/clock.js';
import { FakeEmail } from '../email/index.js';
import { assertOwnerRecovery } from '../../areas/staff/auth.reset.js';
import { reserveAccountAttempt, signInLimits } from './account-limit.js';
import { configureAccountLimitKey } from './account-limit-key.js';
import { passwordAdapter } from './password.js';
import { createEmailChangeService, emailChangeLifetimeMs, maskAddress, type EmailChangeMail, type EmailChangeService } from './email-change.js';

const db = useTestDatabase(), factory = createFactories(db), t = createTranslator(locales.en ?? {});
const password = 'email-change-password-123';
let hash: string;
beforeAll(async () => {
  // The server and the owner CLI configure the sign-in limit key through `authConfig`; this service is built without it.
  configureAccountLimitKey('email-change-test-secret-at-least-32-characters');
  hash = await passwordAdapter.hash(password);
});
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
const withPassword = (gymId: string, userId: string) => factory('authAccount', gymId, { userId, accountId: userId, password: hash });
const sessionsOf = (userId: string) => db.system.db.select({ id: authSession.id }).from(authSession).where(eq(authSession.userId, userId));
const emailOf = async (userId: string) => (await db.system.db.select().from(authUser).where(eq(authUser.id, userId)))[0]!;
const audits = (gymId: string) => db.forGym(gymId, tx => tx.select().from(auditEvents));
const changeRows = (gymId: string) => db.system.db.select().from(authVerification).where(like(authVerification.identifier, `email-change:${gymId}:%`));

type Ask = Omit<Parameters<EmailChangeService['request']>[0], 'passwordLogin'> & { passwordLogin?: boolean };
/** The fixture's logins have no password, so a request proves the login with a link to its current address. */
const ask = (changes: EmailChangeService, input: Ask) => changes.request({ passwordLogin: false, ...input });
/** Requests a change and opens the link sent to the current address, so the new address gets its own link or notice. */
async function requestLink(changes: EmailChangeService, email: FakeEmail, input: Ask) {
  const sent = await ask(changes, input);
  expect(sent.awaiting).toBe('current_address');
  const proved = await changes.confirm({ gymId: input.gymId, token: tokenOf(email.messages.at(-1)!), sessionUserId: null, clock: input.clock, mail: input.mail });
  expect(proved).toEqual({ status: 'sent', to: sent.email });
  return sent;
}

describe('sign-in email change', () => {
  it('applies only when the link sent to the new address is opened, then notifies the old address', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    await factory('authAccount', f.gymId, { userId: f.userId, providerId: 'google', accountId: 'google-' + uuidv7() });
    const sent = await requestLink(changes, email, { gymId: f.gymId, userId: f.userId, sessionId: f.current.id, newEmail: ' New.Owner@Example.test ', clock, mail });
    expect(sent).toMatchObject({ email: 'new.owner@example.test', from: f.email, expiresAt: new Date(clock.now().getTime() + emailChangeLifetimeMs).toISOString() });
    // Nothing changes on request: the login keeps its address, sessions and Google link.
    expect((await emailOf(f.userId)).email).toBe(f.email);
    expect(await sessionsOf(f.userId)).toHaveLength(2);
    expect(email.messages).toHaveLength(2);
    // The current address heard first, with the new address masked; the new address got its link after that one was opened.
    expect(email.messages[0]).toMatchObject({ to: f.email, subject: expect.stringContaining('Confirm it\'s you') });
    for (const content of [email.messages[0]!.text, email.messages[0]!.html]) {
      expect(content).toContain('n***@example.test');
      expect(content).not.toContain('new.owner@example.test');
    }
    expect(email.messages[1]).toMatchObject({ to: 'new.owner@example.test', subject: expect.stringContaining('Test Gym') });
    const link = new URL(/https?:\/\/\S+/.exec(email.messages[1]!.text)![0]);
    expect(link.origin + link.pathname).toBe('https://gym.example.test/account-email');
    // The row holds a hash under the gym's prefix, never the token.
    const rows = await db.system.db.select().from(authVerification);
    expect(rows.some(row => row.identifier.includes(link.hash.slice(1)) || row.value.includes(link.hash.slice(1)))).toBe(false);
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ email: f.email, googleLinked: true,
      pendingEmail: { email: 'new.owner@example.test', awaiting: 'new_address' } });

    const applied = await changes.confirm({ gymId: f.gymId, token: link.hash.slice(1), sessionUserId: null, clock, mail });
    expect(applied).toEqual({ status: 'changed', userId: f.userId, from: f.email, to: 'new.owner@example.test', googleUnlinked: true });
    expect(await emailOf(f.userId)).toMatchObject({ email: 'new.owner@example.test', emailVerified: true });
    // The requesting session stays; every other session of the login in the gym ends.
    expect((await sessionsOf(f.userId)).map(row => row.id)).toEqual([f.current.id]);
    expect(await db.system.db.select().from(authAccount).where(and(eq(authAccount.userId, f.userId), eq(authAccount.providerId, 'google')))).toEqual([]);
    expect(email.messages[2]).toMatchObject({ to: f.email, subject: expect.stringContaining('was changed') });
    expect(email.messages[2]!.text).toContain(maskAddress('new.owner@example.test'));
    expect(email.messages[2]!.text).not.toContain('new.owner@example.test');
    expect((await audits(f.gymId)).filter(row => row.action.startsWith('auth.email_change')).sort((a, b) => a.action < b.action ? -1 : 1).map(row => ({ action: row.action, actor: row.actorUserId, after: row.after })))
      .toEqual([{ action: 'auth.email_change_proved', actor: f.userId, after: null }, { action: 'auth.email_change_requested', actor: f.userId, after: null },
        { action: 'auth.email_changed', actor: f.userId, after: { googleUnlinked: true, sessionsEnded: 1 } }]);
    // One use only.
    await expect(changes.confirm({ gymId: f.gymId, token: link.hash.slice(1), sessionUserId: null, clock })).rejects.toMatchObject({ code: 'not_found' });
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ email: 'new.owner@example.test', googleLinked: false, pendingEmail: null });
  });

  it('refuses an expired link, a link from another gym, and another login\'s session', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    await requestLink(changes, email, { gymId: f.gymId, userId: f.userId, sessionId: f.current.id, newEmail: 'moved@example.test', clock, mail });
    const token = tokenOf(email.messages[1]!);
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
    expect(email.messages.map(message => message.to)).toEqual([f.email, 'moved@example.test']);
  });

  it('keeps the requested link usable if the old-address notice fails', async () => {
    // A login with a password proves itself with it, so the link goes to the new address at once beside the notice.
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    await withPassword(f.gymId, f.userId);
    const originalSend = email.sendEmail.bind(email);
    vi.spyOn(email, 'sendEmail').mockImplementation(async (message) => {
      if (message.to === f.email) throw new Error('old mailbox refused the notice');
      return originalSend(message);
    });
    await expect(changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'usable@example.test', clock, mail, passwordLogin: true, currentPassword: password }))
      .resolves.toMatchObject({ email: 'usable@example.test', awaiting: 'new_address' });
    await expect(changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[0]!), sessionUserId: null, clock }))
      .resolves.toMatchObject({ status: 'changed', to: 'usable@example.test' });
  });

  it('sends an in-use notice on request and still refuses an address taken before confirmation', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    const member = await factory('householdUsers', f.gymId), memberEmail = (await emailOf(member.userId)).email;
    await expect(requestLink(changes, email, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: memberEmail.toUpperCase(), clock, mail })).resolves.toMatchObject({ email: memberEmail });
    expect(email.messages[1]).toMatchObject({ to: memberEmail, text: expect.stringContaining('already has a login') });
    expect(email.messages[1]!.html).not.toContain('<a');
    expect(email.messages[1]!.text).not.toContain('/account-email');
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ pendingEmail: { email: memberEmail } });
    await expect(ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: f.email, clock, mail })).rejects.toMatchObject({ code: 'invalid_request' });
    await requestLink(changes, email, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'contested@example.test', clock, mail });
    // Another login takes the address before the link is opened.
    await factory('authUser', f.gymId, { email: 'contested@example.test' });
    await expect(changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[3]!), sessionUserId: null, clock })).rejects.toMatchObject({ code: 'conflict' });
    expect((await emailOf(f.userId)).email).toBe(f.email);
  });

  it('applies only one of two logins\' changes to the same address opened at once; the other is refused as in use', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    const member = await factory('householdUsers', f.gymId);
    await requestLink(changes, email, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'race@example.test', clock, mail });
    await requestLink(changes, email, { gymId: f.gymId, userId: member.userId, sessionId: null, newEmail: 'race@example.test', clock, mail });
    const results = await Promise.allSettled(email.messages.filter(message => message.to === 'race@example.test')
      .map(message => changes.confirm({ gymId: f.gymId, token: tokenOf(message), sessionUserId: null, clock })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason)).toEqual([expect.objectContaining({ code: 'conflict' })]);
    const winner = results[0]!.status === 'fulfilled' ? f.userId : member.userId;
    expect((await emailOf(winner)).email).toBe('race@example.test');
  });

  it('replaces an outstanding link when asked again, and withdraws a link whose email failed', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    await requestLink(changes, email, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'first@example.test', clock, mail });
    await requestLink(changes, email, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'second@example.test', clock, mail });
    await expect(changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[1]!), sessionUserId: null, clock })).rejects.toMatchObject({ code: 'not_found' });
    email.respondNext(new Error('smtp down'));
    await expect(ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'third@example.test', clock, mail })).rejects.toMatchObject({ code: 'unavailable' });
    // The failed request replaced the second link and was withdrawn itself, so nothing is pending.
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ pendingEmail: null });
    expect(await changeRows(f.gymId)).toEqual([]);
  });

  it('withdraws the new address\'s link when it could not be sent after the current address\'s link was opened', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    await ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'unsent@example.test', clock, mail });
    const proof = tokenOf(email.messages[0]!);
    // Unwired mail refuses before anything changes, and the link stays usable.
    await expect(changes.confirm({ gymId: f.gymId, token: proof, sessionUserId: null, clock })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ pendingEmail: { email: 'unsent@example.test', awaiting: 'current_address' } });
    email.respondNext(new Error('smtp down'));
    await expect(changes.confirm({ gymId: f.gymId, token: proof, sessionUserId: null, clock, mail })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ pendingEmail: null });
    expect(await changeRows(f.gymId)).toEqual([]);
    expect((await emailOf(f.userId)).email).toBe(f.email);
  });

  it('limits change requests per login', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { mail } = mailer(), changes = service('single', { window: 3600, max: 2 });
    for (const address of ['a@example.test', 'b@example.test'])
      await ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: address, clock, mail });
    await expect(ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'c@example.test', clock, mail })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('is refused in multi tenancy, where a login\'s address belongs to every gym it is in', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service('multi');
    await expect(ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'multi@example.test', clock, mail })).rejects.toMatchObject({ code: 'forbidden' });
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

describe('proving the login before an email change', () => {
  it('sends a passwordless login\'s first link to its current address, and the new address\'s link only once that one is opened', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    const sent = await ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: f.current.id, newEmail: 'proved@example.test', clock, mail });
    expect(sent).toMatchObject({ email: 'proved@example.test', awaiting: 'current_address' });
    // One email, to the current address, with the link; none to the new address and no separate request notice.
    expect(email.messages.map(message => message.to)).toEqual([f.email]);
    expect(email.messages[0]!.text).toContain('https://gym.example.test/account-email#');
    expect(email.messages[0]!.text).toContain('p***@example.test');
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ pendingEmail: { email: 'proved@example.test', awaiting: 'current_address' } });

    await expect(changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[0]!), sessionUserId: f.userId, clock, mail }))
      .resolves.toEqual({ status: 'sent', to: 'proved@example.test' });
    // The current address's link changes nothing; the new address now has its link.
    expect((await emailOf(f.userId)).email).toBe(f.email);
    expect(await sessionsOf(f.userId)).toHaveLength(2);
    expect(email.messages.filter(message => message.to === 'proved@example.test')).toHaveLength(1);
    expect(email.messages).toHaveLength(2);
    expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ pendingEmail: { email: 'proved@example.test', awaiting: 'new_address' } });
    expect((await audits(f.gymId)).filter(row => row.action === 'auth.email_change_proved')).toEqual([expect.objectContaining({ actorUserId: f.userId, targetId: f.userId })]);

    await expect(changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[1]!), sessionUserId: null, clock, mail }))
      .resolves.toMatchObject({ status: 'changed', to: 'proved@example.test' });
    expect((await emailOf(f.userId)).email).toBe('proved@example.test');
    // The session that asked survives; the link to the new address kept it.
    expect((await sessionsOf(f.userId)).map(row => row.id)).toEqual([f.current.id]);
  });

  it('uses the current address\'s link once, until it expires, never for another login, and replaces it when asked again', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    await ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'once@example.test', clock, mail });
    const first = tokenOf(email.messages[0]!);
    // Another login's session can't open it, and it stays usable.
    const stranger = await factory('householdUsers', f.gymId);
    await expect(changes.confirm({ gymId: f.gymId, token: first, sessionUserId: stranger.userId, clock, mail })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(changes.confirm({ gymId: f.gymId, token: first, sessionUserId: null, clock, mail })).resolves.toMatchObject({ status: 'sent' });
    await expect(changes.confirm({ gymId: f.gymId, token: first, sessionUserId: null, clock, mail })).rejects.toMatchObject({ code: 'not_found' });
    // The new address's link can't be opened by another login either.
    await expect(changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[1]!), sessionUserId: stranger.userId, clock, mail })).rejects.toMatchObject({ code: 'forbidden' });

    await ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'late@example.test', clock, mail });
    // Asking again replaced the new address's outstanding link.
    await expect(changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[1]!), sessionUserId: null, clock, mail })).rejects.toMatchObject({ code: 'not_found' });
    const late = tokenOf(email.messages.at(-1)!);
    clock.advance(61 * 60 * 1000);
    await expect(changes.confirm({ gymId: f.gymId, token: late, sessionUserId: null, clock, mail })).rejects.toMatchObject({ code: 'not_found' });

    await ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'replaced@example.test', clock, mail });
    const replaced = tokenOf(email.messages.at(-1)!);
    await ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'final@example.test', clock, mail });
    await expect(changes.confirm({ gymId: f.gymId, token: replaced, sessionUserId: null, clock, mail })).rejects.toMatchObject({ code: 'not_found' });
    expect((await emailOf(f.userId)).email).toBe(f.email);
  });

  it('answers an address another login uses like a free one at both steps, and sends it the in-use notice without a link', async () => {
    const f = await fixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
    const member = await factory('householdUsers', f.gymId), memberEmail = (await emailOf(member.userId)).email;
    const taken = await ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: memberEmail, clock, mail });
    const takenProved = await changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[0]!), sessionUserId: null, clock, mail });
    const free = await ask(changes, { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'free.step@example.test', clock, mail });
    const freeProved = await changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[2]!), sessionUserId: null, clock, mail });
    expect(taken).toEqual({ ...free, email: memberEmail });
    expect(takenProved).toEqual({ ...freeProved, to: memberEmail });
    expect(email.messages.map(message => message.to)).toEqual([f.email, memberEmail, f.email, 'free.step@example.test']);
    expect(email.messages[1]!.text).toContain('already has a login');
    expect(email.messages[1]!.html).not.toContain('<a');
    expect(email.messages[1]!.text).not.toMatch(/https?:\/\//);
    expect((await emailOf(member.userId)).email).toBe(memberEmail);
  });

  describe('a login with a password, where password sign-in is on', () => {
    const passwordFixture = async () => {
      const f = await fixture();
      await withPassword(f.gymId, f.userId);
      return f;
    };

    it('needs its current password, and a refused one records and sends nothing', async () => {
      const f = await passwordFixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer();
      // One change request an hour: a refused password must not spend it.
      const changes = service('single', { window: 3600, max: 1 });
      const input = { gymId: f.gymId, userId: f.userId, sessionId: f.current.id, newEmail: 'typed@example.test', clock, mail, passwordLogin: true };
      await expect(changes.request(input)).rejects.toMatchObject({ code: 'invalid_request', details: { currentPassword: ['required'] } });
      await expect(changes.request({ ...input, currentPassword: 'not-the-password' }))
        .rejects.toMatchObject({ code: 'invalid_request', details: { currentPassword: ['wrong_password'] } });
      expect(await changeRows(f.gymId)).toEqual([]);
      expect((await audits(f.gymId)).filter(row => row.action.startsWith('auth.email_change'))).toEqual([]);
      expect(email.messages).toEqual([]);

      const sent = await changes.request({ ...input, currentPassword: password });
      expect(sent).toMatchObject({ email: 'typed@example.test', awaiting: 'new_address' });
      // The link goes to the new address at once, and the current address gets the request notice, as without the proof step.
      expect(email.messages.map(message => message.to)).toEqual(['typed@example.test', f.email]);
      expect(email.messages[1]).toMatchObject({ subject: expect.stringContaining('was requested') });
      expect(await changes.summary(f.gymId, f.userId, clock)).toMatchObject({ pendingEmail: { email: 'typed@example.test', awaiting: 'new_address' } });
      await expect(changes.confirm({ gymId: f.gymId, token: tokenOf(email.messages[0]!), sessionUserId: f.userId, clock, mail }))
        .resolves.toMatchObject({ status: 'changed', to: 'typed@example.test' });
    });

    it('counts wrong passwords against password sign-in, and gives a right one\'s slot back', async () => {
      const f = await passwordFixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
      const input = { gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'budget@example.test', clock, mail, passwordLogin: true };
      // Right passwords give their slot back, so many of them never reach the limit.
      for (let index = 0; index < signInLimits.account.max + 1; index++)
        await changes.request({ ...input, currentPassword: password });
      for (let index = 0; index < signInLimits.account.max; index++)
        await expect(changes.request({ ...input, currentPassword: 'wrong-' + index })).rejects.toMatchObject({ details: { currentPassword: ['wrong_password'] } });
      await expect(changes.request({ ...input, currentPassword: password })).rejects.toMatchObject({ code: 'rate_limited' });
      const attempt = await reserveAccountAttempt(db.system.db, '/sign-in/email', f.email, signInLimits.account, Date.now());
      expect(attempt.reservation).toBeNull();
      expect(email.messages.filter(message => message.to === 'budget@example.test')).toHaveLength(signInLimits.account.max + 1);
    });

    it('proves the login with the current address instead where password sign-in is off, whatever the password field holds', async () => {
      const f = await passwordFixture(), clock = new TestClock('2026-11-12T10:00:00Z'), { email, mail } = mailer(), changes = service();
      for (const currentPassword of [undefined, 'not-the-password', password]) {
        const sent = await changes.request({ gymId: f.gymId, userId: f.userId, sessionId: null, newEmail: 'off@example.test', clock, mail, passwordLogin: false, currentPassword });
        expect(sent.awaiting).toBe('current_address');
        expect(email.messages.at(-1)).toMatchObject({ to: f.email, subject: expect.stringContaining('Confirm it\'s you') });
      }
      expect(email.messages.map(message => message.to)).toEqual([f.email, f.email, f.email]);
    });
  });
});
