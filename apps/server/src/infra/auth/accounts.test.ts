// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { authSession, authUser, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { inArray } from 'drizzle-orm';
import { authConfig } from './config.js';
import { createAccountService } from './accounts.js';
import { TestClock } from '../../core/clock.js';

const db = useTestDatabase(), factory = createFactories(db);
const accounts = createAccountService(authConfig({ AUTH_SECRET: 'account-service-test-secret-at-least-32-characters' }, false), () => db.system.db);
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
