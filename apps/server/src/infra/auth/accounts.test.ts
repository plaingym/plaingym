// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, authAccount, authRateLimit, authSession, authUser, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { AppError } from '@plaingym/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { authConfig } from './config.js';
import { createAccountService, removeUnprovenPassword } from './accounts.js';
import { passwordAdapter } from './password.js';
import { normalizeAddress } from '../email/deliveries.js';
import { TestClock } from '../../core/clock.js';

const db = useTestDatabase(), factory = createFactories(db);
const secret = 'account-service-test-secret-at-least-32-characters';
const accounts = createAccountService(authConfig({ AUTH_SECRET: secret }, false), () => db.system.db);
const clock = new TestClock('2026-10-27T12:00:00Z');

it.each(['resetPassword', 'revokeAllSessions'] as const)('%s deletes only the current gym sessions on a system connection', async operation => {
  const gymA = uuidv7(), gymB = uuidv7();
  await factory('gyms', gymA); await factory('gyms', gymB);
  const user = await factory('authUser', gymA), other = await factory('authUser', gymA);
  const sessions = [
    await factory('authSession', gymA, { userId: user.id }),
    await factory('authSession', gymB, { userId: user.id }),
    await factory('authSession', gymA, { userId: other.id }),
  ];
  if (operation === 'resetPassword') await accounts.resetPassword({ gymId: gymA, userId: user.id, newPassword: 'replacement-password', clock, authorize: async () => {} });
  else await accounts.revokeAllSessions(gymA, user.id, clock);
  const remaining = await db.system.db.select({ id: authSession.id }).from(authSession).where(inArray(authSession.id, sessions.map(row => row.id)));
  expect(remaining.map(row => row.id).sort()).toEqual(sessions.slice(1).map(row => row.id).sort());
});

describe('removeUnprovenPassword', () => {
  it('removes the password and the gym sessions with one audit, and writes nothing for a login without one', async () => {
    const gymA = uuidv7(), gymB = uuidv7();
    await factory('gyms', gymA); await factory('gyms', gymB);
    const user = await factory('authUser', gymA), other = await factory('authUser', gymA), actor = await factory('authUser', gymA);
    await factory('authAccount', gymA, { userId: user.id, accountId: user.id, password: await passwordAdapter.hash('leftover-password-1') });
    await factory('authAccount', gymA, { userId: user.id, accountId: uuidv7(), providerId: 'google' });
    const sessions = [
      await factory('authSession', gymA, { userId: user.id }),
      await factory('authSession', gymB, { userId: user.id }),
      await factory('authSession', gymA, { userId: other.id }),
    ];
    // Passwords are visible only to the gym scope on the authentication connection.
    const remove = (userId: string) => accounts.forGym(gymA, tx => removeUnprovenPassword(tx, { gymId: gymA, userId, actorUserId: actor.id, clock }));
    expect(await remove(user.id)).toBe(true);
    const providers = await db.system.db.select({ providerId: authAccount.providerId }).from(authAccount).where(eq(authAccount.userId, user.id));
    expect(providers.map(row => row.providerId)).toEqual(['google']);
    const remaining = await db.system.db.select({ id: authSession.id }).from(authSession).where(inArray(authSession.id, sessions.map(row => row.id)));
    expect(remaining.map(row => row.id).sort()).toEqual(sessions.slice(1).map(row => row.id).sort());
    const audits = await db.forGym(gymA, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'auth.password_removed')));
    expect(audits).toMatchObject([{ actorKind: 'user', actorUserId: actor.id, targetType: 'user', targetId: user.id, before: null, after: null }]);
    expect(await remove(user.id)).toBe(false);
    expect(await remove(other.id)).toBe(false);
    expect(await db.forGym(gymA, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'auth.password_removed')))).toHaveLength(1);
    expect(await db.system.db.select({ id: authSession.id }).from(authSession).where(eq(authSession.userId, other.id))).toHaveLength(1);
  });
});

describe('changeOwnPassword', () => {
  const current = 'current-password-123', next = 'changed-password-456';
  let currentHash: string;
  beforeAll(async () => { currentHash = await passwordAdapter.hash(current); });
  /** A login with a password and three sessions in gym G. */
  async function login() {
    const gymId = uuidv7();
    await factory('gyms', gymId);
    const user = await factory('authUser', gymId);
    await factory('authAccount', gymId, { userId: user.id, accountId: user.id, password: currentHash });
    const sessions = [await factory('authSession', gymId, { userId: user.id }), await factory('authSession', gymId, { userId: user.id }),
      await factory('authSession', gymId, { userId: user.id })];
    return { gymId, user, sessions };
  }
  const change = (f: Awaited<ReturnType<typeof login>>, currentPassword: string, newPassword: string, service = accounts) =>
    service.changeOwnPassword({ gymId: f.gymId, userId: f.user.id, currentPassword, newPassword, keepSessionId: f.sessions[0]!.id, clock });
  const stored = async (userId: string) => (await db.system.db.select({ password: authAccount.password }).from(authAccount)
    .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential'))))[0]?.password ?? null;
  const verifies = async (userId: string, candidate: string) => passwordAdapter.verify({ hash: (await stored(userId))!, password: candidate });
  const sessionIds = async (f: Awaited<ReturnType<typeof login>>) => (await db.system.db.select({ id: authSession.id }).from(authSession)
    .where(inArray(authSession.id, f.sessions.map(row => row.id)))).map(row => row.id).sort();
  const audits = (gymId: string) => db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'auth.password_changed')));
  const windowCount = async (email: string) => {
    const key = `account|/sign-in/email|${createHash('sha256').update(normalizeAddress(email)).digest('base64url')}`;
    return (await db.system.db.select({ count: authRateLimit.count }).from(authRateLimit).where(eq(authRateLimit.key, key)))[0]?.count ?? 0;
  };
  const refusal = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a refusal'); }, (error: unknown) => error as AppError);

  it('changes the password, keeps the asking session, ends the others and audits without secrets', async () => {
    const f = await login(), before = (await stored(f.user.id))!;
    await change(f, current, next);
    expect(await verifies(f.user.id, next)).toBe(true);
    expect(await verifies(f.user.id, current)).toBe(false);
    expect(await sessionIds(f)).toEqual([f.sessions[0]!.id]);
    const rows = await audits(f.gymId);
    expect(rows.map(row => [row.actorKind, row.actorUserId, row.targetType, row.targetId])).toEqual([['user', f.user.id, 'user', f.user.id]]);
    const serialized = JSON.stringify(rows[0]);
    for (const secret of [current, next, before, (await stored(f.user.id))!]) expect(serialized).not.toContain(secret);
    expect(await windowCount(f.user.email)).toBe(0);
  });

  it('refuses a wrong current password, spending one account slot, and stops at the sign-in budget', async () => {
    const f = await login(), all = f.sessions.map(row => row.id).sort();
    const wrong = await refusal(change(f, 'not-the-password', next));
    expect([wrong.code, wrong.details]).toEqual(['invalid_request', { currentPassword: ['wrong_password'] }]);
    expect(await verifies(f.user.id, current)).toBe(true);
    expect(await sessionIds(f)).toEqual(all);
    expect(await audits(f.gymId)).toEqual([]);
    for (let attempt = 1; attempt < 10; attempt++) await refusal(change(f, 'not-the-password', next));
    expect(await windowCount(f.user.email)).toBe(10);
    expect((await refusal(change(f, current, next))).code).toBe('rate_limited');
    expect(await verifies(f.user.id, current)).toBe(true);
    expect(await sessionIds(f)).toEqual(all);
  });

  it('gives a successful change its slot back, leaving earlier wrong guesses counted', async () => {
    const f = await login();
    for (let attempt = 0; attempt < 3; attempt++) await refusal(change(f, 'not-the-password', next));
    await change(f, current, next);
    expect(await windowCount(f.user.email)).toBe(3);
  });

  it('refuses a new password of the wrong length, a login without a password, and a gym or install without password login', async () => {
    const f = await login();
    for (const length of [11, 129]) {
      const error = await refusal(change(f, current, 'x'.repeat(length)));
      expect([error.code, error.details]).toEqual(['invalid_request', { newPassword: ['length'] }]);
    }
    expect(await verifies(f.user.id, current)).toBe(true);
    const gymId = uuidv7();
    await factory('gyms', gymId);
    const linkOnly = await factory('authUser', gymId);
    const none = await refusal(accounts.changeOwnPassword({ gymId, userId: linkOnly.id, currentPassword: current, newPassword: next, keepSessionId: null, clock }));
    expect([none.code, none.details]).toEqual(['invalid_request', { currentPassword: ['no_password'] }]);
    expect(await audits(gymId)).toEqual([]);
    const off = createAccountService(authConfig({ AUTH_SECRET: secret, AUTH_PASSWORD_LOGIN: 'off' }, false), () => db.system.db);
    const multi = createAccountService({ ...authConfig({ AUTH_SECRET: secret }, false), tenancy: 'multi' }, () => db.system.db);
    for (const service of [off, multi]) expect((await refusal(change(f, current, next, service))).code).toBe('forbidden');
    expect(await verifies(f.user.id, current)).toBe(true);
    expect(await audits(f.gymId)).toEqual([]);
  });

  it('applies only one of two changes started together; the other conflicts', async () => {
    const f = await login();
    const results = await Promise.allSettled([change(f, current, 'first-new-password'), change(f, current, 'second-new-password')]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = results.find(result => result.status === 'rejected')!;
    expect((lost.reason as AppError).code).toBe('conflict');
    const winner = results[0]!.status === 'fulfilled' ? 'first-new-password' : 'second-new-password';
    expect(await verifies(f.user.id, winner)).toBe(true);
    expect(await audits(f.gymId)).toHaveLength(1);
    // Both gave the right current password, so neither keeps a slot.
    expect(await windowCount(f.user.email)).toBe(0);
  });
});

it('lists only the requested roles of the requested gym', async () => {
  const gymA = uuidv7(), gymB = uuidv7();
  await factory('gyms', gymA); await factory('gyms', gymB);
  const owner = await factory('staffRoles', gymA, { role: 'owner' }), admin = await factory('staffRoles', gymA, { role: 'admin' });
  await factory('staffRoles', gymA, { role: 'coach' }); await factory('staffRoles', gymB, { role: 'admin' });
  const expected = (await db.system.db.select({ email: authUser.email }).from(authUser).where(inArray(authUser.id, [owner.userId, admin.userId])))
    .map((row) => row.email).sort();
  expect((await accounts.staffEmails(gymA, ['owner', 'admin'])).sort()).toEqual(expected);
  expect(await accounts.staffEmails(gymA, [])).toEqual([]);
});

it("reads one staff user's login email only inside that user's gym", async () => {
  const gymA = uuidv7(), gymB = uuidv7();
  await factory('gyms', gymA); await factory('gyms', gymB);
  const owner = await factory('staffRoles', gymA, { role: 'owner' });
  const [user] = await db.system.db.select({ email: authUser.email }).from(authUser).where(eq(authUser.id, owner.userId));
  expect(await accounts.userEmail(gymA, owner.userId)).toBe(user!.email);
  expect(await accounts.userEmail(gymB, owner.userId)).toBeNull();
  expect(await accounts.userEmail(gymA, uuidv7())).toBeNull();
});
